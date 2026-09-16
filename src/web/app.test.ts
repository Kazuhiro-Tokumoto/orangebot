import { Secret, TOTP } from 'otpauth';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeAuthenticator } from '../__tests__/authenticator.js';
import type { LinkMessage, Notifier } from '../bot/notify.js';
import type { RpcClient } from '../wallet/rpc.js';
import { countUnused } from '../auth/recovery.js';
import { listSessions } from '../auth/session.js';
import { setPassword } from '../auth/credentials.js';
import { TOTP_PERIOD, generateSecret, loadSecret, storeSecret } from '../auth/totp.js';
import { openTestDatabase, type Database_ } from '../db/client.js';
import { getMemberByUsername, listAllMembers } from '../db/members.js';
import { loadEnv, type Env } from '../env.js';
import { balanceOf, mint } from '../domain/ledger.js';
import { createGenesisMember } from '../domain/members.js';
import { members } from '../db/schema.js';
import { createApp } from './app.js';

/**
 * 画面の通し確認。
 *
 * ポートを開けずに Hono の app.request() をそのまま叩く。
 * 登録 → ログイン → 提案 → 設定 まで、実際の HTML フォームと同じ形の POST で進める。
 */

const ORIGIN = 'http://localhost:3000';
const GENESIS_DISCORD_ID = '1529717434259345489';
const PASSWORD = 'tetsugaku-no-kane-88';

let handle: Database_;
let env: Env;
let app: ReturnType<typeof createApp>;
let notices: Notices;

/** Discord に送られたものを控えるだけの通知先。 */
interface Notices {
  readonly channel: string[];
  readonly direct: LinkMessage[];
  dmFails: boolean;
}

function recordingNotifier(into: Notices): Notifier {
  return {
    canDeliver: true,
    announce: (view) => {
      into.channel.push(`${view.status}:${view.summary}`);
    },
    deliverLink: (message) => {
      if (into.dmFails) return Promise.resolve({ ok: false, reason: 'DM を送れませんでした' });
      into.direct.push(message);
      return Promise.resolve({ ok: true });
    },
  };
}

function testEnv(): Env {
  return loadEnv({
    NODE_ENV: 'test',
    WEB_ORIGIN: ORIGIN,
    SESSION_SECRET: 'test-session-secret',
    APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  });
}

/** クッキーを持ち回るだけの、ごく小さな擬似ブラウザ。 */
class Client {
  private readonly jar = new Map<string, string>();

  private header(): Record<string, string> {
    if (this.jar.size === 0) return {};
    const pairs = [...this.jar].map(([name, value]) => `${name}=${value}`);
    return { cookie: pairs.join('; ') };
  }

