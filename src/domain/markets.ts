import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, lte } from 'drizzle-orm';
import { appendAudit } from '../db/audit.js';
import type { Db } from '../db/client.js';
import { getMember } from '../db/members.js';
import { marketBets, markets, proposals, type MarketBetRow, type MarketRow } from '../db/schema.js';
import { balanceOf, formatAmount, parseAmount, post } from './ledger.js';
import { splitPool } from './payouts.js';
import { MIN_STAKE } from './prediction.js';

/**
 * みんなで予想。メンバーが「はい / いいえ」で答えの出る問いを出し、BOAG を賭ける。
 *
 * 問いを開くのも、答えを決めるのも、過半数の提案を通す (market.open / market.resolve)。
 * 誰か 1 人が勝手に問いを立てたり、自分に都合よく判定したりできないようにするため。
 *
 *   - 賭けられるのは締め切りまで。同じ問いで「はい」と「いいえ」の両方には賭けられない
 *   - 判定の提案は締め切りの後にだけ出せる。「無効」と判定すれば全員に返す
 *   - 配当はパリミュチュエル。当てた側で外した側の賭け金を分ける。胴元は取らない
 *   - 締め切りから STALE_AFTER_MS 経っても判定が決まらなければ、全員に返す
 *
 * 賭け金は台帳の特別口座 '@markets' に預ける。
 */

export const MARKETS_ESCROW = '@markets';
export const QUESTION_MAX = 200;
export const CRITERIA_MAX = 1000;
/** 提案した時点から、締め切りまでこれだけは空ける。 */
export const MIN_OPEN_MS = 60 * 60 * 1000;
/** 締め切りはこれより先にはできない。 */
export const MAX_OPEN_MS = 366 * 24 * 60 * 60 * 1000;
/** 締め切りからこれだけ判定が決まらなければ、全員に返す。 */
export const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export type MarketSide = 'yes' | 'no';
export type MarketVerdict = MarketSide | 'void';
export type MarketFailure = { readonly ok: false; readonly reason: string };

export const VERDICT_LABELS: Readonly<Record<MarketVerdict, string>> = {
  yes: 'はい',
  no: 'いいえ',
  void: '無効',
};

export interface MarketOpenPayload {
  readonly question: string;
  readonly criteria: string;
  /** 締め切り (ミリ秒)。 */
  readonly closesAt: number;
}

export interface MarketResolvePayload {
  readonly marketId: string;
  /** 通知と一覧で読めるように、問いの文も写しておく。 */
  readonly question: string;
  readonly outcome: MarketVerdict;
}

function ledgerRef(marketId: string): string {
  return `market:${marketId}`;
}

// --- 提案の検査 -----------------------------------------------------------

export function validateMarketOpen(
  payload: Record<string, unknown>,
  now: number,
): MarketOpenPayload | MarketFailure {
  const question = typeof payload['question'] === 'string' ? payload['question'].trim() : '';
  const criteria = typeof payload['criteria'] === 'string' ? payload['criteria'].trim() : '';
  const closesAt = payload['closesAt'];

  if (question === '') return { ok: false, reason: '問いを入れてください' };
  if ([...question].length > QUESTION_MAX) {
    return { ok: false, reason: `問いは ${String(QUESTION_MAX)} 文字までです` };
  }
  if ([...criteria].length > CRITERIA_MAX) {
    return { ok: false, reason: `判定の基準は ${String(CRITERIA_MAX)} 文字までです` };
  }
  if (typeof closesAt !== 'number' || !Number.isSafeInteger(closesAt)) {
    return { ok: false, reason: '締め切りの日時が読めません' };
  }
  if (closesAt < now + MIN_OPEN_MS) {
    return { ok: false, reason: '締め切りは今から 1 時間以上先にしてください' };
  }
  if (closesAt > now + MAX_OPEN_MS) {
    return { ok: false, reason: '締め切りは 1 年以内にしてください' };
  }
  return { question, criteria, closesAt };
}

/** 判定の提案がすでに出ている問いか。同じ問いに判定が並ぶと、どれが効くのか分かりにくい。 */
function hasOpenResolution(db: Db, marketId: string): boolean {
  return db
    .select()
    .from(proposals)
    .where(and(eq(proposals.status, 'open'), eq(proposals.type, 'market.resolve')))
    .all()
    .some((row) => {
      try {
        const value: unknown = JSON.parse(row.payload);
        return (
          typeof value === 'object' &&
          value !== null &&
          (value as Record<string, unknown>)['marketId'] === marketId
        );
      } catch {
        return false;
      }
    });
}

