import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, lte } from 'drizzle-orm';
import { appendAudit } from '../db/audit.js';
import type { Db } from '../db/client.js';
import { getMember } from '../db/members.js';
import {
  exchangeDeposits,
  exchangeWithdrawals,
  type ExchangeDepositRow,
  type ExchangeWithdrawalRow,
} from '../db/schema.js';
import { EXCHANGE_ACCOUNT, balanceOf, formatAmount, post } from './ledger.js';
import { SOAG_PER_PT } from './units.js';

/**
 * 外部の bot の pt との交換。
 *
 *   10,000,000 pt = 1 BOAG   (1 pt = 10^9 SOAG)
 *
 * 入金 (相手 → こちら)
 *   相手が自分の側で pt を引いてから、こちらの API を呼ぶ。こちらは特別口座
 *   '@exchange' から本人へ BOAG を付ける。相手の取引番号で重複を見分けるので、
 *   相手は応答が落ちたら同じ番号で何度でも送り直してよい。
 *
 * 出金 (こちら → 相手)
 *   本人の BOAG を先に '@exchange' へ移し、出金の記録を作る (outbox)。
 *   届くまで同じ番号で送り続ける。相手がはっきり断ったときだけ返金する。
 *   届いたか分からない状態で返金すると、相手が pt を付けていた場合に二重になるため。
 *
 * '@exchange' の残高は「出した分 - 入った分」で、正にも負にもなる。
 */

export const EXCHANGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const PT_PATTERN = /^[1-9]\d{0,20}$/;

/** 出金を送り直す間隔の下限と上限。失敗するたびに倍にする。 */
export const RETRY_BASE_MS = 10_000;
export const RETRY_MAX_MS = 60 * 60 * 1000;
/** これだけ経っても届かない出金は、人が見るまで送るのを止める。 */
export const GIVE_UP_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
/** 送っている間に、別の巡回が同じ出金を拾わないようにする時間。 */
const LEASE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ExchangeLimits {
  /** 1 回の入金・出金の上限 (pt)。 */
  readonly maxPtPerRequest: bigint;
  /** 24 時間の入金の合計の上限 (pt)。秘密が漏れた場合の被害を抑える。 */
  readonly maxPtPerDay: bigint;
}

export type ExchangeErrorCode =
  | 'invalid_request'
  | 'member_not_found'
  | 'idempotency_conflict'
  | 'limit_exceeded'
  | 'insufficient_balance';

export type ExchangeFailure = {
  readonly ok: false;
  readonly code: ExchangeErrorCode;
  readonly message: string;
};

export function ptToSoag(pt: bigint): bigint {
  return pt * SOAG_PER_PT;
}

export function parsePt(raw: unknown): bigint | undefined {
  return typeof raw === 'string' && PT_PATTERN.test(raw) ? BigInt(raw) : undefined;
}

function depositHash(discordId: string, pt: bigint): string {
  return createHash('sha256').update(`${discordId}\n${pt.toString()}`).digest('hex');
}

// --- 入金 ---------------------------------------------------------------

export type CreditResult =
  | { readonly ok: true; readonly deposit: ExchangeDepositRow; readonly replayed: boolean }
  | ExchangeFailure;

