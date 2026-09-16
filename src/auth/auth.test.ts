import { beforeEach, describe, expect, it } from 'vitest';
import { openTestDatabase, type Database_ } from '../db/client.js';
import { setMemberStatus } from '../db/members.js';
import { createGenesisMember } from '../domain/members.js';
import {
  MIN_PASSWORD_LENGTH,
  checkPasswordStrength,
  hashPassword,
  needsRehash,
  verifyPassword,
} from './password.js';
import {
  PENDING_SESSION_TTL_MS,
  SESSION_IDLE_MS,
  SESSION_TTL_MS,
  createSession,
  destroyAllSessions,
  destroySession,
  loadSession,
  purgeExpiredSessions,
  upgradeSession,
} from './session.js';

const T0 = 1_700_000_000_000;

let handle: Database_;
let memberId: string;

function db() {
  return handle.db;
}

beforeEach(() => {
  handle = openTestDatabase();
  const result = createGenesisMember(db(), {
    username: 'kazuhiro',
    displayName: '徳本 和寛',
    now: T0,
  });
  if (!result.ok) throw new Error(result.reason);
  memberId = result.member.id;
});

describe('パスワードの強度', () => {
  it('短いものを断る', () => {
    const result = checkPasswordStrength('a'.repeat(MIN_PASSWORD_LENGTH - 1));
    expect(result.ok).toBe(false);
  });

  it('よくあるものを断る', () => {
    expect(checkPasswordStrength('password').ok).toBe(false);
    expect(checkPasswordStrength('123456789012').ok).toBe(false);
  });

  it('ユーザー名を含むものを断る', () => {
    const result = checkPasswordStrength('my-kazuhiro-secret', { username: 'kazuhiro' });
    expect(result.ok).toBe(false);
  });

  it('同じ文字の繰り返しを断る', () => {
    expect(checkPasswordStrength('abababababab').ok).toBe(false);
  });

  it('長すぎるものを断る', () => {
    expect(checkPasswordStrength('x7#Qa'.repeat(400)).ok).toBe(false);
  });

  it('十分なものを通す', () => {
    expect(checkPasswordStrength('correct-horse-battery-staple-7').ok).toBe(true);
  });
});

describe('パスワードのハッシュ', () => {
  it('照合できる', async () => {
    const stored = await hashPassword('correct-horse-battery-staple-7');
    expect(await verifyPassword(stored, 'correct-horse-battery-staple-7')).toBe(true);
    expect(await verifyPassword(stored, 'wrong-password-entirely')).toBe(false);
  });

  it('同じパスワードでも毎回違うハッシュになる', async () => {
    const a = await hashPassword('correct-horse-battery-staple-7');
    const b = await hashPassword('correct-horse-battery-staple-7');
    expect(a).not.toBe(b);
    expect(a.startsWith('$argon2id$')).toBe(true);
  });

  it('壊れたハッシュは例外ではなく不一致として扱う', async () => {
    expect(await verifyPassword('not-a-hash', 'correct-horse-battery-staple-7')).toBe(false);
    expect(await verifyPassword('', 'correct-horse-battery-staple-7')).toBe(false);
  });

  it('古いパラメータのハッシュを付け替え対象と判定する', async () => {
    expect(needsRehash('$argon2id$v=19$m=4096,t=1,p=1$abc$def')).toBe(true);
    expect(needsRehash('plain-text-password')).toBe(true);
    expect(needsRehash(await hashPassword('correct-horse-battery-staple-7'))).toBe(false);
  });
});

