import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, lte } from 'drizzle-orm';
import { appendAudit } from '../db/audit.js';
import type { Db } from '../db/client.js';
import { getMember } from '../db/members.js';
import { gameEntries, gameRounds, type GameEntryRow, type GameRoundRow } from '../db/schema.js';
import { HOUR_MS, scaleDecimals, type Candle, type PriceSource } from '../market/price.js';
import { balanceOf, formatAmount, parseAmount, post } from './ledger.js';
import { closestTakesAll, splitPool } from './payouts.js';
import { BET_CUTOFF_MS, GIVE_UP_MS, MIN_STAKE, SETTLE_GRACE_MS } from './prediction.js';

/**
 * 1 時間ごとの 3 つの予想。BOAG を賭ける。画面からだけ遊べる。
 *
 * 終値予想 (closest)
 *   次の 1 時間足の終値を数字で当てる。いちばん近かった人が、負けた人の賭け金を取る。
 *   取れる額は 1 人の負けにつき自分の賭け金まで (payouts.ts の closestTakesAll)。
 *   締め切りまで他の人の予想は見せない。後から少しずらして置く遊び方を防ぐため。
 *
 * 順位予想 (ranking)
 *   次の 1 時間でいちばん伸びる銘柄を当てる。伸びは (終値 / 始値) で比べる。
 *   当てた人で、外した人の賭け金を賭け金に比例して分ける (パリミュチュエル)。
 *   伸びが同じ銘柄が並んだら、どれに賭けていても当たり。
 *
 * 値幅予想 (volatility)
 *   次の 1 時間足の値幅 (高値 - 安値) / 始値 が、どの帯に入るかを当てる。
 *   上がるか下がるかは問わない。当てた人で、外した人の賭け金を比例で分ける。
 *
 * どちらも 1 回に 1 人 1 つ。締め切りと決着の待ち方は 5 分の予想と同じ。
 * 賭け金は台帳の特別口座 '@games' に預け、決着したらそこから払い戻す。
 */

export type Game = 'closest' | 'ranking' | 'volatility';

export const GAME_ROUND_MS = HOUR_MS;
export const GAMES_ESCROW = '@games';

/** 予想する値段の形。整数 12 桁、小数 8 桁まで。 */
const PRICE_PATTERN = /^(0|[1-9]\d{0,11})(\.\d{1,8})?$/;

export type GameFailure = { readonly ok: false; readonly reason: string };

export const GAME_LABELS: Readonly<Record<Game, string>> = {
  closest: '終値予想',
  ranking: '順位予想',
  volatility: '値幅予想',
};

export function gameRoundId(game: Game, subject: string, startsAt: number): string {
  return game === 'ranking' ? `ranking:${String(startsAt)}` : `${game}:${subject}:${String(startsAt)}`;
}

export interface VolatilityBand {
  readonly key: string;
  readonly label: string;
  /** 下の境目 (1/100 %)。この値を含む。 */
  readonly fromBp: number;
  /** 上の境目 (1/100 %)。この値を含まない。無ければ上限なし。 */
  readonly toBp?: number;
}

/** 値幅の帯。BTC や ETH の 1 時間足で、どの帯にもそこそこ入るように刻んである。 */
export const VOLATILITY_BANDS: readonly VolatilityBand[] = [
  { key: '0-0.5', label: '0.5% 未満', fromBp: 0, toBp: 50 },
  { key: '0.5-1', label: '0.5% から 1% 未満', fromBp: 50, toBp: 100 },
  { key: '1-1.5', label: '1% から 1.5% 未満', fromBp: 100, toBp: 150 },
  { key: '1.5-2.5', label: '1.5% から 2.5% 未満', fromBp: 150, toBp: 250 },
  { key: '2.5-', label: '2.5% 以上', fromBp: 250 },
];

export function bandLabel(key: string): string {
  return VOLATILITY_BANDS.find((band) => band.key === key)?.label ?? key;
}

/**
 * 足の値幅が入る帯。(高値 - 安値) / 始値 を、割り算をせず掛け算で境目と比べる。
 * 境目ちょうどは上の帯に入る。
 */