export function creditDeposit(
  db: Db,
  input: {
    readonly id: unknown;
    readonly discordId: unknown;
    readonly pt: unknown;
    readonly limits: ExchangeLimits;
    readonly now?: number;
  },
): CreditResult {
  const now = input.now ?? Date.now();

  if (typeof input.id !== 'string' || !EXCHANGE_ID_PATTERN.test(input.id)) {
    return { ok: false, code: 'invalid_request', message: 'id は英数字と - _ で 1 から 64 文字' };
  }
  if (typeof input.discordId !== 'string' || !/^\d{17,20}$/.test(input.discordId)) {
    return { ok: false, code: 'invalid_request', message: 'discordId は 17 から 20 桁の数字の文字列' };
  }
  const pt = parsePt(input.pt);
  if (pt === undefined) {
    return { ok: false, code: 'invalid_request', message: 'pt は 1 以上の整数を 10 進の文字列で' };
  }
  const id = input.id;
  const discordId = input.discordId;
  const hash = depositHash(discordId, pt);

  return db.transaction((tx) => {
    // 同じ番号が既にあれば、中身が同じなら前と同じ結果を返す。
    const existing = tx.select().from(exchangeDeposits).where(eq(exchangeDeposits.id, id)).get();
    if (existing !== undefined) {
      if (existing.bodyHash !== hash) {
        return {
          ok: false,
          code: 'idempotency_conflict',
          message: 'この id は別の内容で使われています',
        };
      }
      return { ok: true, deposit: existing, replayed: true };
    }

    if (pt > input.limits.maxPtPerRequest) {
      return {
        ok: false,
        code: 'limit_exceeded',
        message: `1 回の上限は ${input.limits.maxPtPerRequest.toString()} pt です`,
      };
    }
    const recent = tx
      .select({ pt: exchangeDeposits.pt })
      .from(exchangeDeposits)
      .where(gt(exchangeDeposits.createdAt, now - DAY_MS))
      .all()
      .reduce((sum, row) => sum + BigInt(row.pt), 0n);
    if (recent + pt > input.limits.maxPtPerDay) {
      return {
        ok: false,
        code: 'limit_exceeded',
        message: `24 時間の入金の上限 ${input.limits.maxPtPerDay.toString()} pt を超えます`,
      };
    }

    const member = getMember(tx, discordId);
    if (member === undefined || member.status !== 'active') {
      return { ok: false, code: 'member_not_found', message: 'その Discord ID の有効なメンバーはいません' };
    }

    const soag = ptToSoag(pt);
    const ledgerTx = post(tx, {
      kind: 'exchange',
      ref: `exchange-in:${id}`,
      memo: `pt からの交換 ${pt.toString()} pt`,
      now,
      movements: [
        { accountId: EXCHANGE_ACCOUNT, amount: -soag },
        { accountId: member.id, amount: soag },
      ],
    });

    const deposit: ExchangeDepositRow = {
      id,
      memberId: member.id,
      pt: pt.toString(),
      soag: soag.toString(),
      bodyHash: hash,
      ledgerTx,
      createdAt: now,
    };
    tx.insert(exchangeDeposits).values(deposit).run();

    appendAudit(tx, {
      at: now,
      actorMemberId: null,
      action: 'exchange.deposit',
      detail: { id, memberId: member.id, pt: pt.toString() },
    });

    return { ok: true, deposit, replayed: false };
  });
}

export function getDeposit(db: Db, id: string): ExchangeDepositRow | undefined {
  return db.select().from(exchangeDeposits).where(eq(exchangeDeposits.id, id)).get();
}

// --- 出金 ---------------------------------------------------------------

export type WithdrawResult =
  | { readonly ok: true; readonly withdrawal: ExchangeWithdrawalRow }
  | ExchangeFailure;

export function requestWithdrawal(
  db: Db,
  input: {
    readonly memberId: string;
    readonly pt: string;
    readonly limits: ExchangeLimits;
    readonly now?: number;
  },
): WithdrawResult {
  const now = input.now ?? Date.now();
  const pt = parsePt(input.pt.trim().replace(/[,_\s]/g, ''));
  if (pt === undefined) {
    return { ok: false, code: 'invalid_request', message: 'pt は 1 以上の整数で入れてください' };
  }
  if (pt > input.limits.maxPtPerRequest) {
    return {
      ok: false,
      code: 'limit_exceeded',
      message: `1 回の上限は ${input.limits.maxPtPerRequest.toString()} pt です`,
    };
  }

  return db.transaction((tx) => {
    const member = getMember(tx, input.memberId);
    if (member === undefined || member.status !== 'active') {
      return { ok: false, code: 'member_not_found', message: '有効なメンバーだけが交換できます' };
    }

    const soag = ptToSoag(pt);
    const available = balanceOf(tx, member.id);
    if (available < soag) {
      return {
        ok: false,
        code: 'insufficient_balance',
        message: `残高が足りません (${pt.toString()} pt には ${formatAmount(soag)} BOAG 要ります)`,
      };
    }

    const id = randomUUID();
    post(tx, {
      kind: 'exchange',
      ref: `exchange-out:${id}`,
      memo: `pt への交換 ${pt.toString()} pt`,
      now,
      movements: [
        { accountId: member.id, amount: -soag },
        { accountId: EXCHANGE_ACCOUNT, amount: soag },
      ],
    });

    const withdrawal: ExchangeWithdrawalRow = {
      id,
      memberId: member.id,
      pt: pt.toString(),
      soag: soag.toString(),
      status: 'pending',
      attempts: 0,
      nextAttemptAt: now,
      lastError: null,
      lastStatus: null,
      createdAt: now,
      settledAt: null,
    };
    tx.insert(exchangeWithdrawals).values(withdrawal).run();

    appendAudit(tx, {
      at: now,
      actorMemberId: member.id,
      action: 'exchange.withdraw_requested',
      detail: { id, pt: pt.toString() },
    });

    return { ok: true, withdrawal };
  });
}

