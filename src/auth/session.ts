import { createHash, randomBytes } from 'node:crypto';
import { and, eq, lt } from 'drizzle-orm';
import { appendAudit } from '../db/audit.js';
import type { Db } from '../db/client.js';
import { getMember } from '../db/members.js';
import { sessions, type MemberRow, type SessionRow } from '../db/schema.js';

/**
 * セッション。
 *
 * クッキーに入れるのは token、DB に置くのはその sha256 だけ。
 * DB が漏れてもセッションを乗っ取れないようにするため。
 *
 * aal は到達した認証の段階を表す。
 *   1 = パスワードだけ通した途中の状態
 *   2 = 二要素まで通した状態
 * 投票と設定変更は 2 を必須にする。
 */

export type Aal = 1 | 2;

/** 二要素を待っている間の猶予。長く置く意味がない。 */
export const PENDING_SESSION_TTL_MS = 10 * 60 * 1000;
/** 二要素まで通ったセッションの寿命。 */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** 無操作で切れるまで。 */
export const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface CreateSessionInput {
  readonly memberId: string;
  readonly aal: Aal;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly now?: number;
}

export interface IssuedSession {
  readonly token: string;
  readonly id: string;
  readonly expiresAt: number;
}

export function createSession(db: Db, input: CreateSessionInput): IssuedSession {
  const now = input.now ?? Date.now();
  const token = randomBytes(32).toString('base64url');
  const id = hashToken(token);
  const expiresAt = now + (input.aal === 2 ? SESSION_TTL_MS : PENDING_SESSION_TTL_MS);

  db.insert(sessions)
    .values({
      id,
      memberId: input.memberId,
      aal: input.aal,
      createdAt: now,
      expiresAt,
      lastSeenAt: now,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    })
    .run();

  return { token, id, expiresAt };
}

export interface LoadedSession {
  readonly session: SessionRow;
  readonly member: MemberRow;
  readonly aal: Aal;
}

/**
 * クッキーの token からセッションを引く。
 *
 * 期限切れ、無操作が続いたもの、メンバーが有効でなくなったものは全て未ログイン扱いにし、
 * ついでに DB からも消す。
 */
export function loadSession(db: Db, token: string, now = Date.now()): LoadedSession | undefined {
  const id = hashToken(token);
  const row = db.select().from(sessions).where(eq(sessions.id, id)).get();
  if (row === undefined) return undefined;

  if (now >= row.expiresAt || now - row.lastSeenAt >= SESSION_IDLE_MS) {
    db.delete(sessions).where(eq(sessions.id, id)).run();
    return undefined;
  }

  // 停止・除名されたメンバーのセッションは、期限が残っていても通さない。
  const member = getMember(db, row.memberId);
  if (member === undefined || member.status !== 'active') {
    db.delete(sessions).where(eq(sessions.id, id)).run();
    return undefined;
  }

  db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, id)).run();

  return { session: { ...row, lastSeenAt: now }, member, aal: row.aal === 2 ? 2 : 1 };
}

/**
 * 二要素を通ったのでセッションを引き上げる。
 *
 * ここで token を作り直す。パスワードだけの段階で誰かに知られた識別子が、
 * そのまま完全な権限を持つセッションになってしまうのを避けるため。
 */
export function upgradeSession(
  db: Db,
  input: {
    readonly currentToken: string;
    readonly factor: string;
    readonly now?: number;
  },
): IssuedSession | undefined {
  const now = input.now ?? Date.now();
  const id = hashToken(input.currentToken);
  const row = db.select().from(sessions).where(eq(sessions.id, id)).get();
  if (row === undefined || now >= row.expiresAt) return undefined;

  db.delete(sessions).where(eq(sessions.id, id)).run();
  const next = createSession(db, {
    memberId: row.memberId,
    aal: 2,
    ip: row.ip,
    userAgent: row.userAgent,
    now,
  });

  appendAudit(db, {
    at: now,
    actorMemberId: row.memberId,
    action: 'session.upgraded',
    detail: { factor: input.factor },
  });

  return next;
}

export function destroySession(db: Db, token: string): void {
  db.delete(sessions)
    .where(eq(sessions.id, hashToken(token)))
    .run();
}

/** 設定画面に出す、そのメンバーの生きているセッション。新しい順。 */
export function listSessions(db: Db, memberId: string, now = Date.now()): SessionRow[] {
  return db
    .select()
    .from(sessions)
    .where(eq(sessions.memberId, memberId))
    .all()
    .filter((row) => now < row.expiresAt && now - row.lastSeenAt < SESSION_IDLE_MS)
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

/** パスワード変更や二要素の入れ替えのあと、他の端末を締め出す。 */
export function destroyAllSessions(db: Db, memberId: string, keepSessionId?: string): number {
  const rows = db.select().from(sessions).where(eq(sessions.memberId, memberId)).all();
  let removed = 0;
  for (const row of rows) {
    if (row.id === keepSessionId) continue;
    db.delete(sessions).where(eq(sessions.id, row.id)).run();
    removed += 1;
  }
  return removed;
}

/** 期限切れの掃除。起動時と定期実行で呼ぶ。 */
export function purgeExpiredSessions(db: Db, now = Date.now()): number {
  const rows = db.select().from(sessions).where(lt(sessions.expiresAt, now)).all();
  db.delete(sessions).where(lt(sessions.expiresAt, now)).run();
  return rows.length;
}

/** 特定のメンバーの、二要素待ちのまま放置されたセッションを消す。 */
export function purgePendingSessions(db: Db, memberId: string): void {
  db.delete(sessions)
    .where(and(eq(sessions.memberId, memberId), eq(sessions.aal, 1)))
    .run();
}
