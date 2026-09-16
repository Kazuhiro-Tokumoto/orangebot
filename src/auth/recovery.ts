import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import * as OTPAuth from 'otpauth';
import { appendAudit } from '../db/audit.js';
import type { Db } from '../db/client.js';
import { recoveryCodes } from '../db/schema.js';
import { toArrayBuffer } from './crypto.js';

/**
 * リカバリコード。
 *
 * 承認だけでは復旧できない場面が 1 つだけある。メンバーが本人しかおらず、
 * その本人がパスワードを忘れたときで、承認できる人が誰もいない。
 * そこを塞ぐための最後の手段。
 *
 * 保存するのは SHA-256 のみ。コードは 120 ビットあり総当たりの余地がないので、
 * argon2 を通す必要がない。引き当ても 1 回のハッシュ照合で済む。
 */

export const RECOVERY_CODE_COUNT = 10;
const CODE_BYTES = 15; // 120 ビット。base32 でちょうど 24 文字になる。
const GROUP_SIZE = 6;

export function generateCode(): string {
  const base32 = new OTPAuth.Secret({ buffer: toArrayBuffer(randomBytes(CODE_BYTES)) }).base32;
  const groups: string[] = [];
  for (let i = 0; i < base32.length; i += GROUP_SIZE) {
    groups.push(base32.slice(i, i + GROUP_SIZE));
  }
  return groups.join('-');
}

export function generateCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, generateCode);
}

/** 入力の揺れを吸収する。大文字小文字、区切り、空白は無視する。 */
export function normalize(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase();
}

export function hashCode(code: string): string {
  return createHash('sha256').update(normalize(code)).digest('hex');
}

/**
 * コードを発行し直す。古いものは使用済みも含めて消える。
 * 手元の紙と DB の中身が食い違う状態を残さないため。
 */
export function replaceCodes(
  db: Db,
  input: {
    readonly memberId: string;
    readonly now?: number;
    readonly count?: number;
  },
): string[] {
  const now = input.now ?? Date.now();
  const codes = generateCodes(input.count ?? RECOVERY_CODE_COUNT);

  db.delete(recoveryCodes).where(eq(recoveryCodes.memberId, input.memberId)).run();
  for (const code of codes) {
    db.insert(recoveryCodes)
      .values({
        id: randomUUID(),
        memberId: input.memberId,
        codeHash: hashCode(code),
        createdAt: now,
      })
      .run();
  }

  appendAudit(db, {
    at: now,
    actorMemberId: input.memberId,
    action: 'recovery.codes_issued',
    detail: { count: codes.length },
  });

  return codes;
}

export type ConsumeResult =
  | { readonly ok: true; readonly memberId: string; readonly remaining: number }
  | { readonly ok: false; readonly reason: string };

/**
 * コードを 1 枚使う。
 *
 * 引き当ては codeHash の一致なので、当たったコードが誰のものかは結果から分かる。
 * memberId を渡した場合は、その人のものであることも確かめる。
 */
export function consumeCode(
  db: Db,
  input: {
    readonly code: string;
    readonly memberId?: string;
    readonly now?: number;
  },
): ConsumeResult {
  const now = input.now ?? Date.now();
  const hash = hashCode(input.code);

  return db.transaction((tx) => {
    const row = tx.select().from(recoveryCodes).where(eq(recoveryCodes.codeHash, hash)).get();

    if (row === undefined) return { ok: false, reason: 'リカバリコードが違います' };
    if (row.usedAt !== null) {
      return { ok: false, reason: 'このリカバリコードは既に使われています' };
    }
    if (input.memberId !== undefined && row.memberId !== input.memberId) {
      return { ok: false, reason: 'リカバリコードが違います' };
    }

    tx.update(recoveryCodes).set({ usedAt: now }).where(eq(recoveryCodes.id, row.id)).run();

    const remaining = countUnused(tx, row.memberId);
    appendAudit(tx, {
      at: now,
      actorMemberId: row.memberId,
      action: 'recovery.code_used',
      detail: { remaining },
    });

    return { ok: true, memberId: row.memberId, remaining };
  });
}

export function countUnused(db: Db, memberId: string): number {
  return db
    .select()
    .from(recoveryCodes)
    .where(and(eq(recoveryCodes.memberId, memberId), isNull(recoveryCodes.usedAt)))
    .all().length;
}