export type DeliveryOutcome =
  /** 相手が受け取った。 */
  | { readonly kind: 'delivered' }
  /** 相手がはっきり断った。返金してよい。 */
  | { readonly kind: 'rejected'; readonly status: number; readonly message: string }
  /** 同じ id で別の内容を受けていると言われた。人が見る必要がある。 */
  | { readonly kind: 'conflict'; readonly status: number; readonly message: string }
  /** 届いたか分からない、または相手が一時的に受けられない。後で送り直す。 */
  | { readonly kind: 'retry'; readonly status: number | null; readonly message: string };

export interface PartnerClient {
  deliver(withdrawal: {
    readonly id: string;
    readonly discordId: string;
    readonly pt: string;
    readonly requestedAt: number;
  }): Promise<DeliveryOutcome>;
}

export function retryDelay(attempts: number): number {
  const exponent = Math.min(Math.max(attempts - 1, 0), 20);
  return Math.min(RETRY_BASE_MS * 2 ** exponent, RETRY_MAX_MS);
}

function refund(db: Db, row: ExchangeWithdrawalRow, now: number, reason: string): void {
  db.transaction((tx) => {
    const current = tx.select().from(exchangeWithdrawals).where(eq(exchangeWithdrawals.id, row.id)).get();
    if (current === undefined || current.status !== 'pending') return;

    const soag = BigInt(current.soag);
    post(tx, {
      kind: 'exchange',
      ref: `exchange-out:${current.id}`,
      memo: `pt への交換の返金 ${current.pt} pt`,
      now,
      movements: [
        { accountId: EXCHANGE_ACCOUNT, amount: -soag },
        { accountId: current.memberId, amount: soag },
      ],
    });
    tx.update(exchangeWithdrawals)
      .set({ status: 'refunded', settledAt: now, lastError: reason })
      .where(eq(exchangeWithdrawals.id, current.id))
      .run();
    appendAudit(tx, {
      at: now,
      actorMemberId: null,
      action: 'exchange.withdraw_refunded',
      detail: { id: current.id, reason },
    });
  });
}

export interface DeliveryReport {
  readonly delivered: number;
  readonly refunded: number;
  readonly retrying: number;
  readonly stuck: number;
}