export function volatilityBand(candle: { readonly open: string; readonly high: string; readonly low: string }): string {
  const [open = 0n, high = 0n, low = 0n] = scaleDecimals([candle.open, candle.high, candle.low]).values;
  const range = (high - low) * 10_000n;
  let found = VOLATILITY_BANDS[0]?.key ?? '';
  for (const band of VOLATILITY_BANDS) {
    if (range >= BigInt(band.fromBp) * open) found = band.key;
  }
  return found;
}

/** 値幅を小数 2 桁のパーセントにする。表示用。 */
export function formatRange(candle: { readonly open: string; readonly high: string; readonly low: string }): string {
  const [open = 0n, high = 0n, low = 0n] = scaleDecimals([candle.open, candle.high, candle.low]).values;
  if (open === 0n) return '-';
  const hundredths = ((high - low) * 10_000n) / open;
  return `${(hundredths / 100n).toString()}.${(hundredths % 100n).toString().padStart(2, '0')}%`;
}

/** いま賭けられる回の開始時刻。 */
export function gameBettableStart(now: number): number {
  return Math.ceil((now + BET_CUTOFF_MS) / GAME_ROUND_MS) * GAME_ROUND_MS;
}

function ledgerRef(round: string): string {
  return `game:${round}`;
}

export function getGameRound(db: Db, id: string): GameRoundRow | undefined {
  return db.select().from(gameRounds).where(eq(gameRounds.id, id)).get();
}

export function entriesOf(db: Db, round: string): GameEntryRow[] {
  return db
    .select()
    .from(gameEntries)
    .where(eq(gameEntries.roundId, round))
    .orderBy(asc(gameEntries.placedAt), asc(gameEntries.id))
    .all();
}

/** 順位予想で比べる銘柄。 */
export function rankingSymbolsOf(round: GameRoundRow): string[] {
  return round.subject.split(',');
}

/** 決着に要る足の銘柄。 */
function symbolsOf(round: GameRoundRow): string[] {
  return round.game === 'ranking' ? rankingSymbolsOf(round) : [round.subject];
}

export type EnterResult =
  | { readonly ok: true; readonly entry: GameEntryRow; readonly round: GameRoundRow }
  | GameFailure;

interface EnterInput {
  readonly memberId: string;
  readonly amount: string;
  /** 画面が表示していた回の開始時刻。締め切りを跨いだ送信を、次の回に回さず断るため。 */
  readonly startsAt: number;
  readonly now?: number;
}

function enter(
  db: Db,
  input: EnterInput & { readonly game: Game; readonly subject: string; readonly pick: string },
  checkPick: (round: GameRoundRow) => string | undefined,
): EnterResult {
  const now = input.now ?? Date.now();

  const startsAt = gameBettableStart(now);
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

    const id = gameRoundId(input.game, input.subject, startsAt);
    tx.insert(gameRounds)
      .values({
        id,
        game: input.game,
        subject: input.subject,
        startsAt,
        endsAt: startsAt + GAME_ROUND_MS,
        status: 'open',
      })
      .onConflictDoNothing()
      .run();

    const round = getGameRound(tx, id);
    if (round === undefined || round.status !== 'open') {
      return { ok: false, reason: 'その回はもう賭けられません' };
    }

    const problem = checkPick(round);
    if (problem !== undefined) return { ok: false, reason: problem };

    if (entriesOf(tx, id).some((entry) => entry.memberId === input.memberId)) {
      return { ok: false, reason: 'この回にはもう参加しています。1 回に 1 つだけです' };
    }

    const available = balanceOf(tx, input.memberId);
    if (available < stake) {
      return { ok: false, reason: `残高が足りません (残高 ${formatAmount(available)} BOAG)` };
    }

    post(tx, {
      kind: 'transfer',
      ref: ledgerRef(id),
      memo: `${GAME_LABELS[input.game]}${input.game === 'ranking' ? '' : ` ${input.subject}`}`,
      now,
      movements: [
        { accountId: input.memberId, amount: -stake },
        { accountId: GAMES_ESCROW, amount: stake },
      ],
    });

    const entry: GameEntryRow = {
      id: randomUUID(),
      roundId: id,
      memberId: input.memberId,
      pick: input.pick,
      stake: stake.toString(),
      payout: null,
      placedAt: now,
    };
    tx.insert(gameEntries).values(entry).run();
    return { ok: true, entry, round };
  });
}

