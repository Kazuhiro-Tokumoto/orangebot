import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import * as OTPAuth from 'otpauth';
import { appendAudit } from '../db/audit.js';
import type { Db } from '../db/client.js';
import { totpCredentials } from '../db/schema.js';
import { decryptToString, encrypt, toArrayBuffer } from './crypto.js';

/**
 * 時刻同期ワンタイムパスワード (RFC 6238)。
 *
 * 秘密鍵は平文で置かず、APP_ENCRYPTION_KEY で暗号化して保存する。
 * DB だけを持ち出されても符号を作れないようにするため。
 */

export const TOTP_DIGITS = 6;
export const TOTP_PERIOD = 30;
/** 前後 1 段まで許す。端末の時計のずれを吸収するため。 */
export const TOTP_WINDOW = 1;

export function generateSecret(): string {
  return new OTPAuth.Secret({ buffer: toArrayBuffer(randomBytes(20)) }).base32;
}

function build(secret: string, label: string, issuer: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer,
    label,
    algorithm: 'SHA1',
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
}

/** 認証アプリに読ませる otpauth:// の URI。 */
export function buildUri(input: {
  readonly secret: string;
  readonly username: string;
  readonly issuer?: string;
}): string {
  return build(input.secret, input.username, input.issuer ?? 'orangebot').toString();
}

/**
 * 符号を照合する。
 * 数字以外が混ざっていても弾かず、空白とハイフンだけ落としてから見る。
 */
export function verifyCode(input: {
  readonly secret: string;
  readonly code: string;
  readonly now?: number;
}): boolean {
  const normalized = input.code.replace(/[\s-]/g, '');
  if (!/^\d{6}$/.test(normalized)) return false;

  const delta = build(input.secret, 'x', 'orangebot').validate({
    token: normalized,
    window: TOTP_WINDOW,
    timestamp: input.now ?? Date.now(),
  });
  return delta !== null;
}

// --- 保存 -----------------------------------------------------------------

export function storeSecret(
  db: Db,
  input: {
    readonly memberId: string;
    readonly secret: string;
    readonly key: Buffer;
    readonly confirmed: boolean;
    readonly now?: number;
  },
): void {
  const now = input.now ?? Date.now();
  const cipher = encrypt(input.key, input.secret, input.memberId);

  db.insert(totpCredentials)
    .values({
      memberId: input.memberId,
      secretCipher: cipher,
      confirmedAt: input.confirmed ? now : null,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: totpCredentials.memberId,
      set: { secretCipher: cipher, confirmedAt: input.confirmed ? now : null, createdAt: now },
    })
    .run();
}

export interface StoredTotp {
  readonly secret: string;
  readonly confirmed: boolean;
}

export function loadSecret(db: Db, memberId: string, key: Buffer): StoredTotp | undefined {
  const row = db.select().from(totpCredentials).where(eq(totpCredentials.memberId, memberId)).get();
  if (row === undefined) return undefined;

  try {
    return {
      secret: decryptToString(key, Buffer.from(row.secretCipher), memberId),
      confirmed: row.confirmedAt !== null,
    };
  } catch {
    // 鍵が変わったか、行が書き換えられている。使えないものとして扱う。
    return undefined;
  }
}

/** 登録時の確認。正しい符号を 1 回出せて初めて有効にする。 */
export function confirmSecret(
  db: Db,
  input: {
    readonly memberId: string;
    readonly code: string;
    readonly key: Buffer;
    readonly now?: number;
  },
): boolean {
  const now = input.now ?? Date.now();
  const stored = loadSecret(db, input.memberId, input.key);
  if (stored === undefined) return false;
  if (!verifyCode({ secret: stored.secret, code: input.code, now })) return false;

  db.update(totpCredentials)
    .set({ confirmedAt: now })
    .where(eq(totpCredentials.memberId, input.memberId))
    .run();

  appendAudit(db, {
    at: now,
    actorMemberId: input.memberId,
    action: 'totp.confirmed',
    detail: {},
  });
  return true;
}

export function hasConfirmedTotp(db: Db, memberId: string): boolean {
  const row = db.select().from(totpCredentials).where(eq(totpCredentials.memberId, memberId)).get();
  return row !== undefined && row.confirmedAt !== null;
}

export function removeTotp(db: Db, memberId: string, now = Date.now()): void {
  db.delete(totpCredentials).where(eq(totpCredentials.memberId, memberId)).run();
  appendAudit(db, {
    at: now,
    actorMemberId: memberId,
    action: 'totp.removed',
    detail: {},
  });
}
