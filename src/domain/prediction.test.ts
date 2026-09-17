import { beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyAuditLog } from '../db/audit.js';
import { openTestDatabase, type Database_ } from '../db/client.js';
import { members, type PredictionBetRow } from '../db/schema.js';
import {
  PriceError,
  compareDecimal,
  createBinanceSource,
  type Candle,
  type PriceSource,
} from '../market/price.js';
import { balanceOf, mint, verifyLedger } from './ledger.js';
import {
  BET_CUTOFF_MS,
  ESCROW_ACCOUNT,
  GIVE_UP_MS,
  MIN_STAKE,
  ROUND_MS,
  SETTLE_GRACE_MS,
  bettableStart,
  computePayouts,
  getRound,
  impliedReturn,
  openStakeTotal,
  placeBet,
  roundId,
  settleDueRounds,
  settleRound,
} from './prediction.js';
import { SOAG_PER_BOAG } from './units.js';

const B = SOAG_PER_BOAG;
/** 5 分の倍数から 1 分過ぎた時刻。次の回は START。 */
const START = 1_700_000_100_000 - (1_700_000_100_000 % ROUND_MS) + ROUND_MS;
const NOW = START - 4 * 60 * 1000;
const SYMBOLS = ['BTCUSDT', 'ETHUSDT'];

const ALICE = '1529717434259345489';
const BOB = '1700000000000000001';
const CAROL = '1700000000000000002';

let handle: Database_;

function db() {
  return handle.db;
}

function addMember(id: string, username: string): void {
  db()
    .insert(members)
    .values({ id, username, displayName: username, status: 'active', createdAt: 0, activatedAt: 0 })
    .run();
  mint(db(), { to: id, amount: 100n * B, ref: 'test', now: 0 });
}

function bet(memberId: string, side: string, amount: string, now = NOW) {
  return placeBet(db(), {
    memberId,
    symbol: 'BTCUSDT',
    symbols: SYMBOLS,
    side,
    amount,
    startsAt: bettableStart(now),
    now,
  });
}

function candle(open: string, close: string, startsAt = START): Candle {
  const [low, high] = compareDecimal(open, close) <= 0 ? [open, close] : [close, open];
  return { openTime: startsAt, closeTime: startsAt + ROUND_MS - 1, open, high, low, close };
}

const AFTER = START + ROUND_MS + SETTLE_GRACE_MS;

beforeEach(() => {
  handle = openTestDatabase();
  addMember(ALICE, 'alice');
  addMember(BOB, 'bob');
  addMember(CAROL, 'carol');
});

describe('回の区切り', () => {
  it('次に始まる 5 分足に賭ける', () => {
    expect(bettableStart(NOW)).toBe(START);
    expect(START % ROUND_MS).toBe(0);
  });

  it('始まる直前は締め切って、その次の回になる', () => {
    expect(bettableStart(START - BET_CUTOFF_MS - 1)).toBe(START);
    expect(bettableStart(START - BET_CUTOFF_MS + 1)).toBe(START + ROUND_MS);
  });
});

describe('賭ける', () => {
  it('賭け金を預かり口座へ移す', () => {
    const result = bet(ALICE, 'up', '10');
    expect(result.ok).toBe(true);
    expect(balanceOf(db(), ALICE)).toBe(90n * B);
    expect(balanceOf(db(), ESCROW_ACCOUNT)).toBe(10n * B);
    expect(openStakeTotal(db())).toBe(10n * B);
    expect(verifyLedger(db()).ok).toBe(true);
  });

  it('画面が表示していた回が締め切られていたら、次の回に回さず断る', () => {
    const result = placeBet(db(), {
      memberId: ALICE,
      symbol: 'BTCUSDT',
      symbols: SYMBOLS,
      side: 'up',
      amount: '1',
      startsAt: START,
      now: START - BET_CUTOFF_MS + 1,
    });
    expect(result.ok).toBe(false);
    expect(balanceOf(db(), ALICE)).toBe(100n * B);
  });

  it('残高を超えては賭けられない', () => {
    expect(bet(ALICE, 'up', '100.0000000000000001').ok).toBe(false);
    expect(balanceOf(db(), ALICE)).toBe(100n * B);
  });

  it('最低額に届かない賭けは断る', () => {
    expect(bet(ALICE, 'up', '0.0000001').ok).toBe(false);
    expect(bet(ALICE, 'up', '0.000001').ok).toBe(true);
    expect(MIN_STAKE).toBe(10n ** 10n);
  });

  it('同じ回で反対側には賭けられないが、同じ側に足すのはよい', () => {
    expect(bet(ALICE, 'up', '1').ok).toBe(true);
    expect(bet(ALICE, 'up', '2').ok).toBe(true);
    expect(bet(ALICE, 'down', '1').ok).toBe(false);
  });

  it('扱っていない銘柄と、上下以外は断る', () => {
    expect(
      placeBet(db(), {
        memberId: ALICE,
        symbol: 'DOGEUSDT',
        symbols: SYMBOLS,
        side: 'up',
        amount: '1',
        startsAt: START,
        now: NOW,
      }).ok,
    ).toBe(false);
    expect(bet(ALICE, 'sideways', '1').ok).toBe(false);
  });
});