/** 終値予想に参加する。 */
export function enterClosest(
  db: Db,
  input: EnterInput & {
    readonly symbol: string;
    readonly symbols: readonly string[];
    readonly price: string;
  },
): EnterResult {
  if (!input.symbols.includes(input.symbol)) return { ok: false, reason: '扱っていない銘柄です' };
  const price = input.price.trim();
  if (!PRICE_PATTERN.test(price) || /^0(\.0+)?$/.test(price)) {
    return { ok: false, reason: '値段は 0 より大きい数で、小数 8 桁までで入れてください' };
  }
  return enter(db, { ...input, game: 'closest', subject: input.symbol, pick: price }, () => undefined);
}

/** 順位予想に参加する。 */
export function enterRanking(
  db: Db,
  input: EnterInput & { readonly symbols: readonly string[]; readonly pick: string },
): EnterResult {
  if (input.symbols.length < 2) return { ok: false, reason: '順位予想は止めてあります' };
  return enter(
    db,
    { ...input, game: 'ranking', subject: input.symbols.join(','), pick: input.pick },
    // 設定を途中で変えても、回が作られたときの銘柄で受け付ける。
    (round) => (rankingSymbolsOf(round).includes(input.pick) ? undefined : '比べていない銘柄です'),
  );
}

/** 値幅予想に参加する。 */
export function enterVolatility(
  db: Db,
  input: EnterInput & {
    readonly symbol: string;
    readonly symbols: readonly string[];
    readonly band: string;
  },
): EnterResult {
  if (!input.symbols.includes(input.symbol)) return { ok: false, reason: '扱っていない銘柄です' };
  if (!VOLATILITY_BANDS.some((band) => band.key === input.band)) {
    return { ok: false, reason: '値幅の帯を選んでください' };
  }
  return enter(db, { ...input, game: 'volatility', subject: input.symbol, pick: input.band }, () => undefined);
}

// --- 決着 -----------------------------------------------------------------

export interface GameResult {
  /** 終値予想の答え。 */
  readonly close?: string;
  /** 順位予想の各銘柄の始値と終値。 */
  readonly candles?: readonly { readonly symbol: string; readonly open: string; readonly close: string }[];
  /** 順位予想でいちばん伸びた銘柄。並んだら複数。 */
  readonly winners?: readonly string[];
  /** 値幅予想の足と、入った帯。 */
  readonly open?: string;
  readonly high?: string;
  readonly low?: string;
  readonly band?: string;
  readonly reason?: string;
}

export function resultOf(round: GameRoundRow): GameResult {
  if (round.result === null) return {};
  try {
    const value: unknown = JSON.parse(round.result);
    return typeof value === 'object' && value !== null ? value : {};
  } catch {
    return {};
  }
}

/** 予想した値段と答えの差。小数の桁をそろえた整数で返す。 */
export function closestErrors(entries: readonly GameEntryRow[], close: string): bigint[] {
  const scaled = scaleDecimals([close, ...entries.map((entry) => entry.pick)]).values;
  const answer = scaled[0] ?? 0n;
  return entries.map((_, index) => {
    const diff = (scaled[index + 1] ?? 0n) - answer;
    return diff < 0n ? -diff : diff;
  });
}

/** いちばん伸びた銘柄。伸びは終値 / 始値で、割り算をせず掛け算で比べる。 */
export function bestPerformers(
  candles: readonly { readonly symbol: string; readonly open: string; readonly close: string }[],
): string[] {
  const scaled = scaleDecimals(candles.flatMap((candle) => [candle.open, candle.close])).values;
  const rows = candles.map((candle, index) => ({
    symbol: candle.symbol,
    open: scaled[index * 2] ?? 0n,
    close: scaled[index * 2 + 1] ?? 0n,
  }));
  let best: (typeof rows)[number] | undefined;
  let winners: string[] = [];
  for (const row of rows) {
    if (row.open <= 0n) continue;
    if (best === undefined) {
      best = row;
      winners = [row.symbol];
      continue;
    }
    const left = row.close * best.open;
    const right = best.close * row.open;
    if (left > right) {
      best = row;
      winners = [row.symbol];
    } else if (left === right) {
      winners.push(row.symbol);
    }
  }
  return winners;
}

