import { schnorr } from '@noble/curves/secp256k1.js';
import { Secret, TOTP } from 'otpauth';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeAuthenticator } from '../__tests__/authenticator.js';
import type { LinkMessage, Notifier } from '../bot/notify.js';
import { ROUND_MS, bettableStart, settleRound, roundId } from '../domain/prediction.js';
import { GAME_ROUND_MS, gameBettableStart, gameRoundId, settleGameRound } from '../domain/games.js';
import { getMarket, listMarkets } from '../domain/markets.js';
import { markets } from '../db/schema.js';
import { parseJstDateTime } from './routes/markets.js';
import { sign } from '../exchange/signature.js';
import type { PriceSource } from '../market/price.js';
import { encodeAddress } from '../wallet/address.js';
import type { RpcClient } from '../wallet/rpc.js';
import { countUnused } from '../auth/recovery.js';
import { listSessions } from '../auth/session.js';
import { setPassword } from '../auth/credentials.js';
import { TOTP_PERIOD, generateSecret, loadSecret, storeSecret } from '../auth/totp.js';
import { openTestDatabase, type Database_ } from '../db/client.js';
import { getMemberByUsername, listAllMembers, setMemberStatus } from '../db/members.js';
import { loadEnv, type Env } from '../env.js';
import { balanceOf, mint } from '../domain/ledger.js';
import { SOAG_PER_BOAG } from '../domain/units.js';
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
      getMempool: () => Promise.resolve([]),
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

    mint(handle.db, { to: BRAVO_ID, amount: 50n * SOAG_PER_BOAG, ref: 'test' });
    const bravo = await signInAs('bravo', BRAVO_ID);

    const res = await bravo.post(`/posts/${root}/tip`, { amount: '20' });
    expect(res.headers.get('location')).toBe(`/posts/${root}?done=tipped#${root}`);
    expect(balanceOf(handle.db, BRAVO_ID)).toBe(30n * SOAG_PER_BOAG);
    expect(balanceOf(handle.db, GENESIS_DISCORD_ID)).toBe(20n * SOAG_PER_BOAG);

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

describe('BOAG のやりとりの画面', () => {
  const BRAVO_ID = '1700000000000000002';

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

  beforeEach(async () => {
    await enroll(bootstrap());
    await addBravo();
  });

  it('ログインしていなければ開けない', async () => {
    const res = await new Client().get('/boag');
    expect(res.headers.get('location')).toBe('/login');
  });

  it('送ると双方の残高が動く', async () => {
    mint(handle.db, { to: GENESIS_DISCORD_ID, amount: 50n * SOAG_PER_BOAG, ref: 'test' });
    const client = await signIn();

    const res = await client.post('/boag/send', {
      toMemberId: BRAVO_ID,
      amount: '12.5',
      memo: 'このあいだのぶん',
    });
    expect(res.headers.get('location')).toBe('/boag?done=sent');

    expect(balanceOf(handle.db, GENESIS_DISCORD_ID)).toBe((75n * SOAG_PER_BOAG) / 2n);
    expect(balanceOf(handle.db, BRAVO_ID)).toBe((25n * SOAG_PER_BOAG) / 2n);

    const html = await (await client.get('/boag?done=sent')).text();
    expect(html).toContain('送りました');
    expect(html).toContain('このあいだのぶん');
    expect(html).toContain('ブラボー');

    // 受け取った側にも同じ動きが出る。
    const bravo = await signInAs('bravo', BRAVO_ID);
    const received = await (await bravo.get('/boag')).text();
    expect(received).toContain('受け取り');
    expect(received).toContain('12.5');
  });

  it('残高を超えては送れない', async () => {
    const client = await signIn();
    const res = await client.post('/boag/send', { toMemberId: BRAVO_ID, amount: '1' });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain('残高が足りません');
    expect(balanceOf(handle.db, BRAVO_ID)).toBe(0n);
  });

  it('自分は宛先に出ず、直に指されても断る', async () => {
    mint(handle.db, { to: GENESIS_DISCORD_ID, amount: SOAG_PER_BOAG, ref: 'test' });
    const client = await signIn();

    const html = await (await client.get('/boag')).text();
    expect(html).not.toContain(`value="${GENESIS_DISCORD_ID}"`);

    const res = await client.post('/boag/send', { toMemberId: GENESIS_DISCORD_ID, amount: '1' });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('自分には送れません');
  });

  it('有効でないメンバーには送れない', async () => {
    mint(handle.db, { to: GENESIS_DISCORD_ID, amount: SOAG_PER_BOAG, ref: 'test' });
    setMemberStatus(handle.db, BRAVO_ID, 'suspended', Date.now());

    const client = await signIn();
    const res = await client.post('/boag/send', { toMemberId: BRAVO_ID, amount: '1' });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('受け取れない');
  });
});

