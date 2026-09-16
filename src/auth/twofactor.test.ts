import { Secret, TOTP } from 'otpauth';
import { beforeEach, describe, expect, it } from 'vitest';
import { openTestDatabase, type Database_ } from '../db/client.js';
import { verifyAuditLog } from '../db/audit.js';
import { createGenesisMember } from '../domain/members.js';
import { decrypt, decryptToString, encrypt } from './crypto.js';
import {
  RECOVERY_CODE_COUNT,
  consumeCode,
  countUnused,
  generateCode,
  hashCode,
  normalize,
  replaceCodes,
} from './recovery.js';
import {
  TOTP_PERIOD,
  buildUri,
  confirmSecret,
  generateSecret,
  hasConfirmedTotp,
  loadSecret,
  removeTotp,
  storeSecret,
  verifyCode,
} from './totp.js';

const T0 = 1_700_000_000_000;
const KEY = Buffer.alloc(32, 9);

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

describe('保存時暗号化', () => {
  it('往復できる', () => {
    const blob = encrypt(KEY, 'secret-value');
    expect(decryptToString(KEY, blob)).toBe('secret-value');
  });

  it('同じ平文でも毎回違う暗号文になる', () => {
    expect(encrypt(KEY, 'x').equals(encrypt(KEY, 'x'))).toBe(false);
  });

  it('1 バイトでも書き換えれば復号が失敗する', () => {
    const blob = encrypt(KEY, 'secret-value');
    const last = blob.length - 1;
    blob[last] = (blob[last] ?? 0) ^ 0x01;
    expect(() => decrypt(KEY, blob)).toThrow();
  });

  it('鍵が違えば復号できない', () => {
    const blob = encrypt(KEY, 'secret-value');
    expect(() => decrypt(Buffer.alloc(32, 1), blob)).toThrow();
  });

  it('付随データが違えば復号できない', () => {
    const blob = encrypt(KEY, 'secret-value', 'member-a');
    expect(() => decrypt(KEY, blob, 'member-b')).toThrow();
    expect(decryptToString(KEY, blob, 'member-a')).toBe('secret-value');
  });

  it('鍵の長さを検査する', () => {
    expect(() => encrypt(Buffer.alloc(16), 'x')).toThrow(/32 バイト/);
  });
});

describe('TOTP', () => {
  it('秘密鍵から符号を作って照合できる', () => {
    const secret = generateSecret();
    const totp = buildUri({ secret, username: 'kazuhiro' });
    expect(totp.startsWith('otpauth://totp/')).toBe(true);

    // 時計を固定して、その時刻の正しい符号を作る。
    const code = codeAt(secret, T0);
    expect(verifyCode({ secret, code, now: T0 })).toBe(true);
  });

  it('前後 1 段のずれを許す', () => {
    const secret = generateSecret();
    const code = codeAt(secret, T0);
    expect(verifyCode({ secret, code, now: T0 + TOTP_PERIOD * 1000 })).toBe(true);
    expect(verifyCode({ secret, code, now: T0 - TOTP_PERIOD * 1000 })).toBe(true);
  });

  it('2 段ずれたら通さない', () => {
    const secret = generateSecret();
    const code = codeAt(secret, T0);
    expect(verifyCode({ secret, code, now: T0 + TOTP_PERIOD * 3000 })).toBe(false);
  });

  it('形の違う入力を弾く', () => {
    const secret = generateSecret();
    expect(verifyCode({ secret, code: '12345', now: T0 })).toBe(false);
    expect(verifyCode({ secret, code: 'abcdef', now: T0 })).toBe(false);
    expect(verifyCode({ secret, code: '', now: T0 })).toBe(false);
  });

  it('空白とハイフンは無視する', () => {
    const secret = generateSecret();
    const code = codeAt(secret, T0);
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect(verifyCode({ secret, code: spaced, now: T0 })).toBe(true);
  });

  it('秘密鍵は平文で保存されない', () => {
    const secret = generateSecret();
    storeSecret(db(), { memberId, secret, key: KEY, confirmed: false, now: T0 });

    const raw = handle.raw.prepare('SELECT secret_cipher FROM totp_credentials').get() as {
      secret_cipher: Buffer;
    };
    expect(raw.secret_cipher.toString('utf8')).not.toContain(secret);
    expect(loadSecret(db(), memberId, KEY)?.secret).toBe(secret);
  });

  it('正しい符号を 1 回出すまで有効にならない', () => {
    const secret = generateSecret();
    storeSecret(db(), { memberId, secret, key: KEY, confirmed: false, now: T0 });
    expect(hasConfirmedTotp(db(), memberId)).toBe(false);

    expect(confirmSecret(db(), { memberId, code: '000000', key: KEY, now: T0 })).toBe(false);
    expect(hasConfirmedTotp(db(), memberId)).toBe(false);

    const code = codeAt(secret, T0);
    expect(confirmSecret(db(), { memberId, code, key: KEY, now: T0 })).toBe(true);
    expect(hasConfirmedTotp(db(), memberId)).toBe(true);
  });

  it('鍵が変わっていれば読み出せない', () => {
    const secret = generateSecret();
    storeSecret(db(), { memberId, secret, key: KEY, confirmed: true, now: T0 });
    expect(loadSecret(db(), memberId, Buffer.alloc(32, 3))).toBeUndefined();
  });

  it('削除できる', () => {
    storeSecret(db(), { memberId, secret: generateSecret(), key: KEY, confirmed: true, now: T0 });
    removeTotp(db(), memberId, T0);
    expect(hasConfirmedTotp(db(), memberId)).toBe(false);
  });
});