export type GameSettleOutcome =
  | { readonly kind: 'settled' }
  | { readonly kind: 'refunded' }
  | { readonly kind: 'waiting' };

/**
 * 1 回ぶんを決着させる。何度呼んでも 1 回しか払い戻さない。
 * 足が揃わなければ、諦める時刻を過ぎていれば全員に返し、そうでなければ待つ。
 */
export function settleGameRound(
  db: Db,
  input: {
    readonly roundId: string;
    readonly candles: ReadonlyMap<string, Candle | undefined>;
    readonly now: number;
  },
): GameSettleOutcome {
  return db.transaction((tx) => {
    const round = getGameRound(tx, input.roundId);
    if (round === undefined || round.status !== 'open') return { kind: 'waiting' };
    if (input.now < round.endsAt + SETTLE_GRACE_MS) return { kind: 'waiting' };

    const entries = entriesOf(tx, round.id);
    const symbols = symbolsOf(round);
    const candles: Candle[] = [];
    for (const symbol of symbols) {
      const candle = input.candles.get(symbol);
      if (candle?.openTime === round.startsAt && candle.closeTime < input.now) candles.push(candle);
    }

    if (candles.length !== symbols.length) {
      if (input.now < round.endsAt + GIVE_UP_MS) return { kind: 'waiting' };
      const refunds = new Map(entries.map((entry) => [entry.id, BigInt(entry.stake)]));
      pay(tx, round, entries, refunds, input.now, '予想の返金 (値が取れず)');
      finish(tx, round, 'refunded', { reason: 'no-price' }, input.now, entries.length);
      return { kind: 'refunded' };
    }

    const stakes = entries.map((entry) => ({ id: entry.id, stake: BigInt(entry.stake) }));
    let payouts: Map<string, bigint>;
    let result: GameResult;

    if (round.game === 'closest') {
      const close = candles[0]?.close ?? '0';
      const errors = closestErrors(entries, close);
      payouts = closestTakesAll(stakes.map((entry, index) => ({ ...entry, error: errors[index] ?? 0n })));
      result = { close };
    } else if (round.game === 'volatility') {
      const candle = candles[0] ?? { open: '0', high: '0', low: '0', close: '0' };
      const band = volatilityBand(candle);
      payouts = splitPool(
        stakes,
        new Set(entries.filter((entry) => entry.pick === band).map((entry) => entry.id)),
      );
      result = { open: candle.open, high: candle.high, low: candle.low, close: candle.close, band };
    } else {
      const rows = symbols.map((symbol, index) => ({
        symbol,
        open: candles[index]?.open ?? '0',
        close: candles[index]?.close ?? '0',
      }));
      const winners = bestPerformers(rows);
      payouts = splitPool(
        stakes,
        new Set(entries.filter((entry) => winners.includes(entry.pick)).map((entry) => entry.id)),
      );
      result = { candles: rows, winners };
    }

    pay(tx, round, entries, payouts, input.now, `${GAME_LABELS[round.game]}の払い戻し`);
    finish(tx, round, 'settled', result, input.now, entries.length);
    return { kind: 'settled' };
  });
}

function finish(
  db: Db,
  round: GameRoundRow,
  status: 'settled' | 'refunded',
  result: GameResult,
  now: number,
  entries: number,
): void {
  db.update(gameRounds)
    .set({ status, result: JSON.stringify(result), settledAt: now })
    .where(eq(gameRounds.id, round.id))
    .run();
  appendAudit(db, {
    at: now,
    actorMemberId: null,
    action: `game.${status}`,
    detail: { roundId: round.id, entries, ...result },
  });
}