/** 送るべき出金を送る。定期的に呼ぶ。 */
export async function deliverDueWithdrawals(
  db: Db,
  client: PartnerClient,
  now = Date.now(),
  limit = 20,
): Promise<DeliveryReport> {
  const due = db
    .select()
    .from(exchangeWithdrawals)
    .where(and(eq(exchangeWithdrawals.status, 'pending'), lte(exchangeWithdrawals.nextAttemptAt, now)))
    .orderBy(asc(exchangeWithdrawals.nextAttemptAt))
    .limit(limit)
    .all();

  let delivered = 0;
  let refunded = 0;
  let retrying = 0;
  let stuck = 0;

  for (const row of due) {
    // 先に予約する。送っている間に別の巡回が同じものを拾わないように。
    db.update(exchangeWithdrawals)
      .set({ nextAttemptAt: now + LEASE_MS })
      .where(eq(exchangeWithdrawals.id, row.id))
      .run();

    let outcome: DeliveryOutcome;
    try {
      outcome = await client.deliver({
        id: row.id,
        discordId: row.memberId,
        pt: row.pt,
        requestedAt: row.createdAt,
      });
    } catch (error: unknown) {
      outcome = {
        kind: 'retry',
        status: null,
        message: error instanceof Error ? error.message : String(error),
      };
    }

    const attempts = row.attempts + 1;

    if (outcome.kind === 'delivered') {
      db.update(exchangeWithdrawals)
        .set({ status: 'delivered', attempts, settledAt: now, lastError: null, lastStatus: 200 })
        .where(eq(exchangeWithdrawals.id, row.id))
        .run();
      appendAudit(db, {
        at: now,
        actorMemberId: null,
        action: 'exchange.withdraw_delivered',
        detail: { id: row.id, attempts },
      });
      delivered += 1;
      continue;
    }

    if (outcome.kind === 'rejected') {
      db.update(exchangeWithdrawals)
        .set({ attempts, lastStatus: outcome.status })
        .where(eq(exchangeWithdrawals.id, row.id))
        .run();
      refund(db, row, now, `相手が断りました (${String(outcome.status)}): ${outcome.message}`);
      refunded += 1;
      continue;
    }

    const tooOld = now - row.createdAt >= GIVE_UP_AFTER_MS;
    if (outcome.kind === 'conflict' || tooOld) {
      db.update(exchangeWithdrawals)
        .set({
          status: 'stuck',
          attempts,
          lastStatus: outcome.status,
          lastError: outcome.kind === 'conflict' ? `id の衝突: ${outcome.message}` : outcome.message,
        })
        .where(eq(exchangeWithdrawals.id, row.id))
        .run();
      appendAudit(db, {
        at: now,
        actorMemberId: null,
        action: 'exchange.withdraw_stuck',
        detail: { id: row.id, attempts, reason: outcome.message },
      });
      stuck += 1;
      continue;
    }

    db.update(exchangeWithdrawals)
      .set({
        attempts,
        nextAttemptAt: now + retryDelay(attempts),
        lastStatus: outcome.status,
        lastError: outcome.message,
      })
      .where(eq(exchangeWithdrawals.id, row.id))
      .run();
    retrying += 1;
  }

  return { delivered, refunded, retrying, stuck };
}

/**
 * 止まった出金を、もう一度送る列に戻す。同じ id で送るので、相手が受けていれば二重にならない。
 * 期限を過ぎて止まったものは、戻しても 1 回送って届かなければまた止まる。
 */
export function requeueWithdrawal(
  db: Db,
  input: { readonly id: string; readonly memberId: string; readonly now?: number },
): { readonly ok: true } | ExchangeFailure {
  const now = input.now ?? Date.now();
  const row = db.select().from(exchangeWithdrawals).where(eq(exchangeWithdrawals.id, input.id)).get();
  if (row === undefined || row.memberId !== input.memberId || row.status !== 'stuck') {
    return { ok: false, code: 'invalid_request', message: '送り直せる出金ではありません' };
  }
  db.update(exchangeWithdrawals)
    .set({ status: 'pending', nextAttemptAt: now })
    .where(eq(exchangeWithdrawals.id, row.id))
    .run();
  appendAudit(db, {
    at: now,
    actorMemberId: input.memberId,
    action: 'exchange.withdraw_requeued',
    detail: { id: row.id },
  });
  return { ok: true };
}

export function listWithdrawals(db: Db, memberId: string, limit = 20): ExchangeWithdrawalRow[] {
  return db
    .select()
    .from(exchangeWithdrawals)
    .where(eq(exchangeWithdrawals.memberId, memberId))
    .orderBy(desc(exchangeWithdrawals.createdAt))
    .limit(limit)
    .all();
}

export function listDeposits(db: Db, memberId: string, limit = 20): ExchangeDepositRow[] {
  return db
    .select()
    .from(exchangeDeposits)
    .where(eq(exchangeDeposits.memberId, memberId))
    .orderBy(desc(exchangeDeposits.createdAt))
    .limit(limit)
    .all();
}