describe('配当の計算', () => {
  function row(id: string, side: 'up' | 'down', stake: bigint): PredictionBetRow {
    return { id, roundId: 'r', memberId: id, side, stake: stake.toString(), payout: null, placedAt: 0 };
  }

  it('負けた側の合計を、勝った側で賭け金に比例して分ける', () => {
    const payouts = computePayouts(
      [row('a', 'up', 30n), row('b', 'up', 10n), row('c', 'down', 20n)],
      'up',
    );
    expect(payouts.get('a')).toBe(45n);
    expect(payouts.get('b')).toBe(15n);
    expect(payouts.get('c')).toBe(0n);
  });

  it('端数は最初に賭けた勝者に足し、払い戻しの合計は預かりの合計に一致する', () => {
    const bets = [row('a', 'up', 1n), row('b', 'up', 1n), row('c', 'up', 1n), row('d', 'down', 1n)];
    const payouts = computePayouts(bets, 'up');
    const total = [...payouts.values()].reduce((sum, value) => sum + value, 0n);

    expect(total).toBe(4n);
    expect(payouts.get('a')).toBe(2n);
    expect(payouts.get('b')).toBe(1n);
  });

  it('変わらずなら全員に返す', () => {
    const payouts = computePayouts([row('a', 'up', 5n), row('b', 'down', 7n)], 'flat');
    expect(payouts.get('a')).toBe(5n);
    expect(payouts.get('b')).toBe(7n);
  });

  it('片側にしか賭けが無ければ全員に返す', () => {
    const payouts = computePayouts([row('a', 'down', 5n), row('b', 'down', 7n)], 'up');
    expect(payouts.get('a')).toBe(5n);
    expect(payouts.get('b')).toBe(7n);
  });

  it('目安の倍率', () => {
    expect(impliedReturn({ up: 30n, down: 10n }, 'down')).toBe('4.00');
    expect(impliedReturn({ up: 30n, down: 10n }, 'up')).toBe('1.33');
    expect(impliedReturn({ up: 30n, down: 0n }, 'up')).toBeUndefined();
  });
});