describe('OAG の送金の画面', () => {
  const WALLET_PASSPHRASE = 'kagi-no-aikotoba-123';
  /** 既定のネットワーク (mainnet) の、よそ者の住所。 */
  const DEST = encodeAddress('mainnet', schnorr.getPublicKey(new Uint8Array(32).fill(7)));

  beforeEach(async () => {
    await enroll(bootstrap());
  });

  async function withWallet(): Promise<Client> {
    const client = await signIn();
    await client.post('/wallet/create', { passphrase: WALLET_PASSPHRASE, confirm: WALLET_PASSPHRASE });
    return client;
  }

  it('送金を提案すると、1 人なら可決して送る欄が出る', async () => {
    const client = await withWallet();
    const res = await client.post('/wallet/propose', { to: DEST, amount: '1.5', memo: '試験' });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('可決しました');
    expect(html).toContain('署名して送る');
    expect(html).toContain('1.5 OAG');
    expect(notices.channel.some((line) => line.includes('OAG の送金'))).toBe(true);
  });

  it('読めない住所では提案できない', async () => {
    const client = await withWallet();
    const res = await client.post('/wallet/propose', { to: 'dame', amount: '1' });
    expect(res.status).toBe(400);
  });

  it('ノードが無ければ、送ろうとしても理由を出して断る', async () => {
    const client = await withWallet();
    const proposed = await client.post('/wallet/propose', { to: DEST, amount: '1' });
    const id = /action="\/wallet\/send\/([0-9a-f-]{36})"/.exec(await proposed.text())?.[1];
    expect(id).toBeDefined();

    const res = await client.post(`/wallet/send/${id ?? ''}`, { passphrase: WALLET_PASSPHRASE });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('ノードの設定がありません');
  });
});

