import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, lte } from 'drizzle-orm';
import { appendAudit } from '../db/audit.js';
import type { Db } from '../db/client.js';
import { getMember } from '../db/members.js';
import {
  predictionBets,
  predictionRounds,
  type PredictionBetRow,
  type PredictionRoundRow,
} from '../db/schema.js';
import { CANDLE_MS, compareDecimal, type Candle, type PriceSource } from '../market/price.js';
import { balanceOf, formatAmount, parseAmount, post } from './ledger.js';
import { splitPool } from './payouts.js';

/**
 * 5 分ごとの値動きの予想。BOAG を賭ける。画面からだけ遊べる。
 *
 * 決まり
 *   - 回は取引所の 5 分足 1 本に対応する。賭けられるのは次に始まる足で、
 *     始まる BET_CUTOFF_MS 前に締め切る。始値が分かった後には賭けられない
 *   - 足の終値が始値より上なら「上」、下なら「下」の勝ち。同じなら全員に返す
 *   - 配当はパリミュチュエル。負けた側の賭け金の合計を、勝った側で賭け金に比例して分ける。
 *     胴元は取らない。したがって預かった額と払い戻す額は常に等しく、赤字も黒字も出ない
 *   - 片側にしか賭けが無ければ、相手がいないので全員に返す
 *   - 足が取り寄せられないまま GIVE_UP_MS 過ぎたら、全員に返す
 *
 * 賭け金は台帳の特別口座 '@prediction' に預ける。決着したら同じ口座から払い戻す。
 * 決着の済んでいない回の賭け金の合計が、いつでもその口座の残高に一致する。
 */

export const ROUND_MS = CANDLE_MS;
/** 足が始まるこれだけ前に締め切る。時計のずれで始値を知ってから賭けられないように。 */
export const BET_CUTOFF_MS = 10_000;
/** 足が閉じてから取引所に確定値が載るまでの猶予。 */
export const SETTLE_GRACE_MS = 15_000;
/** 足が閉じてこれだけ経っても値が取れなければ、全員に返す。 */
export const GIVE_UP_MS = 30 * 60 * 1000;
/** 最低の賭け金。0.000001 BOAG。細かすぎると配当の端数が扱いにくい。 */
export const MIN_STAKE = 10n ** 10n;
export const ESCROW_ACCOUNT = '@prediction';

export type Side = 'up' | 'down';
export type PredictionFailure = { readonly ok: false; readonly reason: string };

export function roundId(symbol: string, startsAt: number): string {
  return `${symbol}:${String(startsAt)}`;
}

/** いま賭けられる回の開始時刻。 */
export function bettableStart(now: number): number {
  return Math.ceil((now + BET_CUTOFF_MS) / ROUND_MS) * ROUND_MS;
}

function ledgerRef(round: string): string {
  return `predict:${round}`;
}

export function getRound(db: Db, id: string): PredictionRoundRow | undefined {
  return db.select().from(predictionRounds).where(eq(predictionRounds.id, id)).get();
}

export function betsOf(db: Db, round: string): PredictionBetRow[] {
  return db
    .select()
    .from(predictionBets)
    .where(eq(predictionBets.roundId, round))
    .orderBy(asc(predictionBets.placedAt), asc(predictionBets.id))
    .all();
}

export interface Pools {
  readonly up: bigint;
  readonly down: bigint;
}

export function poolsOf(bets: readonly PredictionBetRow[]): Pools {
  let up = 0n;
  let down = 0n;
  for (const bet of bets) {
    if (bet.side === 'up') up += BigInt(bet.stake);
    else down += BigInt(bet.stake);
  }
  return { up, down };
}

export type PlaceBetResult =
  | { readonly ok: true; readonly bet: PredictionBetRow; readonly round: PredictionRoundRow }
  | PredictionFailure;