function pay(
  db: Db,
  round: GameRoundRow,
  entries: readonly GameEntryRow[],
  payouts: ReadonlyMap<string, bigint>,
  now: number,
  memo: string,
): void {
  const perMember = new Map<string, bigint>();
  let total = 0n;
  for (const entry of entries) {
    const amount = payouts.get(entry.id) ?? 0n;
    db.update(gameEntries)
      .set({ payout: amount.toString() })
      .where(eq(gameEntries.id, entry.id))
      .run();
    if (amount === 0n) continue;
    perMember.set(entry.memberId, (perMember.get(entry.memberId) ?? 0n) + amount);
    total += amount;
  }
  if (total === 0n) return;

  post(db, {
    kind: 'transfer',
    ref: ledgerRef(round.id),
    memo,
    now,
    movements: [
      { accountId: GAMES_ESCROW, amount: -total },
      ...[...perMember].map(([accountId, amount]) => ({ accountId, amount })),
    ],
  });
}

/** 決着を待っている回を片付ける。定期的に呼ぶ。 */
export async function settleDueGames(
  db: Db,
  source: PriceSource,
  now = Date.now(),
): Promise<{ readonly settled: number; readonly refunded: number }> {
  const due = db
    .select()
    .from(gameRounds)
    .where(and(eq(gameRounds.status, 'open'), lte(gameRounds.endsAt, now - SETTLE_GRACE_MS)))
    .orderBy(asc(gameRounds.endsAt))
    .all();

  let settled = 0;
  let refunded = 0;
  for (const round of due) {
    const symbols = symbolsOf(round);
    const candles = new Map<string, Candle | undefined>();
    for (const symbol of symbols) {
      try {
        candles.set(symbol, await source.candle(symbol, round.startsAt, '1h'));
      } catch {
        // 取引所に繋がらない。諦める時刻までは待つ。
        candles.set(symbol, undefined);
      }
    }
    const result = settleGameRound(db, { roundId: round.id, candles, now });
    if (result.kind === 'settled') settled += 1;
    if (result.kind === 'refunded') refunded += 1;
  }
  return { settled, refunded };
}

// --- 読み取り -------------------------------------------------------------

export interface GameRoundView {
  readonly round: GameRoundRow;
  readonly entries: readonly GameEntryRow[];
  readonly total: bigint;
}

function toView(db: Db, round: GameRoundRow): GameRoundView {
  const entries = entriesOf(db, round.id);
  return { round, entries, total: entries.reduce((sum, entry) => sum + BigInt(entry.stake), 0n) };
}

export function gameRoundView(db: Db, id: string): GameRoundView | undefined {
  const round = getGameRound(db, id);
  return round === undefined ? undefined : toView(db, round);
}

/** 新しい順の回。closest と volatility は銘柄で絞る。 */
export function recentGameRounds(db: Db, game: Game, subject?: string, limit = 12): GameRoundView[] {
  const where =
    game !== 'ranking' && subject !== undefined
      ? and(eq(gameRounds.game, game), eq(gameRounds.subject, subject))
      : eq(gameRounds.game, game);
  return db
    .select()
    .from(gameRounds)
    .where(where)
    .orderBy(desc(gameRounds.startsAt))
    .limit(limit)
    .all()
    .map((round) => toView(db, round));
}

/** 選んだものごとの賭け金の合計。順位予想なら銘柄、値幅予想なら帯。 */
export function poolsByPick(view: GameRoundView | undefined): Map<string, bigint> {
  const pools = new Map<string, bigint>();
  for (const entry of view?.entries ?? []) {
    pools.set(entry.pick, (pools.get(entry.pick) ?? 0n) + BigInt(entry.stake));
  }
  return pools;
}

/** 決着していない回の賭け金の合計。預かり口座の残高と一致しなければならない。 */
export function openGameStakeTotal(db: Db): bigint {
  return db
    .select()
    .from(gameRounds)
    .where(eq(gameRounds.status, 'open'))
    .all()
    .reduce(
      (sum, round) =>
        sum + entriesOf(db, round.id).reduce((s, entry) => s + BigInt(entry.stake), 0n),
      0n,
    );
}