describe('値動きの予想の画面', () => {
  const prices: PriceSource = {
    candle: () => Promise.resolve(undefined),
    ticker: (symbol) => Promise.resolve({ symbol, price: '64000.12' }),
  };

  beforeEach(async () => {
    await enroll(bootstrap());
    app = createApp({ db: handle.db, env, notify: recordingNotifier(notices), prices });
    mint(handle.db, { to: GENESIS_DISCORD_ID, amount: 100n * SOAG_PER_BOAG, ref: 'test' });
  });

  it('ログインしていなければ入れない', async () => {
    const res = await new Client().get('/predict');
    expect(res.headers.get('location')).toBe('/login');
  });

  it('いまの値段と次の回が出る', async () => {
    const client = await signIn();
    const html = await (await client.get('/predict?symbol=ETHUSDT')).text();

    expect(html).toContain('64000.12');
    expect(html).toContain('次の回');
    expect(html).toContain('value="ETHUSDT"');
  });

  it('賭けると残高が減り、画面に自分の賭けが出る', async () => {
    const client = await signIn();
    const page = await (await client.get('/predict')).text();
    const startsAt = /name="startsAt" value="(\d+)"/.exec(page)?.[1] ?? '';

    const res = await client.post('/predict/bet', {
      symbol: 'BTCUSDT',
      startsAt,
      amount: '2.5',
      side: 'up',
    });
    expect(res.headers.get('location')).toBe('/predict?symbol=BTCUSDT&done=bet');
    expect(balanceOf(handle.db, GENESIS_DISCORD_ID)).toBe(975n * SOAG_PER_BOAG / 10n);

    const after = await (await client.get('/predict?symbol=BTCUSDT&done=bet')).text();
    expect(after).toContain('賭けました');
    expect(after).toContain('2.5 BOAG 賭けています');
  });

  it('締め切られた回には賭けられない', async () => {
    const client = await signIn();
    const res = await client.post('/predict/bet', {
      symbol: 'BTCUSDT',
      startsAt: String(bettableStart(Date.now()) - ROUND_MS),
      amount: '1',
      side: 'down',
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('締め切られました');
  });

  it('決着した回は履歴に結果が出る', async () => {
    const client = await signIn();
    const now = Date.now();
    const startsAt = bettableStart(now);
    await client.post('/predict/bet', { symbol: 'BTCUSDT', startsAt: String(startsAt), amount: '1', side: 'up' });

    // 片側だけなので返金になる。決着の時刻まで進めたことにする。
    settleRound(handle.db, {
      roundId: roundId('BTCUSDT', startsAt),
      candle: { openTime: startsAt, closeTime: startsAt + ROUND_MS - 1, open: '1', high: '2', low: '1', close: '2' },
      now: startsAt + ROUND_MS + 60_000,
    });

    const html = await (await client.get('/predict')).text();
    expect(html).toContain('これまでの回');
    expect(balanceOf(handle.db, GENESIS_DISCORD_ID)).toBe(100n * SOAG_PER_BOAG);
  });
});

describe('交換の API', () => {
  const SECRET = 'exchange-test-secret-0123456789abcdef';

  function exchangeEnv(partnerUrl?: string): Env {
    return loadEnv({
      NODE_ENV: 'test',
      WEB_ORIGIN: ORIGIN,
      SESSION_SECRET: 'test-session-secret',
      APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      EXCHANGE_SECRET: SECRET,
      ...(partnerUrl === undefined ? {} : { EXCHANGE_PARTNER_URL: partnerUrl }),
    });
  }

  /** 相手の bot になりすまして、署名つきで呼ぶ。 */
  async function call(
    method: 'GET' | 'POST',
    path: string,
    body = '',
    options: { readonly direction?: 'to-orangebot' | 'from-orangebot'; readonly secret?: string } = {},
  ) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(options.secret ?? SECRET, {
      direction: options.direction ?? 'to-orangebot',
      method,
      path,
      timestamp,
      body,
    });
    const res = await app.request(`${ORIGIN}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-exchange-timestamp': timestamp,
        'x-exchange-signature': signature,
      },
      ...(method === 'POST' ? { body } : {}),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  function depositBody(id: string, pt: string, discordId = GENESIS_DISCORD_ID): string {
    return JSON.stringify({ id, discordId, pt });
  }

  beforeEach(async () => {
    await enroll(bootstrap());
    env = exchangeEnv();
    app = createApp({ db: handle.db, env, notify: recordingNotifier(notices) });
  });

  it('署名つきの入金で BOAG が付き、同じ id の二度目は付かない', async () => {
    const first = await call('POST', '/api/orangebot-boag-pt-exchange/v1/deposits', depositBody('oogiri-1', '25000000'));
    expect(first.status).toBe(201);
    expect(first.json['deposit']).toMatchObject({ pt: '25000000', boag: '2.5', discordId: GENESIS_DISCORD_ID });

    const again = await call('POST', '/api/orangebot-boag-pt-exchange/v1/deposits', depositBody('oogiri-1', '25000000'));
    expect(again.status).toBe(200);
    expect(again.json['replayed']).toBe(true);
    expect(balanceOf(handle.db, GENESIS_DISCORD_ID)).toBe(25n * SOAG_PER_BOAG / 10n);

    const lookup = await call('GET', '/api/orangebot-boag-pt-exchange/v1/deposits/oogiri-1');
    expect(lookup.status).toBe(200);
  });

  it('署名が無い、秘密が違う、向きが違う要求は断る', async () => {
    const body = depositBody('oogiri-2', '10000000');

    const unsigned = await app.request(`${ORIGIN}/api/orangebot-boag-pt-exchange/v1/deposits`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(unsigned.status).toBe(401);

    expect((await call('POST', '/api/orangebot-boag-pt-exchange/v1/deposits', body, { secret: 'x'.repeat(40) })).status).toBe(401);
    // こちらが相手へ送った出金の要求を、そのまま投げ返されたときの形。
    expect((await call('POST', '/api/orangebot-boag-pt-exchange/v1/deposits', body, { direction: 'from-orangebot' })).status).toBe(401);
    expect(balanceOf(handle.db, GENESIS_DISCORD_ID)).toBe(0n);
  });

  it('誤りは決まった形の JSON で返す', async () => {
    const unknown = await call(
      'POST',
      '/api/orangebot-boag-pt-exchange/v1/deposits',
      depositBody('oogiri-3', '1', '1700000000000000009'),
    );
    expect(unknown.status).toBe(404);
    expect(unknown.json['error']).toMatchObject({ code: 'member_not_found' });

    const bad = await call('POST', '/api/orangebot-boag-pt-exchange/v1/deposits', '{"id":"x","pt":1}');
    expect(bad.status).toBe(400);
    expect(bad.json['error']).toMatchObject({ code: 'invalid_request' });

    const conflict = await call('POST', '/api/orangebot-boag-pt-exchange/v1/deposits', depositBody('oogiri-4', '1'));
    expect(conflict.status).toBe(201);
    const second = await call('POST', '/api/orangebot-boag-pt-exchange/v1/deposits', depositBody('oogiri-4', '2'));
    expect(second.status).toBe(409);
  });

  it('宛先の確認と換算の比', async () => {
    expect((await call('GET', `/api/orangebot-boag-pt-exchange/v1/members/${GENESIS_DISCORD_ID}`)).status).toBe(200);
    expect((await call('GET', '/api/orangebot-boag-pt-exchange/v1/members/1700000000000000009')).status).toBe(404);

    const rate = await call('GET', '/api/orangebot-boag-pt-exchange/v1/rate');
    expect(rate.json).toEqual({ ptPerBoag: '10000000', soagPerPt: '1000000000', decimals: 16 });
  });

  it('交換を止めていれば 503', async () => {
    env = testEnv();
    app = createApp({ db: handle.db, env });
    expect((await call('GET', '/api/orangebot-boag-pt-exchange/v1/rate')).status).toBe(503);
  });

  it('画面から pt に換えると残高が引かれ、出金の記録ができる', async () => {
    env = exchangeEnv('https://partner.example/api/orangebot-boag-pt-exchange/v1/pt-deposits');
    let requested = 0;
    app = createApp({
      db: handle.db,
      env,
      onWithdrawalRequested: () => {
        requested += 1;
      },
    });
    mint(handle.db, { to: GENESIS_DISCORD_ID, amount: 5n * SOAG_PER_BOAG, ref: 'test' });

    const client = await signIn();
    const res = await client.post('/exchange/withdraw', { pt: '20000000' });
    expect(res.headers.get('location')).toBe('/exchange?done=requested');
    expect(requested).toBe(1);
    expect(balanceOf(handle.db, GENESIS_DISCORD_ID)).toBe(3n * SOAG_PER_BOAG);

    const page = await (await client.get('/exchange?done=requested')).text();
    expect(page).toContain('送っています');
    expect(page).toContain('20,000,000');
  });

  it('相手の受け口が無ければ、画面から pt には換えられない', async () => {
    mint(handle.db, { to: GENESIS_DISCORD_ID, amount: 5n * SOAG_PER_BOAG, ref: 'test' });
    const client = await signIn();
    const res = await client.post('/exchange/withdraw', { pt: '1' });
    expect(res.status).toBe(400);
    expect(balanceOf(handle.db, GENESIS_DISCORD_ID)).toBe(5n * SOAG_PER_BOAG);
  });
});

describe('終値予想と順位予想の画面', () => {
  const prices: PriceSource = {
    candle: () => Promise.resolve(undefined),
    ticker: (symbol) => Promise.resolve({ symbol, price: symbol === 'BTCUSDT' ? '64000.12' : '3.5' }),
  };

  beforeEach(async () => {
    await enroll(bootstrap());
    app = createApp({ db: handle.db, env, notify: recordingNotifier(notices), prices });
    mint(handle.db, { to: GENESIS_DISCORD_ID, amount: 100n * SOAG_PER_BOAG, ref: 'test' });
  });

  it('ログインしていなければ入れない', async () => {
    for (const path of ['/predict/closest', '/predict/ranking', '/predict/volatility', '/predict/markets']) {
      expect((await new Client().get(path)).headers.get('location')).toBe('/login');
    }
  });

  it('終値を予想すると残高が減り、自分の予想が出る。2 つ目は断る', async () => {
    const client = await signIn();
    const page = await (await client.get('/predict/closest')).text();
    expect(page).toContain('64000.12');
    expect(page).toContain('終値予想 (1 時間)');
    const startsAt = /name="startsAt" value="(\d+)"/.exec(page)?.[1] ?? '';

    const res = await client.post('/predict/closest/enter', {
      symbol: 'BTCUSDT',
      startsAt,
      price: '64123.45',
      amount: '3',
    });
    expect(res.headers.get('location')).toBe('/predict/closest?symbol=BTCUSDT&done=entered');
    expect(balanceOf(handle.db, GENESIS_DISCORD_ID)).toBe(97n * SOAG_PER_BOAG);

    const after = await (await client.get('/predict/closest?symbol=BTCUSDT&done=entered')).text();
    expect(after).toContain('64123.45');
    expect(after).not.toContain('action="/predict/closest/enter"');

    const again = await client.post('/predict/closest/enter', {
      symbol: 'BTCUSDT',
      startsAt,
      price: '1',
      amount: '1',
    });
    expect(again.status).toBe(400);
    expect(balanceOf(handle.db, GENESIS_DISCORD_ID)).toBe(97n * SOAG_PER_BOAG);
  });

  it('順位予想に賭けられ、決着すると履歴に伸びが出る', async () => {
    const client = await signIn();
    const page = await (await client.get('/predict/ranking')).text();
    expect(page).toContain('SOLUSDT');
    const startsAt = Number(/name="startsAt" value="(\d+)"/.exec(page)?.[1] ?? '0');
    expect(startsAt).toBe(gameBettableStart(Date.now()));

    const res = await client.post('/predict/ranking/enter', {
      startsAt: String(startsAt),
      pick: 'SOLUSDT',
      amount: '2',
    });
    expect(res.headers.get('location')).toBe('/predict/ranking?done=entered');
    expect(balanceOf(handle.db, GENESIS_DISCORD_ID)).toBe(98n * SOAG_PER_BOAG);

    const symbols = env.prediction?.rankingSymbols ?? [];
    settleGameRound(handle.db, {
      roundId: gameRoundId('ranking', '', startsAt),
      candles: new Map(
        symbols.map((symbol) => [
          symbol,
          {
            openTime: startsAt,
            closeTime: startsAt + GAME_ROUND_MS - 1,
            open: '100',
            high: '104',
            low: '99',
            close: symbol === 'SOLUSDT' ? '103' : '101',
          },
        ]),
      ),
      now: startsAt + GAME_ROUND_MS + 60_000,
    });

    const html = await (await client.get('/predict/ranking')).text();
    expect(html).toContain('SOLUSDT +3.00%');
    // 1 人だけなので返金。
    expect(balanceOf(handle.db, GENESIS_DISCORD_ID)).toBe(100n * SOAG_PER_BOAG);
  });

  it('値幅予想に賭けると、選んだ帯が出る', async () => {
    const client = await signIn();
    const page = await (await client.get('/predict/volatility?symbol=ETHUSDT')).text();
    expect(page).toContain('2.5% 以上');
    const startsAt = /name="startsAt" value="(\d+)"/.exec(page)?.[1] ?? '';

    const res = await client.post('/predict/volatility/enter', {
      symbol: 'ETHUSDT',
      startsAt,
      band: '1-1.5',
      amount: '1.5',
    });
    expect(res.headers.get('location')).toBe('/predict/volatility?symbol=ETHUSDT&done=entered');
    expect(balanceOf(handle.db, GENESIS_DISCORD_ID)).toBe(985n * SOAG_PER_BOAG / 10n);

    const after = await (await client.get('/predict/volatility?symbol=ETHUSDT&done=entered')).text();
    expect(after).toContain('「1% から 1.5% 未満」に 1.5 BOAG 賭けています');

    const bad = await client.post('/predict/volatility/enter', {
      symbol: 'BTCUSDT',
      startsAt,
      band: 'huge',
      amount: '1',
    });
    expect(bad.status).toBe(400);
  });

  it('比べていない銘柄には賭けられない', async () => {
    const client = await signIn();
    const res = await client.post('/predict/ranking/enter', {
      startsAt: String(gameBettableStart(Date.now())),
      pick: 'PEPEUSDT',
      amount: '1',
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('比べていない銘柄です');
  });
});

describe('みんなで予想の画面', () => {
  beforeEach(async () => {
    await enroll(bootstrap());
    app = createApp({ db: handle.db, env, notify: recordingNotifier(notices) });
    mint(handle.db, { to: GENESIS_DISCORD_ID, amount: 100n * SOAG_PER_BOAG, ref: 'test' });
  });

  function inTwoDays(): string {
    const date = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000 + 9 * 60 * 60 * 1000);
    return date.toISOString().slice(0, 16);
  }

  it('締め切りの入力は日本時間として読む', () => {
    expect(parseJstDateTime('2026-09-18T09:00')).toBe(Date.parse('2026-09-18T00:00:00Z'));
    expect(parseJstDateTime('2026-09-18 09:00')).toBeNaN();
    expect(parseJstDateTime('')).toBeNaN();
  });

  it('問いを出し、可決したら賭けて、締め切り後に判定で払い戻す', async () => {
    const client = await signIn();

    const proposed = await client.post('/predict/markets/propose', {
      question: '今週 BTC は 7 万ドルを超える?',
      criteria: 'Binance の BTCUSDT の 1 時間足の高値',
      closesAt: inTwoDays(),
    });
    expect(proposed.headers.get('location')).toBe('/predict/markets?done=proposed');
    // メンバーが 1 人なので、その場で可決する。
    expect(notices.channel.some((line) => line.includes('みんなで予想の問い'))).toBe(true);

    const [view] = listMarkets(handle.db);
    const id = view?.market.id ?? '';
    expect(view?.market.status).toBe('open');

    const list = await (await client.get('/predict/markets')).text();
    expect(list).toContain('今週 BTC は 7 万ドルを超える?');

    const bet = await client.post(`/predict/markets/${id}/bet`, { side: 'yes', amount: '4' });
    expect(bet.headers.get('location')).toBe(`/predict/markets/${id}?done=bet`);
    expect(balanceOf(handle.db, GENESIS_DISCORD_ID)).toBe(96n * SOAG_PER_BOAG);

    const early = await client.post(`/predict/markets/${id}/resolve`, { outcome: 'yes' });
    expect(early.status).toBe(400);

    // 締め切りを過ぎたことにする。
    handle.db.update(markets).set({ closesAt: Date.now() - 1000 }).run();
    const detail = await (await client.get(`/predict/markets/${id}`)).text();
    expect(detail).toContain('判定待ち');
    expect(detail).not.toContain(`action="/predict/markets/${id}/bet"`);

    const resolved = await client.post(`/predict/markets/${id}/resolve`, { outcome: 'yes' });
    expect(resolved.headers.get('location')).toBe(`/predict/markets/${id}?done=resolve`);
    expect(getMarket(handle.db, id)?.status).toBe('resolved');
    // 片側だけなので全額が戻る。
    expect(balanceOf(handle.db, GENESIS_DISCORD_ID)).toBe(100n * SOAG_PER_BOAG);
  });

  it('締め切りが読めなければ断る', async () => {
    const client = await signIn();
    const res = await client.post('/predict/markets/propose', {
      question: '?',
      criteria: '',
      closesAt: 'someday',
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('締め切りの日時が読めません');
  });

  it('知らない問いは 404', async () => {
    const client = await signIn();
    expect((await client.get('/predict/markets/nope')).status).toBe(404);
  });
});