describe('決着', () => {
  it('上がれば上に賭けた側が負けた側の分を受け取る', () => {
    bet(ALICE, 'up', '30');
    bet(BOB, 'up', '10');
    bet(CAROL, 'down', '20');

    const result = settleRound(db(), {
      roundId: roundId('BTCUSDT', START),
      candle: candle('64000.10', '64000.11'),
      now: AFTER,
    });

    expect(result).toEqual({ kind: 'settled', outcome: 'up' });
    expect(balanceOf(db(), ALICE)).toBe(115n * B);
    expect(balanceOf(db(), BOB)).toBe(105n * B);
    expect(balanceOf(db(), CAROL)).toBe(80n * B);
    expect(balanceOf(db(), ESCROW_ACCOUNT)).toBe(0n);
    expect(verifyLedger(db()).ok).toBe(true);
    expect(verifyAuditLog(db()).ok).toBe(true);

    const round = getRound(db(), roundId('BTCUSDT', START));
    expect(round?.openPrice).toBe('64000.10');
    expect(round?.closePrice).toBe('64000.11');
  });

  it('値段は文字列のまま比べるので、小さな動きも変わらずに化けない', () => {
    expect(compareDecimal('0.10000000000000000001', '0.1')).toBe(1);
    expect(compareDecimal('64000.10', '64000.1')).toBe(0);
    expect(compareDecimal('9.99', '10')).toBe(-1);
  });

  it('何度呼んでも払い戻しは 1 回', () => {
    bet(ALICE, 'up', '10');
    bet(BOB, 'down', '10');
    const id = roundId('BTCUSDT', START);

    settleRound(db(), { roundId: id, candle: candle('1', '2'), now: AFTER });
    settleRound(db(), { roundId: id, candle: candle('1', '0.5'), now: AFTER + 1000 });

    expect(balanceOf(db(), ALICE)).toBe(110n * B);
    expect(balanceOf(db(), BOB)).toBe(90n * B);
  });

  it('足が閉じる前には決着しない', () => {
    bet(ALICE, 'up', '10');
    const result = settleRound(db(), {
      roundId: roundId('BTCUSDT', START),
      candle: candle('1', '2'),
      now: START + ROUND_MS - 1,
    });
    expect(result.kind).toBe('waiting');
    expect(balanceOf(db(), ESCROW_ACCOUNT)).toBe(10n * B);
  });

  it('違う足を渡されても決着しない', () => {
    bet(ALICE, 'up', '10');
    const result = settleRound(db(), {
      roundId: roundId('BTCUSDT', START),
      candle: candle('1', '2', START + ROUND_MS),
      now: AFTER,
    });
    expect(result.kind).toBe('waiting');
  });

  it('値が取れないまま時間が過ぎたら全員に返す', () => {
    bet(ALICE, 'up', '10');
    bet(BOB, 'down', '5');
    const id = roundId('BTCUSDT', START);

    expect(settleRound(db(), { roundId: id, candle: undefined, now: AFTER }).kind).toBe('waiting');
    const result = settleRound(db(), {
      roundId: id,
      candle: undefined,
      now: START + ROUND_MS + GIVE_UP_MS,
    });

    expect(result.kind).toBe('refunded');
    expect(balanceOf(db(), ALICE)).toBe(100n * B);
    expect(balanceOf(db(), BOB)).toBe(100n * B);
    expect(balanceOf(db(), ESCROW_ACCOUNT)).toBe(0n);
  });

  it('期限の来た回をまとめて片付け、取引所が落ちていても例外にしない', async () => {
    bet(ALICE, 'up', '10');
    bet(BOB, 'down', '10');

    const down: PriceSource = {
      candle: () => Promise.reject(new PriceError('繋がりません')),
      ticker: () => Promise.reject(new PriceError('繋がりません')),
    };
    await expect(settleDueRounds(db(), down, AFTER)).resolves.toEqual({ settled: 0, refunded: 0 });

    const up: PriceSource = {
      candle: (_symbol, openTime) => Promise.resolve(candle('10', '11', openTime)),
      ticker: () => Promise.resolve({ symbol: 'BTCUSDT', price: '11' }),
    };
    await expect(settleDueRounds(db(), up, AFTER)).resolves.toEqual({ settled: 1, refunded: 0 });
    expect(balanceOf(db(), ALICE)).toBe(110n * B);
  });
});

describe('Binance の 5 分足', () => {
  function stubFetch(body: unknown, status = 200) {
    return vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(body), { status })),
    ) as unknown as typeof globalThis.fetch;
  }

  it('頼んだ足の始値と終値を文字列のまま読む', async () => {
    const source = createBinanceSource({
      fetch: stubFetch([[START, '64000.10', '64100', '63900', '64050.55', '12.3', START + ROUND_MS - 1]]),
    });
    await expect(source.candle('BTCUSDT', START)).resolves.toEqual({
      openTime: START,
      closeTime: START + ROUND_MS - 1,
      open: '64000.10',
      high: '64100',
      low: '63900',
      close: '64050.55',
    });
  });

  it('次の足が返ってきたら、まだ無いとみなす', async () => {
    const source = createBinanceSource({
      fetch: stubFetch([[START + ROUND_MS, '1', '1', '1', '1', '1', START + 2 * ROUND_MS - 1]]),
    });
    await expect(source.candle('BTCUSDT', START)).resolves.toBeUndefined();
  });

  it('形の違う応答や不正なシンボルは断る', async () => {
    await expect(createBinanceSource({ fetch: stubFetch({}) }).candle('BTCUSDT', START)).rejects.toThrow(
      PriceError,
    );
    await expect(createBinanceSource({ fetch: stubFetch([]) }).candle('btc/usdt', START)).rejects.toThrow(
      PriceError,
    );
  });

  it('いまの値段', async () => {
    const source = createBinanceSource({ fetch: stubFetch({ symbol: 'BTCUSDT', price: '64000.01' }) });
    await expect(source.ticker('BTCUSDT')).resolves.toEqual({ symbol: 'BTCUSDT', price: '64000.01' });
  });
});