export function validateMarketResolve(
  db: Db,
  payload: Record<string, unknown>,
  now: number,
): MarketResolvePayload | MarketFailure {
  const marketId = typeof payload['marketId'] === 'string' ? payload['marketId'] : '';
  const outcome = payload['outcome'];
  const market = getMarket(db, marketId);

  if (market === undefined) return { ok: false, reason: '問いが見つかりません' };
  if (market.status !== 'open') return { ok: false, reason: 'この問いはもう決着しています' };
  if (now < market.closesAt) return { ok: false, reason: '締め切りの後でなければ判定できません' };
  if (outcome !== 'yes' && outcome !== 'no' && outcome !== 'void') {
    return { ok: false, reason: 'はい、いいえ、無効のどれかを選んでください' };
  }
  if (hasOpenResolution(db, marketId)) {
    return { ok: false, reason: 'この問いにはもう判定の提案が出ています。そちらに投票してください' };
  }
  return { marketId, question: market.question, outcome };
}

// --- 提案の実行 -----------------------------------------------------------

/** 可決した market.open を適用する。提案のトランザクションの中で動く。 */
export function openMarket(
  db: Db,
  input: {
    readonly proposalId: string;
    readonly payload: MarketOpenPayload;
    readonly createdBy: string | null;
    readonly now: number;
  },
): MarketRow {
  // 可決までに締め切りを過ぎていたら、誰も賭けられないので最初から閉じておく。
  const expired = input.payload.closesAt <= input.now;
  const row: MarketRow = {
    id: randomUUID(),
    proposalId: input.proposalId,
    question: input.payload.question,
    criteria: input.payload.criteria,
    closesAt: input.payload.closesAt,
    status: expired ? 'refunded' : 'open',
    outcome: null,
    createdBy: input.createdBy,
    createdAt: input.now,
    resolvedAt: expired ? input.now : null,
    resolvedByProposal: null,
  };
  db.insert(markets).values(row).run();
  appendAudit(db, {
    at: input.now,
    actorMemberId: null,
    action: 'market.open',
    detail: { marketId: row.id, proposalId: input.proposalId, closesAt: row.closesAt, expired },
  });
  return row;
}

/**
 * 可決した market.resolve を適用する。提案のトランザクションの中で動く。
 * 問いがもう決着していれば何もしない (期限切れの返金が先に済んだ場合など)。
 */
export function resolveMarket(
  db: Db,
  input: { readonly proposalId: string | null; readonly payload: MarketResolvePayload; readonly now: number },
): void {
  const market = getMarket(db, input.payload.marketId);
  if (market?.status !== 'open') {
    appendAudit(db, {
      at: input.now,
      actorMemberId: null,
      action: 'market.resolve_skipped',
      detail: { marketId: input.payload.marketId, proposalId: input.proposalId },
    });
    return;
  }

  const bets = betsOf(db, market.id);
  const stakes = bets.map((bet) => ({ id: bet.id, stake: BigInt(bet.stake) }));
  const verdict = input.payload.outcome;
  const payouts =
    verdict === 'void'
      ? splitPool(stakes, new Set())
      : splitPool(stakes, new Set(bets.filter((bet) => bet.side === verdict).map((bet) => bet.id)));

  pay(db, market, bets, payouts, input.now, verdict === 'void' ? 'みんなで予想の返金' : 'みんなで予想の払い戻し');

  db.update(markets)
    .set({
      status: verdict === 'void' ? 'refunded' : 'resolved',
      outcome: verdict === 'void' ? null : verdict,
      resolvedAt: input.now,
      resolvedByProposal: input.proposalId,
    })
    .where(eq(markets.id, market.id))
    .run();

  appendAudit(db, {
    at: input.now,
    actorMemberId: null,
    action: 'market.resolved',
    detail: { marketId: market.id, proposalId: input.proposalId, outcome: verdict, bets: bets.length },
  });
}

function pay(
  db: Db,
  market: MarketRow,
  bets: readonly MarketBetRow[],
  payouts: ReadonlyMap<string, bigint>,
  now: number,
  memo: string,
): void {
  const perMember = new Map<string, bigint>();
  let total = 0n;
  for (const bet of bets) {
    const amount = payouts.get(bet.id) ?? 0n;
    db.update(marketBets).set({ payout: amount.toString() }).where(eq(marketBets.id, bet.id)).run();
    if (amount === 0n) continue;
    perMember.set(bet.memberId, (perMember.get(bet.memberId) ?? 0n) + amount);
    total += amount;
  }
  if (total === 0n) return;

  post(db, {
    kind: 'transfer',
    ref: ledgerRef(market.id),
    memo,
    now,
    movements: [
      { accountId: MARKETS_ESCROW, amount: -total },
      ...[...perMember].map(([accountId, amount]) => ({ accountId, amount })),
    ],
  });
}