export function placeBet(
  db: Db,
  input: {
    readonly memberId: string;
    readonly symbol: string;
    readonly symbols: readonly string[];
    readonly side: string;
    readonly amount: string;
    /** 画面が表示していた回の開始時刻。締め切りを跨いだ送信を、次の回に回さず断るため。 */
    readonly startsAt: number;
    readonly now?: number;
  },
): PlaceBetResult {
  const now = input.now ?? Date.now();

  if (!input.symbols.includes(input.symbol)) return { ok: false, reason: '扱っていない銘柄です' };
  if (input.side !== 'up' && input.side !== 'down') {
    return { ok: false, reason: '上か下かを選んでください' };
  }
  const side: Side = input.side;

  const startsAt = bettableStart(now);
  if (input.startsAt !== startsAt) {
    return { ok: false, reason: 'その回は締め切られました。画面を読み込み直してください' };
  }

  const stake = parseAmount(input.amount);
  if (stake === undefined) {
    return { ok: false, reason: '賭け金は 0 より大きく、小数 16 桁までで入れてください' };
  }
  if (stake < MIN_STAKE) {
    return { ok: false, reason: `賭け金は ${formatAmount(MIN_STAKE)} BOAG 以上にしてください` };
  }

  return db.transaction((tx) => {
    const member = getMember(tx, input.memberId);
    if (member === undefined || member.status !== 'active') {
      return { ok: false, reason: '有効なメンバーだけが賭けられます' };
    }

    const id = roundId(input.symbol, startsAt);
    tx.insert(predictionRounds)
      .values({
        id,
        symbol: input.symbol,
        startsAt,
        endsAt: startsAt + ROUND_MS,
        status: 'open',
      })
      .onConflictDoNothing()
      .run();

    const round = getRound(tx, id);
    if (round === undefined || round.status !== 'open') {
      return { ok: false, reason: 'その回はもう賭けられません' };
    }

    // 両方に賭けても得にならず、表示が紛らわしいだけなので断る。
    const mine = betsOf(tx, id).filter((bet) => bet.memberId === input.memberId);
    if (mine.some((bet) => bet.side !== side)) {
      return { ok: false, reason: 'この回は反対側に賭けています。両方には賭けられません' };
    }

    const available = balanceOf(tx, input.memberId);
    if (available < stake) {
      return {
        ok: false,
        reason: `残高が足りません (残高 ${formatAmount(available)} BOAG)`,
      };
    }

    post(tx, {
      kind: 'transfer',
      ref: ledgerRef(id),
      memo: `予想 ${input.symbol} ${side === 'up' ? '上' : '下'}`,
      now,
      movements: [
        { accountId: input.memberId, amount: -stake },
        { accountId: ESCROW_ACCOUNT, amount: stake },
      ],
    });

    const bet: PredictionBetRow = {
      id: randomUUID(),
      roundId: id,
      memberId: input.memberId,
      side,
      stake: stake.toString(),
      payout: null,
      placedAt: now,
    };
    tx.insert(predictionBets).values(bet).run();

    return { ok: true, bet, round };
  });
}

/**
 * 配当を決める。純粋関数。
 *
 * 勝った側の各賭けに、賭け金 + 負けた側の合計 x 賭け金 / 勝った側の合計 (切り捨て) を払う。
 * 切り捨てで余った端数は、勝った側でいちばん早く賭けた人に足す。
 * これで払い戻しの合計は、預かった額の合計にちょうど一致する。
 */
export function computePayouts(
  bets: readonly PredictionBetRow[],
  outcome: 'up' | 'down' | 'flat',
): Map<string, bigint> {
  const stakes = bets.map((bet) => ({ id: bet.id, stake: BigInt(bet.stake) }));
  if (outcome === 'flat') return splitPool(stakes, new Set());
  return splitPool(stakes, new Set(bets.filter((bet) => bet.side === outcome).map((bet) => bet.id)));
}

export type SettleOutcome =
  | { readonly kind: 'settled'; readonly outcome: 'up' | 'down' | 'flat' }
  | { readonly kind: 'refunded' }
  | { readonly kind: 'waiting' };

/**
 * 1 回ぶんを決着させる。何度呼んでも 1 回しか払い戻さない。
 * candle が undefined なら、諦める時刻を過ぎていれば全員に返し、そうでなければ待つ。
 */
export function settleRound(
  db: Db,
  input: { readonly roundId: string; readonly candle: Candle | undefined; readonly now: number },
): SettleOutcome {
  return db.transaction((tx) => {
    const round = getRound(tx, input.roundId);
    if (round === undefined || round.status !== 'open') return { kind: 'waiting' };
    if (input.now < round.endsAt + SETTLE_GRACE_MS) return { kind: 'waiting' };

    const bets = betsOf(tx, round.id);
    const candle = input.candle;
    const usable =
      candle !== undefined && candle.openTime === round.startsAt && candle.closeTime < input.now;

    if (!usable) {
      if (input.now < round.endsAt + GIVE_UP_MS) return { kind: 'waiting' };
      pay(tx, round, bets, computePayouts(bets, 'flat'), input.now, '予想の返金 (値が取れず)');
      tx.update(predictionRounds)
        .set({ status: 'refunded', settledAt: input.now })
        .where(eq(predictionRounds.id, round.id))
        .run();
      appendAudit(tx, {
        at: input.now,
        actorMemberId: null,
        action: 'prediction.refunded',
        detail: { roundId: round.id, bets: bets.length },
      });
      return { kind: 'refunded' };
    }

    const order = compareDecimal(candle.close, candle.open);
    const outcome = order > 0 ? 'up' : order < 0 ? 'down' : 'flat';
    const payouts = computePayouts(bets, outcome);
    pay(tx, round, bets, payouts, input.now, '予想の払い戻し');

    tx.update(predictionRounds)
      .set({
        status: 'settled',
        openPrice: candle.open,
        closePrice: candle.close,
        outcome,
        settledAt: input.now,
      })
      .where(eq(predictionRounds.id, round.id))
      .run();

    const pools = poolsOf(bets);
    appendAudit(tx, {
      at: input.now,
      actorMemberId: null,
      action: 'prediction.settled',
      detail: {
        roundId: round.id,
        open: candle.open,
        close: candle.close,
        outcome,
        up: pools.up.toString(),
        down: pools.down.toString(),
      },
    });
    return { kind: 'settled', outcome };
  });
}

