import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { tickets, type TicketRow } from '../db/schema.js';

/**
 * 加入リンクとパスワード再発行の引換券。
 *
 * 券そのもの（token）は発行時に一度だけ表示し、DB には sha256 しか残さない。
 * DB が漏れても券として使えないようにするため。
 */

export type TicketKind = TicketRow['kind'];
export type TicketStatus = TicketRow['status'];

export const DEFAULT_TICKET_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export interface IssueTicketInput {
  readonly kind: TicketKind;
  readonly memberId: string;
  readonly proposalId?: string | null;
  /** 承認待ちなら 'pending'、すぐ使えるなら 'active'。 */
  readonly status: TicketStatus;
  readonly now: number;
  readonly ttlMs?: number;
}

export interface IssuedTicket {
  readonly token: string;
  readonly id: string;
  readonly expiresAt: number;
}

export function issueTicket(db: Db, input: IssueTicketInput): IssuedTicket {
  const token = generateToken();
  const id = hashToken(token);
  const expiresAt = input.now + (input.ttlMs ?? DEFAULT_TICKET_TTL_MS);

  db.insert(tickets)
    .values({
      id,
      kind: input.kind,
      memberId: input.memberId,
      proposalId: input.proposalId ?? null,
      status: input.status,
      createdAt: input.now,
      expiresAt,
    })
    .run();

  return { token, id, expiresAt };
}

export type TicketLookup =
  | { readonly ok: true; readonly ticket: TicketRow }
  | { readonly ok: false; readonly reason: string };

/**
 * 券を引き当てる。使える状態でなければ理由を返す。
 *
 * 引き当てはハッシュの完全一致なので総当たりの余地はないが、
 * 万一の比較経路の差を消すため timingSafeEqual で突き合わせる。
 */
export function findUsableTicket(
  db: Db,
  kind: TicketKind,
  token: string,
  now: number,
): TicketLookup {
  const id = hashToken(token);
  const row = db
    .select()
    .from(tickets)
    .where(and(eq(tickets.id, id), eq(tickets.kind, kind)))
    .get();

  if (row === undefined) return { ok: false, reason: 'リンクが無効です' };

  const a = Buffer.from(row.id, 'hex');
  const b = Buffer.from(id, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'リンクが無効です' };
  }
  if (row.status === 'used') return { ok: false, reason: 'このリンクは既に使われています' };
  if (row.status === 'revoked') return { ok: false, reason: 'このリンクは取り消されています' };
  if (row.status === 'pending') {
    return { ok: false, reason: 'まだ承認されていません。承認が集まるまでお待ちください' };
  }
  if (now >= row.expiresAt) return { ok: false, reason: 'リンクの有効期限が切れています' };

  return { ok: true, ticket: row };
}

export function activateTicketsForProposal(db: Db, proposalId: string, now: number): number {
  const rows = db
    .select()
    .from(tickets)
    .where(and(eq(tickets.proposalId, proposalId), eq(tickets.status, 'pending')))
    .all();

  for (const row of rows) {
    // 承認までに時間がかかっても使えるよう、有効化した時点から期限を取り直す。
    db.update(tickets)
      .set({ status: 'active', expiresAt: now + DEFAULT_TICKET_TTL_MS })
      .where(eq(tickets.id, row.id))
      .run();
  }
  return rows.length;
}

export function revokeTicketsForProposal(db: Db, proposalId: string): void {
  db.update(tickets)
    .set({ status: 'revoked' })
    .where(and(eq(tickets.proposalId, proposalId), eq(tickets.status, 'pending')))
    .run();
}

export function consumeTicket(db: Db, id: string, now: number): void {
  db.update(tickets).set({ status: 'used', usedAt: now }).where(eq(tickets.id, id)).run();
}

/** 同じ用途の未使用の券を無効化する。再発行時に古いリンクを死なせるために使う。 */
export function revokeOpenTickets(db: Db, memberId: string, kind: TicketKind): void {
  const rows = db
    .select()
    .from(tickets)
    .where(and(eq(tickets.memberId, memberId), eq(tickets.kind, kind)))
    .all();

  for (const row of rows) {
    if (row.status === 'pending' || row.status === 'active') {
      db.update(tickets).set({ status: 'revoked' }).where(eq(tickets.id, row.id)).run();
    }
  }
}