/** 締め切りから長く判定の決まらない問いを、全員に返して閉じる。定期的に呼ぶ。 */
export function refundStaleMarkets(db: Db, now = Date.now()): number {
  const stale = db
    .select()
    .from(markets)
    .where(and(eq(markets.status, 'open'), lte(markets.closesAt, now - STALE_AFTER_MS)))
    .all();
  for (const market of stale) {
    db.transaction((tx) => {
      resolveMarket(tx, {
        proposalId: null,
        payload: { marketId: market.id, question: market.question, outcome: 'void' },
        now,
      });
    });
  }
  return stale.length;
}

// --- 賭け -----------------------------------------------------------------

export type MarketBetResult =
  | { readonly ok: true; readonly bet: MarketBetRow }
  | MarketFailure;

export function placeMarketBet(
  db: Db,
  input: {
    readonly marketId: string;
    readonly memberId: string;
    readonly side: string;
    readonly amount: string;
    readonly now?: number;
  },
): MarketBetResult {
  const now = input.now ?? Date.now();
  if (input.side !== 'yes' && input.side !== 'no') {
    return { ok: false, reason: 'はいか、いいえを選んでください' };
  }
  const side: MarketSide = input.side;

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

    const market = getMarket(tx, input.marketId);
    if (market === undefined) return { ok: false, reason: '問いが見つかりません' };
    if (market.status !== 'open' || now >= market.closesAt) {
      return { ok: false, reason: 'この問いは締め切られました' };
    }

    const mine = betsOf(tx, market.id).filter((bet) => bet.memberId === input.memberId);
    if (mine.some((bet) => bet.side !== side)) {
      return { ok: false, reason: '反対側に賭けています。両方には賭けられません' };
    }

    const available = balanceOf(tx, input.memberId);
    if (available < stake) {
      return { ok: false, reason: `残高が足りません (残高 ${formatAmount(available)} BOAG)` };
    }

    post(tx, {
      kind: 'transfer',
      ref: ledgerRef(market.id),
      memo: `みんなで予想 ${VERDICT_LABELS[side]}`,
      now,
      movements: [
        { accountId: input.memberId, amount: -stake },
        { accountId: MARKETS_ESCROW, amount: stake },
      ],
    });

    const bet: MarketBetRow = {
      id: randomUUID(),
      marketId: market.id,
      memberId: input.memberId,
      side,
      stake: stake.toString(),
      payout: null,
      placedAt: now,
    };
    tx.insert(marketBets).values(bet).run();
    return { ok: true, bet };
  });
}

// --- 読み取り -------------------------------------------------------------

export function getMarket(db: Db, id: string): MarketRow | undefined {
  return db.select().from(markets).where(eq(markets.id, id)).get();
}

export function betsOf(db: Db, marketId: string): MarketBetRow[] {
  return db
    .select()
    .from(marketBets)
    .where(eq(marketBets.marketId, marketId))
    .orderBy(asc(marketBets.placedAt), asc(marketBets.id))
    .all();
}

export interface MarketView {
  readonly market: MarketRow;
  readonly bets: readonly MarketBetRow[];
  readonly yes: bigint;
  readonly no: bigint;
}

function toView(db: Db, market: MarketRow): MarketView {
  const bets = betsOf(db, market.id);
  let yes = 0n;
  let no = 0n;
  for (const bet of bets) {
    if (bet.side === 'yes') yes += BigInt(bet.stake);
    else no += BigInt(bet.stake);
  }
  return { market, bets, yes, no };
}

export function marketView(db: Db, id: string): MarketView | undefined {
  const market = getMarket(db, id);
  return market === undefined ? undefined : toView(db, market);
}

export function listMarkets(db: Db, limit = 100): MarketView[] {
  return db
    .select()
    .from(markets)
    .orderBy(desc(markets.createdAt))
    .limit(limit)
    .all()
    .map((market) => toView(db, market));
}

/** 当たった側に 1 BOAG 賭けたら、いまの賭けの具合でいくら戻るか。表示用の目安。 */
export function marketImpliedReturn(view: MarketView, side: MarketSide): string | undefined {
  const win = side === 'yes' ? view.yes : view.no;
  const lose = side === 'yes' ? view.no : view.yes;
  if (win === 0n || lose === 0n) return undefined;
  const hundredths = ((win + lose) * 100n) / win;
  return `${(hundredths / 100n).toString()}.${(hundredths % 100n).toString().padStart(2, '0')}`;
}

/** 決着していない問いの賭け金の合計。預かり口座の残高と一致しなければならない。 */
export function openMarketStakeTotal(db: Db): bigint {
  return db
    .select()
    .from(markets)
    .where(eq(markets.status, 'open'))
    .all()
    .reduce((sum, market) => sum + betsOf(db, market.id).reduce((s, bet) => s + BigInt(bet.stake), 0n), 0n);
}