function pay(
  db: Db,
  round: PredictionRoundRow,
  bets: readonly PredictionBetRow[],
  payouts: ReadonlyMap<string, bigint>,
  now: number,
  memo: string,
): void {
  // 同じ人の複数の賭けは 1 行にまとめる。
  const perMember = new Map<string, bigint>();
  let total = 0n;
  for (const bet of bets) {
    const amount = payouts.get(bet.id) ?? 0n;
    db.update(predictionBets)
      .set({ payout: amount.toString() })
      .where(eq(predictionBets.id, bet.id))
      .run();
    if (amount === 0n) continue;
    perMember.set(bet.memberId, (perMember.get(bet.memberId) ?? 0n) + amount);
    total += amount;
  }
  if (total === 0n) return;

  post(db, {
    kind: 'transfer',
    ref: ledgerRef(round.id),
    memo,
    now,
    movements: [
      { accountId: ESCROW_ACCOUNT, amount: -total },
      ...[...perMember].map(([accountId, amount]) => ({ accountId, amount })),
    ],
  });
}

/** 決着を待っている回を片付ける。定期的に呼ぶ。 */
export async function settleDueRounds(
  db: Db,
  source: PriceSource,
  now = Date.now(),
): Promise<{ readonly settled: number; readonly refunded: number }> {
  const due = db
    .select()
    .from(predictionRounds)
    .where(
      and(eq(predictionRounds.status, 'open'), lte(predictionRounds.endsAt, now - SETTLE_GRACE_MS)),
    )
    .orderBy(asc(predictionRounds.endsAt))
    .all();

  let settled = 0;
  let refunded = 0;
  for (const round of due) {
    let candle: Candle | undefined;
    try {
      candle = await source.candle(round.symbol, round.startsAt);
    } catch {
      // 取引所に繋がらない。諦める時刻までは待つ。
      candle = undefined;
    }
    const result = settleRound(db, { roundId: round.id, candle, now });
    if (result.kind === 'settled') settled += 1;
    if (result.kind === 'refunded') refunded += 1;
  }
  return { settled, refunded };
}

export interface RoundView {
  readonly round: PredictionRoundRow;
  readonly pools: Pools;
  readonly bets: readonly PredictionBetRow[];
}

export function roundView(db: Db, id: string): RoundView | undefined {
  const round = getRound(db, id);
  if (round === undefined) return undefined;
  const bets = betsOf(db, id);
  return { round, pools: poolsOf(bets), bets };
}

export function recentRounds(db: Db, symbol: string, limit = 12): RoundView[] {
  return db
    .select()
    .from(predictionRounds)
    .where(eq(predictionRounds.symbol, symbol))
    .orderBy(desc(predictionRounds.startsAt))
    .limit(limit)
    .all()
    .map((round) => {
      const bets = betsOf(db, round.id);
      return { round, pools: poolsOf(bets), bets };
    });
}

/** 決着していない回の賭け金の合計。預かり口座の残高と一致しなければならない。 */
export function openStakeTotal(db: Db): bigint {
  const open = db
    .select()
    .from(predictionRounds)
    .where(eq(predictionRounds.status, 'open'))
    .all();
  return open.reduce(
    (sum, round) => sum + betsOf(db, round.id).reduce((s, bet) => s + BigInt(bet.stake), 0n),
    0n,
  );
}

/** 勝った側に 1 BOAG 賭けたら、いまの賭けの具合でいくら戻るか。表示用の目安。 */
export function impliedReturn(pools: Pools, side: Side): string | undefined {
  const win = side === 'up' ? pools.up : pools.down;
  const lose = side === 'up' ? pools.down : pools.up;
  if (win === 0n || lose === 0n) return undefined;
  // 小数 2 桁の倍率にする。
  const hundredths = ((win + lose) * 100n) / win;
  return `${(hundredths / 100n).toString()}.${(hundredths % 100n).toString().padStart(2, '0')}`;
}
