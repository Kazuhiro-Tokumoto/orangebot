import { beforeEach, describe, expect, it } from 'vitest';
import { FakeAuthenticator } from '../__tests__/authenticator.js';
import { verifyAuditLog } from '../db/audit.js';
import { openTestDatabase, type Database_ } from '../db/client.js';
import { members, type MemberRow } from '../db/schema.js';
import {
  CHALLENGE_TTL_MS,
  finishAuthentication,
  finishRegistration,
  hasPasskey,
  listPasskeys,
  removePasskey,
  startAuthentication,
  startRegistration,
} from './passkey.js';

const T0 = 1_700_000_000_000;
const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:3000';

let handle: Database_;

function db() {
  return handle.db;
}

function makeMember(id: string, username: string): MemberRow {
  const row: MemberRow = {
    id,
    username,
    displayName: username.toUpperCase(),
    status: 'active',
    createdAt: T0,
    activatedAt: T0,
  };
  db().insert(members).values(row).run();
  return row;
}

/** 登録まで済ませて、その偽の認証器を返す。 */
async function register(member: MemberRow, counter = 0): Promise<FakeAuthenticator> {
  const start = await startRegistration(db(), {
    member,
    rpId: RP_ID,
    rpName: 'orangebot',
    now: T0,
  });

  const device = new FakeAuthenticator({ rpId: RP_ID, origin: ORIGIN, userHandle: member.id });
  const result = await finishRegistration(db(), {
    memberId: member.id,
    challengeId: start.challengeId,
    response: device.register(start.options.challenge, counter),
    nickname: 'テスト端末',
    origin: ORIGIN,
    rpId: RP_ID,
    now: T0,
  });

  expect(result).toEqual({ ok: true, passkeyId: device.credentialId.toString('base64url') });
  return device;
}

beforeEach(() => {
  handle = openTestDatabase();
});