describe('リカバリコード', () => {
  it('読みやすい形で発行される', () => {
    const code = generateCode();
    expect(code).toMatch(/^[A-Z2-7]{6}-[A-Z2-7]{6}-[A-Z2-7]{6}-[A-Z2-7]{6}$/);
  });

  it('毎回違う', () => {
    const codes = new Set(Array.from({ length: 50 }, generateCode));
    expect(codes.size).toBe(50);
  });

  it('大文字小文字と区切りを無視して引き当てる', () => {
    const code = generateCode();
    expect(hashCode(code.toLowerCase().replace(/-/g, ' '))).toBe(hashCode(code));
    expect(normalize('ab-cd ef')).toBe('ABCDEF');
  });

  it('既定で 10 枚発行し、平文は保存しない', () => {
    const codes = replaceCodes(db(), { memberId, now: T0 });
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(countUnused(db(), memberId)).toBe(RECOVERY_CODE_COUNT);

    const rows = handle.raw.prepare('SELECT code_hash FROM recovery_codes').all() as {
      code_hash: string;
    }[];
    for (const row of rows) {
      expect(codes).not.toContain(row.code_hash);
      expect(row.code_hash).toHaveLength(64);
    }
  });

  it('1 回使うと 2 回目は通らない', () => {
    const codes = replaceCodes(db(), { memberId, now: T0 });
    const first = consumeCode(db(), { code: codes[0]!, now: T0 + 1000 });
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.memberId).toBe(memberId);
      expect(first.remaining).toBe(RECOVERY_CODE_COUNT - 1);
    }

    const second = consumeCode(db(), { code: codes[0]!, now: T0 + 2000 });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toContain('既に使われ');
  });

  it('知らないコードは通らない', () => {
    replaceCodes(db(), { memberId, now: T0 });
    expect(consumeCode(db(), { code: generateCode(), now: T0 }).ok).toBe(false);
  });

  it('別人のコードでは通らない', () => {
    const codes = replaceCodes(db(), { memberId, now: T0 });
    const result = consumeCode(db(), {
      code: codes[0]!,
      memberId: 'someone-else',
      now: T0 + 1000,
    });
    expect(result.ok).toBe(false);
    // 弾かれた以上、使用済みにはしない。
    expect(countUnused(db(), memberId)).toBe(RECOVERY_CODE_COUNT);
  });

  it('発行し直すと古いコードは死ぬ', () => {
    const old = replaceCodes(db(), { memberId, now: T0 });
    replaceCodes(db(), { memberId, now: T0 + 1000 });
    expect(consumeCode(db(), { code: old[0]!, now: T0 + 2000 }).ok).toBe(false);
    expect(countUnused(db(), memberId)).toBe(RECOVERY_CODE_COUNT);
  });

  it('使い切れる', () => {
    const codes = replaceCodes(db(), { memberId, now: T0 });
    for (const code of codes) {
      expect(consumeCode(db(), { code, now: T0 + 1000 }).ok).toBe(true);
    }
    expect(countUnused(db(), memberId)).toBe(0);
  });

  it('監査ログが壊れない', () => {
    const codes = replaceCodes(db(), { memberId, now: T0 });
    consumeCode(db(), { code: codes[0]!, now: T0 + 1000 });
    expect(verifyAuditLog(db()).ok).toBe(true);
  });
});

/** 指定時刻におけるその秘密鍵の正しい符号を作る。照合ではなく生成側を使う。 */
function codeAt(secret: string, timestamp: number): string {
  return new TOTP({
    issuer: 'orangebot',
    label: 'x',
    algorithm: 'SHA1',
    digits: 6,
    period: TOTP_PERIOD,
    secret: Secret.fromBase32(secret),
  }).generate({ timestamp });
}
