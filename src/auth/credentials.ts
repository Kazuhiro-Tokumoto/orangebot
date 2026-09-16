import { eq } from 'drizzle-orm';
import { appendAudit } from '../db/audit.js';
import type { Db } from '../db/client.js';
import { getMember } from '../db/members.js';
import { passwordCredentials } from '../db/schema.js';
import { checkPasswordStrength, hashPassword, needsRehash, verifyPassword } from './password.js';

export type CredentialResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export function hasPassword(db: Db, memberId: string): boolean {
  return (
    db.select().from(passwordCredentials).where(eq(passwordCredentials.memberId, memberId)).get() !==
    undefined
  );
}

/**
 * パスワードを設定する。強度を見てから argon2id で包む。
 * ハッシュ化は重いので、トランザクションの外で済ませてから書く。
 */
export async function setPassword(
  db: Db,
  input: {
    readonly memberId: string;
    readonly password: string;
    readonly now?: number;
    readonly action?: string;
  },
): Promise<CredentialResult> {
  const now = input.now ?? Date.now();
  const member = getMember(db, input.memberId);
  if (member === undefined) return { ok: false, reason: 'メンバーが見つかりません' };

  const strength = checkPasswordStrength(input.password, {
    username: member.username,
    displayName: member.displayName,
  });
  if (!strength.ok) return strength;

  const hash = await hashPassword(input.password);

  db.insert(passwordCredentials)
    .values({ memberId: input.memberId, hash, updatedAt: now })
    .onConflictDoUpdate({
      target: passwordCredentials.memberId,
      set: { hash, updatedAt: now },
    })
    .run();

  appendAudit(db, {
    at: now,
    actorMemberId: input.memberId,
    action: input.action ?? 'password.set',
    detail: {},
  });

  return { ok: true };
}

export interface PasswordCheckResult {
  readonly matched: boolean;
  /** パラメータが古いので、次の機会に付け替えるべきか。 */
  readonly shouldRehash: boolean;
}

export async function checkPassword(
  db: Db,
  memberId: string,
  password: string,
): Promise<PasswordCheckResult> {
  const row = db
    .select()
    .from(passwordCredentials)
    .where(eq(passwordCredentials.memberId, memberId))
    .get();

  if (row === undefined) {
    // 利用者がいない場合と、いるがパスワード未設定の場合で応答の速さが変わらないよう、
    // 空振りでも 1 回ハッシュを計算してから false を返す。
    await verifyPassword(
      '$argon2id$v=19$m=65536,t=3,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      password,
    );
    return { matched: false, shouldRehash: false };
  }

  const matched = await verifyPassword(row.hash, password);
  return { matched, shouldRehash: matched && needsRehash(row.hash) };
}

export function clearPassword(db: Db, memberId: string): void {
  db.delete(passwordCredentials).where(eq(passwordCredentials.memberId, memberId)).run();
}