describe('パスキーの登録', () => {
  it('認証器の応答を検証して保存する', async () => {
    const member = makeMember('1529717434259345489', 'kazuhiro-tokumoto');
    await register(member);

    const stored = listPasskeys(db(), member.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.nickname).toBe('テスト端末');
    expect(stored[0]?.deviceType).toBe('multiDevice');
    expect(hasPasskey(db(), member.id)).toBe(true);
    expect(verifyAuditLog(db()).ok).toBe(true);
  });

  it('端末から鍵が出ない形でしか登録させない', async () => {
    const member = makeMember('1529717434259345489', 'kazuhiro-tokumoto');
    const start = await startRegistration(db(), {
      member,
      rpId: RP_ID,
      rpName: 'orangebot',
      now: T0,
    });

    expect(start.options.authenticatorSelection?.residentKey).toBe('required');
    expect(start.options.authenticatorSelection?.userVerification).toBe('required');
  });

  it('同じ challenge は二度使えない', async () => {
    const member = makeMember('1529717434259345489', 'kazuhiro-tokumoto');
    const start = await startRegistration(db(), {
      member,
      rpId: RP_ID,
      rpName: 'orangebot',
      now: T0,
    });
    const device = new FakeAuthenticator({ rpId: RP_ID, origin: ORIGIN });
    const response = device.register(start.options.challenge);

    const first = await finishRegistration(db(), {
      memberId: member.id,
      challengeId: start.challengeId,
      response,
      nickname: '',
      origin: ORIGIN,
      rpId: RP_ID,
      now: T0,
    });
    const second = await finishRegistration(db(), {
      memberId: member.id,
      challengeId: start.challengeId,
      response,
      nickname: '',
      origin: ORIGIN,
      rpId: RP_ID,
      now: T0,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
  });

  it('期限を過ぎた challenge は通らない', async () => {
    const member = makeMember('1529717434259345489', 'kazuhiro-tokumoto');
    const start = await startRegistration(db(), {
      member,
      rpId: RP_ID,
      rpName: 'orangebot',
      now: T0,
    });
    const device = new FakeAuthenticator({ rpId: RP_ID, origin: ORIGIN });

    const result = await finishRegistration(db(), {
      memberId: member.id,
      challengeId: start.challengeId,
      response: device.register(start.options.challenge),
      nickname: '',
      origin: ORIGIN,
      rpId: RP_ID,
      now: T0 + CHALLENGE_TTL_MS + 1,
    });

    expect(result.ok).toBe(false);
    expect(listPasskeys(db(), member.id)).toHaveLength(0);
  });

  it('別の生成元で作られた応答は弾く', async () => {
    const member = makeMember('1529717434259345489', 'kazuhiro-tokumoto');
    const start = await startRegistration(db(), {
      member,
      rpId: RP_ID,
      rpName: 'orangebot',
      now: T0,
    });
    const device = new FakeAuthenticator({ rpId: RP_ID, origin: 'https://nisemono.example' });

    const result = await finishRegistration(db(), {
      memberId: member.id,
      challengeId: start.challengeId,
      response: device.register(start.options.challenge),
      nickname: '',
      origin: ORIGIN,
      rpId: RP_ID,
      now: T0,
    });

    expect(result.ok).toBe(false);
  });

  it('登録済みの鍵は次の登録から除かれる', async () => {
    const member = makeMember('1529717434259345489', 'kazuhiro-tokumoto');
    const device = await register(member);

    const again = await startRegistration(db(), {
      member,
      rpId: RP_ID,
      rpName: 'orangebot',
      now: T0,
    });
    expect(again.options.excludeCredentials?.map((item) => item.id)).toEqual([
      device.credentialId.toString('base64url'),
    ]);
  });
});

describe('パスキーでのログイン', () => {
  it('署名が合えば本人だと分かる', async () => {
    const member = makeMember('1529717434259345489', 'kazuhiro-tokumoto');
    const device = await register(member);

    const start = await startAuthentication(db(), { rpId: RP_ID, now: T0 });
    const result = await finishAuthentication(db(), {
      challengeId: start.challengeId,
      response: device.authenticate(start.options.challenge),
      origin: ORIGIN,
      rpId: RP_ID,
      now: T0 + 1000,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.member.id).toBe(member.id);
    expect(listPasskeys(db(), member.id)[0]?.lastUsedAt).toBe(T0 + 1000);
    expect(verifyAuditLog(db()).ok).toBe(true);
  });

  it('利用者名を先に聞かないので、選択肢に鍵の一覧は載らない', async () => {
    const member = makeMember('1529717434259345489', 'kazuhiro-tokumoto');
    await register(member);

    const start = await startAuthentication(db(), { rpId: RP_ID, now: T0 });
    expect(start.options.allowCredentials ?? []).toHaveLength(0);
    expect(start.options.userVerification).toBe('required');
  });

  it('知らない鍵では通らない', async () => {
    makeMember('1529717434259345489', 'kazuhiro-tokumoto');
    const stranger = new FakeAuthenticator({ rpId: RP_ID, origin: ORIGIN });

    const start = await startAuthentication(db(), { rpId: RP_ID, now: T0 });
    const result = await finishAuthentication(db(), {
      challengeId: start.challengeId,
      response: stranger.authenticate(start.options.challenge),
      origin: ORIGIN,
      rpId: RP_ID,
      now: T0,
    });

    expect(result.ok).toBe(false);
  });

  it('別の challenge に対する署名は通らない', async () => {
    const member = makeMember('1529717434259345489', 'kazuhiro-tokumoto');
    const device = await register(member);

    const start = await startAuthentication(db(), { rpId: RP_ID, now: T0 });
    const other = await startAuthentication(db(), { rpId: RP_ID, now: T0 });

    const result = await finishAuthentication(db(), {
      challengeId: start.challengeId,
      response: device.authenticate(other.options.challenge),
      origin: ORIGIN,
      rpId: RP_ID,
      now: T0,
    });

    expect(result.ok).toBe(false);
  });

  it('署名回数が巻き戻っていたら断る', async () => {
    const member = makeMember('1529717434259345489', 'kazuhiro-tokumoto');
    const device = await register(member, 5);

    const start = await startAuthentication(db(), { rpId: RP_ID, now: T0 });
    const result = await finishAuthentication(db(), {
      challengeId: start.challengeId,
      response: device.authenticate(start.options.challenge, 3),
      origin: ORIGIN,
      rpId: RP_ID,
      now: T0,
    });

    expect(result.ok).toBe(false);
    expect(listPasskeys(db(), member.id)[0]?.counter).toBe(5);
  });

  it('停止されたメンバーの鍵では入れない', async () => {
    const member = makeMember('1529717434259345489', 'kazuhiro-tokumoto');
    const device = await register(member);
    db().update(members).set({ status: 'suspended' }).run();

    const start = await startAuthentication(db(), { rpId: RP_ID, now: T0 });
    const result = await finishAuthentication(db(), {
      challengeId: start.challengeId,
      response: device.authenticate(start.options.challenge),
      origin: ORIGIN,
      rpId: RP_ID,
      now: T0,
    });

    expect(result.ok).toBe(false);
  });
});

describe('パスキーの削除', () => {
  it('持ち主だけが消せる', async () => {
    const owner = makeMember('1529717434259345489', 'kazuhiro-tokumoto');
    const other = makeMember('1700000000000000001', 'bravo');
    const device = await register(owner);
    const passkeyId = device.credentialId.toString('base64url');

    const byOther = removePasskey(db(), { memberId: other.id, passkeyId, now: T0 });
    expect(byOther.ok).toBe(false);
    expect(listPasskeys(db(), owner.id)).toHaveLength(1);

    const byOwner = removePasskey(db(), { memberId: owner.id, passkeyId, now: T0 });
    expect(byOwner.ok).toBe(true);
    expect(listPasskeys(db(), owner.id)).toHaveLength(0);
    expect(verifyAuditLog(db()).ok).toBe(true);
  });
});