describe('セッション', () => {
  it('作って引ける', () => {
    const issued = createSession(db(), { memberId, aal: 2, now: T0 });
    const loaded = loadSession(db(), issued.token, T0 + 1000);
    expect(loaded?.member.id).toBe(memberId);
    expect(loaded?.aal).toBe(2);
  });

  it('DB には token そのものを残さない', () => {
    const issued = createSession(db(), { memberId, aal: 2, now: T0 });
    const rows = handle.raw.prepare('SELECT id FROM sessions').all() as { id: string }[];
    expect(rows[0]?.id).not.toBe(issued.token);
    expect(rows[0]?.id).toHaveLength(64);
  });

  it('知らない token は通らない', () => {
    expect(loadSession(db(), 'made-up-token', T0)).toBeUndefined();
  });

  it('二要素待ちのセッションは寿命が短い', () => {
    const issued = createSession(db(), { memberId, aal: 1, now: T0 });
    expect(issued.expiresAt).toBe(T0 + PENDING_SESSION_TTL_MS);
    expect(loadSession(db(), issued.token, T0 + PENDING_SESSION_TTL_MS)).toBeUndefined();
  });

  it('期限を過ぎたら通らない', () => {
    const issued = createSession(db(), { memberId, aal: 2, now: T0 });
    expect(loadSession(db(), issued.token, T0 + SESSION_TTL_MS)).toBeUndefined();
  });

  it('無操作が続いたら通らない', () => {
    const issued = createSession(db(), { memberId, aal: 2, now: T0 });
    expect(loadSession(db(), issued.token, T0 + SESSION_IDLE_MS)).toBeUndefined();
  });

  it('使うたびに無操作の時計が戻る', () => {
    const issued = createSession(db(), { memberId, aal: 2, now: T0 });
    const half = SESSION_IDLE_MS - 1000;
    expect(loadSession(db(), issued.token, T0 + half)).toBeDefined();
    expect(loadSession(db(), issued.token, T0 + half + half)).toBeDefined();
  });

  it('停止されたメンバーのセッションは即座に無効になる', () => {
    const issued = createSession(db(), { memberId, aal: 2, now: T0 });
    setMemberStatus(db(), memberId, 'suspended', T0);
    expect(loadSession(db(), issued.token, T0 + 1000)).toBeUndefined();
  });

  it('ログアウトで消える', () => {
    const issued = createSession(db(), { memberId, aal: 2, now: T0 });
    destroySession(db(), issued.token);
    expect(loadSession(db(), issued.token, T0 + 1000)).toBeUndefined();
  });
});

describe('二要素を通したときの引き上げ', () => {
  it('aal が 2 になり token が作り直される', () => {
    const first = createSession(db(), { memberId, aal: 1, now: T0 });
    const second = upgradeSession(db(), { currentToken: first.token, factor: 'totp', now: T0 + 500 });

    expect(second).toBeDefined();
    expect(second?.token).not.toBe(first.token);
    // 古い token はもう通らない。
    expect(loadSession(db(), first.token, T0 + 1000)).toBeUndefined();
    expect(loadSession(db(), second!.token, T0 + 1000)?.aal).toBe(2);
  });

  it('期限切れのセッションは引き上げられない', () => {
    const first = createSession(db(), { memberId, aal: 1, now: T0 });
    const result = upgradeSession(db(), {
      currentToken: first.token,
      factor: 'totp',
      now: T0 + PENDING_SESSION_TTL_MS,
    });
    expect(result).toBeUndefined();
  });
});

describe('まとめて無効化', () => {
  it('他の端末を締め出せる', () => {
    const keep = createSession(db(), { memberId, aal: 2, now: T0 });
    createSession(db(), { memberId, aal: 2, now: T0 });
    createSession(db(), { memberId, aal: 2, now: T0 });

    const removed = destroyAllSessions(db(), memberId, keep.id);
    expect(removed).toBe(2);
    expect(loadSession(db(), keep.token, T0 + 1000)).toBeDefined();
  });

  it('期限切れをまとめて掃除できる', () => {
    createSession(db(), { memberId, aal: 1, now: T0 });
    createSession(db(), { memberId, aal: 2, now: T0 });
    expect(purgeExpiredSessions(db(), T0 + PENDING_SESSION_TTL_MS + 1)).toBe(1);
  });
});