  private absorb(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const index = pair?.indexOf('=') ?? -1;
      if (pair === undefined || index < 0) continue;
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (value === '') this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  async get(path: string): Promise<Response> {
    const res = await app.request(`${ORIGIN}${path}`, { headers: this.header() });
    this.absorb(res);
    return res;
  }

  /** パスキーの遣り取りだけは JSON で送る。 */
  async postJson(path: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await app.request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: { ...this.header(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    this.absorb(res);
    return (await res.json()) as Record<string, unknown>;
  }

  /** 素の HTML フォームと同じ送り方。Origin を付けないと CSRF 対策に弾かれる。 */
  async post(
    path: string,
    fields: Record<string, string>,
    options: { readonly origin?: string } = {},
  ): Promise<Response> {
    const res = await app.request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: {
        ...this.header(),
        'content-type': 'application/x-www-form-urlencoded',
        origin: options.origin ?? ORIGIN,
      },
      body: new URLSearchParams(fields).toString(),
    });
    this.absorb(res);
    return res;
  }
}

function codeFor(memberId: string): string {
  const stored = loadSecret(handle.db, memberId, env.encryptionKey);
  if (stored === undefined) throw new Error('二要素の秘密鍵がありません');
  return new TOTP({
    issuer: 'orangebot',
    label: 'x',
    algorithm: 'SHA1',
    digits: 6,
    period: TOTP_PERIOD,
    secret: Secret.fromBase32(stored.secret),
  }).generate();
}

function bootstrap(): string {
  const result = createGenesisMember(handle.db, {
    discordId: GENESIS_DISCORD_ID,
    username: 'kazuhiro-tokumoto',
    displayName: 'トクモト',
  });
  if (!result.ok) throw new Error(result.reason);
  return result.enrollToken;
}

/** 登録リンクからパスワードと二要素を設定し、有効なメンバーにする。 */
async function enroll(token: string, password = PASSWORD): Promise<void> {
  const client = new Client();

  const opened = await client.get(`/enroll?token=${token}`);
  expect(opened.status).toBe(200);
  expect(await opened.text()).toContain('パスワードを決める');

  const set = await client.post('/enroll/password', { token, password, confirm: password });
  expect(set.status).toBe(302);

  const totp = await client.get(`/enroll?token=${token}`);
  expect(await totp.text()).toContain('二要素認証を登録する');

  const confirmed = await client.post('/enroll/totp', {
    token,
    code: codeFor(GENESIS_DISCORD_ID),
  });
  expect(confirmed.status).toBe(302);

  const codes = await client.get(`/enroll?token=${token}`);
  expect(await codes.text()).toContain('リカバリコード');

  const done = await client.post('/enroll/finish', { token });
  expect(done.status).toBe(200);
}

/** パスワードと二要素を通したクライアントを返す。 */
async function signIn(password = PASSWORD): Promise<Client> {
  return signInAs('kazuhiro-tokumoto', GENESIS_DISCORD_ID, password);
}

async function signInAs(username: string, memberId: string, password = PASSWORD): Promise<Client> {
  const client = new Client();

  const first = await client.post('/login', { username, password });
  expect(first.status).toBe(302);
  expect(first.headers.get('location')).toBe('/login/totp');

  const second = await client.post('/login/totp', { code: codeFor(memberId) });
  expect(second.status).toBe(302);
  expect(second.headers.get('location')).toBe('/proposals');

  return client;
}

beforeEach(() => {
  handle = openTestDatabase();
  env = testEnv();
  notices = { channel: [], direct: [], dmFails: false };
  app = createApp({ db: handle.db, env, notify: recordingNotifier(notices) });
});

describe('登録', () => {
  it('リンクから 3 手順を踏むと有効なメンバーになる', async () => {
    const token = bootstrap();
    expect(getMemberByUsername(handle.db, 'kazuhiro-tokumoto')?.status).toBe('pending');

    await enroll(token);

    expect(getMemberByUsername(handle.db, 'kazuhiro-tokumoto')?.status).toBe('active');
    expect(countUnused(handle.db, GENESIS_DISCORD_ID)).toBe(10);
  });

  it('使い終わったリンクは二度目が開かない', async () => {
    const token = bootstrap();
    await enroll(token);

    const res = await new Client().get(`/enroll?token=${token}`);
    expect(res.status).toBe(400);
  });

  it('でたらめなリンクは開かない', async () => {
    bootstrap();
    const res = await new Client().get('/enroll?token=deadbeef');
    expect(res.status).toBe(400);
  });

  it('短すぎるパスワードは手順 1 で止まる', async () => {
    const token = bootstrap();
    const res = await new Client().post('/enroll/password', {
      token,
      password: 'short',
      confirm: 'short',
    });
    expect(res.status).toBe(400);
    expect(getMemberByUsername(handle.db, 'kazuhiro-tokumoto')?.status).toBe('pending');
  });
});

describe('ログイン', () => {
  beforeEach(async () => {
    await enroll(bootstrap());
  });

  it('パスワードと二要素の両方を通してはじめて提案画面に入れる', async () => {
    const client = await signIn();
    const res = await client.get('/proposals');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('新しい提案');
  });

  it('パスワードだけでは提案画面に入れない', async () => {
    const client = new Client();
    await client.post('/login', { username: 'kazuhiro-tokumoto', password: PASSWORD });

    const res = await client.get('/proposals');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login/totp');
  });

  it('符号が合わなければ引き上げられない', async () => {
    const client = new Client();
    await client.post('/login', { username: 'kazuhiro-tokumoto', password: PASSWORD });

    const res = await client.post('/login/totp', { code: '000000' });
    expect(res.status).toBe(401);
  });

  it('パスワードが違っても、利用者名の有無は文言から分からない', async () => {
    const client = new Client();
    const wrongPassword = await client.post('/login', {
      username: 'kazuhiro-tokumoto',
      password: 'machigatta-password-1',
    });
    const noSuchUser = await client.post('/login', {
      username: 'inai-hito',
      password: 'machigatta-password-1',
    });

    expect(wrongPassword.status).toBe(401);
    expect(noSuchUser.status).toBe(401);
    expect(await wrongPassword.text()).toBe(await noSuchUser.text());
  });

  it('ログアウトするとセッションが消える', async () => {
    const client = await signIn();
    const res = await client.post('/logout', {});
    expect(res.headers.get('location')).toBe('/status');
    expect(listSessions(handle.db, GENESIS_DISCORD_ID)).toHaveLength(0);

    const after = await client.get('/proposals');
    expect(after.headers.get('location')).toBe('/login');
  });
});

describe('提案', () => {
  beforeEach(async () => {
    await enroll(bootstrap());
  });

  it('1 人しかいないので、メンバー追加は出した時点で可決して実行される', async () => {
    const client = await signIn();
    const res = await client.post('/proposals/member-add', {
      discordId: '1700000000000000001',
      username: 'bravo',
      displayName: 'ブラボー',
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('可決して実行されました');
    expect(html).toContain('登録待ちのメンバー');

    const added = getMemberByUsername(handle.db, 'bravo');
    expect(added?.status).toBe('pending');
  });

  it('登録待ちのメンバーに渡すリンクを出せる', async () => {
    const client = await signIn();
    await client.post('/proposals/member-add', {
      discordId: '1700000000000000002',
      username: 'carol',
      displayName: 'キャロル',
    });

    const added = getMemberByUsername(handle.db, 'carol');
    expect(added).toBeDefined();

    const res = await client.post('/proposals/enroll-link', { memberId: added?.id ?? '' });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`${ORIGIN}/enroll?token=`);
  });

  it('自分宛の発行は提案できない', async () => {
    const client = await signIn();
    const res = await client.post('/proposals/mint', {
      subjectMemberId: GENESIS_DISCORD_ID,
      amount: '1000',
      memo: '自分に',
    });
    expect(res.status).toBe(400);
  });

  it('Discord ID が桁数を満たさない追加は弾かれる', async () => {
    const client = await signIn();
    const res = await client.post('/proposals/member-add', {
      discordId: '12345',
      username: 'dave',
      displayName: 'デイブ',
    });

    expect(res.status).toBe(400);
    expect(listAllMembers(handle.db)).toHaveLength(1);
  });

  it('ログインしていなければ提案画面には入れない', async () => {
    const res = await new Client().get('/proposals');
    expect(res.headers.get('location')).toBe('/login');
  });
});

describe('設定', () => {
  beforeEach(async () => {
    await enroll(bootstrap());
  });

  it('いまのパスワードを添えれば変更でき、新しいほうでログインできる', async () => {
    const client = await signIn();
    const next = 'atarashii-aikotoba-7';

    const res = await client.post('/settings/password', {
      current: PASSWORD,
      password: next,
      confirm: next,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('パスワードを変更しました');

    await signIn(next);
  });

  it('いまのパスワードが違えば変更されない', async () => {
    const client = await signIn();
    const res = await client.post('/settings/password', {
      current: 'chigau-password-9',
      password: 'atarashii-aikotoba-7',
      confirm: 'atarashii-aikotoba-7',
    });

    expect(res.status).toBe(400);
    await signIn(PASSWORD);
  });

  it('リカバリコードは発行し直すと入れ替わる', async () => {
    const client = await signIn();
    const res = await client.post('/settings/recovery', { current: PASSWORD });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('新しいリカバリコード');
    expect(countUnused(handle.db, GENESIS_DISCORD_ID)).toBe(10);
  });

  it('他の端末だけを締め出せる', async () => {
    const here = await signIn();
    await signIn();
    expect(listSessions(handle.db, GENESIS_DISCORD_ID)).toHaveLength(2);

    const res = await here.post('/settings/sessions', {});
    expect(res.status).toBe(200);
    expect(listSessions(handle.db, GENESIS_DISCORD_ID)).toHaveLength(1);

    // 自分は残っている。
    expect((await here.get('/settings')).status).toBe(200);
  });

  it('ログインしていなければ設定には入れない', async () => {
    const res = await new Client().get('/settings');
    expect(res.headers.get('location')).toBe('/login');
  });
});

describe('状態画面', () => {
  beforeEach(async () => {
    await enroll(bootstrap());
  });

  it('ログインなしで見られて、操作の入口は無い', async () => {
    const res = await new Client().get('/status');
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain('kazuhiro-tokumoto');
    expect(html).not.toContain('<form');
  });
});

describe('CSRF', () => {
  beforeEach(async () => {
    await enroll(bootstrap());
  });

  it('他所からのフォーム送信は通らない', async () => {
    const client = new Client();
    const res = await client.post(
      '/login',
      { username: 'kazuhiro-tokumoto', password: PASSWORD },
      { origin: 'https://example.com' },
    );

    expect(res.status).toBe(403);
    expect(listSessions(handle.db, GENESIS_DISCORD_ID)).toHaveLength(0);
  });
});

describe('パスキー', () => {
  beforeEach(async () => {
    await enroll(bootstrap());
  });

  /** 設定画面から登録して、その偽の認証器を返す。 */
  async function registerPasskey(client: Client): Promise<FakeAuthenticator> {
    const start = await client.postJson('/settings/passkeys/options', {});
    expect(start['ok']).toBe(true);

    const options = start['options'] as { challenge: string };
    const device = new FakeAuthenticator({
      rpId: env.rpId,
      origin: ORIGIN,
      userHandle: GENESIS_DISCORD_ID,
    });

    const done = await client.postJson('/settings/passkeys', {
      challengeId: start['challengeId'],
      nickname: 'この端末のテスト用パスキー',
      response: device.register(options.challenge),
    });
    expect(done['ok']).toBe(true);

    return device;
  }

  it('設定画面から登録すると一覧に出る', async () => {
    const client = await signIn();
    await registerPasskey(client);

    const res = await client.get('/settings');
    expect(await res.text()).toContain('この端末のテスト用パスキー');
  });

  it('登録したパスキーだけで、パスワードも符号も無しに入れる', async () => {
    const device = await registerPasskey(await signIn());

    const fresh = new Client();
    const start = await fresh.postJson('/login/passkey/options', {});
    const options = start['options'] as { challenge: string };

    const done = await fresh.postJson('/login/passkey', {
      challengeId: start['challengeId'],
      response: device.authenticate(options.challenge),
    });
    expect(done['ok']).toBe(true);
    expect(done['redirect']).toBe('/proposals');

    // 二要素まで通った扱いになるので、そのまま投票できる画面に入れる。
    const page = await fresh.get('/proposals');
    expect(page.status).toBe(200);
  });

  it('登録していない鍵では入れない', async () => {
    await registerPasskey(await signIn());
    const stranger = new FakeAuthenticator({ rpId: env.rpId, origin: ORIGIN });

    const fresh = new Client();
    const start = await fresh.postJson('/login/passkey/options', {});
    const options = start['options'] as { challenge: string };

    const done = await fresh.postJson('/login/passkey', {
      challengeId: start['challengeId'],
      response: stranger.authenticate(options.challenge),
    });
    expect(done['ok']).toBe(false);
    expect((await fresh.get('/proposals')).headers.get('location')).toBe('/login');
  });

  it('削除すると一覧から消える', async () => {
    const client = await signIn();
    const device = await registerPasskey(client);

    const res = await client.post('/settings/passkeys/delete', {
      passkeyId: device.credentialId.toString('base64url'),
    });
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain('パスキーを削除しました');
    expect(html).not.toContain('この端末のテスト用パスキー');
  });

  it('ログインしていなければ登録は始められない', async () => {
    const res = await new Client().postJson('/settings/passkeys/options', {});
    expect(res['ok']).not.toBe(true);
  });
});

describe('Discord への通知', () => {
  beforeEach(async () => {
    await enroll(bootstrap());
  });

  it('提案を出すとチャンネルに流れる', async () => {
    const client = await signIn();
    await client.post('/proposals/member-add', {
      discordId: '1700000000000000001',
      username: 'bravo',
      displayName: 'ブラボー',
    });

    // 有権者が 1 人なのでその場で可決し、決着として 1 度だけ流れる。
    expect(notices.channel).toHaveLength(1);
    expect(notices.channel[0]).toContain('executed:');
  });

  it('登録リンクは本人に DM される', async () => {
    const client = await signIn();
    await client.post('/proposals/member-add', {
      discordId: '1700000000000000002',
      username: 'carol',
      displayName: 'キャロル',
    });

    const added = getMemberByUsername(handle.db, 'carol');
    const res = await client.post('/proposals/enroll-link', { memberId: added?.id ?? '' });

    expect(notices.direct).toHaveLength(1);
    expect(notices.direct[0]?.discordId).toBe('1700000000000000002');
    expect(notices.direct[0]?.kind).toBe('enroll');
    expect(await res.text()).toContain('DM で送りました');
  });

  it('パスワード再発行の引換リンクは画面に出さず DM で送る', async () => {
    const res = await new Client().post('/forgot', { username: 'kazuhiro-tokumoto' });
    const html = await res.text();

    expect(notices.direct).toHaveLength(1);
    expect(notices.direct[0]?.kind).toBe('password_reset');
    expect(html).toContain('DM に送りました');
    expect(html).not.toContain('/reset?token=');
  });

  it('DM が送れないときだけ画面にリンクを出す', async () => {
    notices.dmFails = true;
    const res = await new Client().post('/forgot', { username: 'kazuhiro-tokumoto' });

    expect(await res.text()).toContain('/reset?token=');
  });

  it('知らない利用者名では何も送らない', async () => {
    const res = await new Client().post('/forgot', { username: 'inai-hito' });

    expect(res.status).toBe(200);
    expect(notices.direct).toHaveLength(0);
    expect(notices.channel).toHaveLength(0);
  });
});

describe('ウォレット', () => {
  const PASSPHRASE = 'kagi-no-aikotoba-123';

  /** 残高を決め打ちで返すノード。 */
  function fakeNode(total: bigint, truncated = false): RpcClient {
    return {
      call: () => Promise.reject(new Error('使いません')),
      getInfo: () =>
        Promise.resolve({ network: 'mainnet', height: 128, bestHash: 'aa', difficulty: '1000' }),
      getBlockCount: () => Promise.resolve(128),
      scanUtxos: () => Promise.resolve({ utxos: [], total, truncated }),
      sendRawTransaction: () => Promise.resolve('txid'),
    };
  }

  function withNode(node: RpcClient | undefined): void {
    app = createApp({ db: handle.db, env, notify: recordingNotifier(notices), rpc: node });
  }

  beforeEach(async () => {
    await enroll(bootstrap());
  });

  it('ログインしていなければ入れない', async () => {
    const res = await new Client().get('/wallet');
    expect(res.headers.get('location')).toBe('/login');
  });

  it('作る前は作成の画面が出る', async () => {
    const client = await signIn();
    const res = await client.get('/wallet');

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('ウォレットを作る');
  });

  it('作ると 12 語の控えが一度だけ出る', async () => {
    const client = await signIn();
    const res = await client.post('/wallet/create', {
      passphrase: PASSPHRASE,
      confirm: PASSPHRASE,
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('12 語の控え');
    expect(html).toContain('12.');

    // 二度目は開いても出てこない。
    const again = await client.get('/wallet');
    const page = await again.text();
    expect(page).not.toContain('紙に書き写して');
    expect(page).toContain('受取住所');
  });

  it('パスフレーズが一致しなければ作らない', async () => {
    const client = await signIn();
    const res = await client.post('/wallet/create', {
      passphrase: PASSPHRASE,
      confirm: 'chigau-aikotoba-999',
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain('ウォレットを作る');
  });

  it('二つ目は作れない', async () => {
    const client = await signIn();
    await client.post('/wallet/create', { passphrase: PASSPHRASE, confirm: PASSPHRASE });

    const again = await client.post('/wallet/create', {
      passphrase: PASSPHRASE,
      confirm: PASSPHRASE,
    });
    expect(again.status).toBe(400);
  });

  it('受取住所を配ると一覧に出る', async () => {
    const client = await signIn();
    await client.post('/wallet/create', { passphrase: PASSPHRASE, confirm: PASSPHRASE });

    const res = await client.post('/wallet/address', {});
    const html = await res.text();

    expect(html).toContain('新しい受取住所を出しました');
    expect(html).toMatch(/oag1[a-z0-9]{10,}/);
  });

  it('ノードに繋がれば残高と高さを出す', async () => {
    const client = await signIn();
    await client.post('/wallet/create', { passphrase: PASSPHRASE, confirm: PASSPHRASE });

    withNode(fakeNode(25n * 10n ** 15n));
    const html = await (await client.get('/wallet')).text();

    expect(html).toContain('2.5');
    expect(html).toContain('128');
  });

  it('打ち切られた応答は残高として出さない', async () => {
    const client = await signIn();
    await client.post('/wallet/create', { passphrase: PASSPHRASE, confirm: PASSPHRASE });

    withNode(fakeNode(1n, true));
    const html = await (await client.get('/wallet')).text();

    expect(html).toContain('打ち切');
  });

  it('ノードが無くても画面は出る', async () => {
    const client = await signIn();
    await client.post('/wallet/create', { passphrase: PASSPHRASE, confirm: PASSPHRASE });

    const res = await client.get('/wallet');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('ノードに繋がりません');
  });

  it('状態画面にも OAG の残高が出る', async () => {
    const client = await signIn();
    await client.post('/wallet/create', { passphrase: PASSPHRASE, confirm: PASSPHRASE });

    withNode(fakeNode(7n * 10n ** 16n));
    const html = await (await new Client().get('/status')).text();

    expect(html).toContain('OAG の残高');
    expect(html).toContain('7');
  });
});

describe('タイムライン', () => {
  const BRAVO_ID = '1700000000000000001';

  /** 2 人目のメンバーを、登録を済ませた状態で直に置く。 */
  async function addBravo(): Promise<void> {
    handle.db
      .insert(members)
      .values({
        id: BRAVO_ID,
        username: 'bravo',
        displayName: 'ブラボー',
        status: 'active',
        createdAt: Date.now(),
        activatedAt: Date.now(),
      })
      .run();
    const set = await setPassword(handle.db, { memberId: BRAVO_ID, password: PASSWORD });
    expect(set.ok).toBe(true);
    storeSecret(handle.db, {
      memberId: BRAVO_ID,
      secret: generateSecret(),
      key: env.encryptionKey,
      confirmed: true,
    });
  }

  /** タイムラインに投稿して、その投稿の ID を返す。 */
  async function postAs(client: Client, body: string): Promise<string> {
    const res = await client.post('/timeline', { body });
    expect(res.headers.get('location')).toBe('/timeline?done=posted');

    const html = await (await client.get('/timeline')).text();
    const id = /href="\/posts\/([0-9a-f-]{36})"/.exec(html)?.[1];
    if (id === undefined) throw new Error('投稿が見つかりません');
    return id;
  }

  beforeEach(async () => {
    await enroll(bootstrap());
  });

  it('ログインしていなければ読めない', async () => {
    const res = await new Client().get('/timeline');
    expect(res.headers.get('location')).toBe('/login');
  });

  it('投稿すると時系列に出る', async () => {
    const client = await signIn();
    await postAs(client, '最初の投稿です');

    const html = await (await client.get('/timeline?done=posted')).text();
    expect(html).toContain('最初の投稿です');
    expect(html).toContain('投稿しました');
  });

  it('本文は HTML として解釈されない', async () => {
    const client = await signIn();
    await postAs(client, '<script>alert(1)</script>');

    const html = await (await client.get('/timeline')).text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('空の投稿は断る', async () => {
    const client = await signIn();
    const res = await client.post('/timeline', { body: '   ' });
    expect(res.status).toBe(400);
  });

  it('返信するとスレッドに並ぶ', async () => {
    const client = await signIn();
    const root = await postAs(client, 'スレッドの先頭');

    const res = await client.post(`/posts/${root}/reply`, { parentId: root, body: '返信です' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')?.startsWith(`/posts/${root}?done=replied#`)).toBe(true);

    const thread = await (await client.get(`/posts/${root}`)).text();
    expect(thread).toContain('スレッドの先頭');
    expect(thread).toContain('返信です');
  });

  it('別のスレッドの投稿を返信先に指されても断る', async () => {
    const client = await signIn();
    const first = await postAs(client, 'ひとつ目');
    const second = await postAs(client, 'ふたつ目');

    const res = await client.post(`/posts/${first}/reply`, { parentId: second, body: 'まぎれ込み' });
    expect(res.status).toBe(400);
  });

  it('他人の投稿に BOAG を投げると残高が動く', async () => {
    await addBravo();
    const author = await signIn();
    const root = await postAs(author, 'いい話をします');

    mint(handle.db, { to: BRAVO_ID, amount: 50n, ref: 'test' });
    const bravo = await signInAs('bravo', BRAVO_ID);

    const res = await bravo.post(`/posts/${root}/tip`, { amount: '20' });
    expect(res.headers.get('location')).toBe(`/posts/${root}?done=tipped#${root}`);
    expect(balanceOf(handle.db, BRAVO_ID)).toBe(30n);
    expect(balanceOf(handle.db, GENESIS_DISCORD_ID)).toBe(20n);

    const thread = await (await bravo.get(`/posts/${root}`)).text();
    expect(thread).toContain('投げ銭 20 BOAG');
  });

  it('残高を超える投げ銭は断る', async () => {
    await addBravo();
    const author = await signIn();
    const root = await postAs(author, 'いい話をします');

    const bravo = await signInAs('bravo', BRAVO_ID);
    const res = await bravo.post(`/posts/${root}/tip`, { amount: '1' });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain('残高が足りません');
  });

  it('自分の投稿には投げ銭の欄が出ない', async () => {
    const client = await signIn();
    const root = await postAs(client, '自分の');

    const thread = await (await client.get(`/posts/${root}`)).text();
    expect(thread).not.toContain('BOAG を投げる');
    expect(thread).toContain('消す');
  });

  it('自分の投稿は消せるが、他人のものは消せない', async () => {
    await addBravo();
    const author = await signIn();
    const root = await postAs(author, '消されるかもしれない');

    const bravo = await signInAs('bravo', BRAVO_ID);
    const denied = await bravo.post(`/posts/${root}/delete`, {});
    expect(denied.status).toBe(400);

    const allowed = await author.post(`/posts/${root}/delete`, {});
    expect(allowed.headers.get('location')).toBe(`/posts/${root}?done=deleted`);

    const thread = await (await author.get(`/posts/${root}`)).text();
    expect(thread).toContain('この投稿は消されました');
    expect(thread).not.toContain('消されるかもしれない');
  });

  it('無い投稿は 404', async () => {
    const client = await signIn();
    const res = await client.get('/posts/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });
});
