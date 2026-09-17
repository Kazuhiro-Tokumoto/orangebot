import { beforeEach, describe, expect, it } from 'vitest';
import { verifyAuditLog } from '../db/audit.js';
import { openTestDatabase, type Database_ } from '../db/client.js';
import { members } from '../db/schema.js';
import { compareDecimal, formatChange, scaleDecimals, type Candle, type PriceSource } from '../market/price.js';
import {
  GAMES_ESCROW,
  GAME_ROUND_MS,
  VOLATILITY_BANDS,
  bestPerformers,
  enterClosest,
  enterRanking,
  enterVolatility,
  formatRange,
  volatilityBand,
  entriesOf,
  gameBettableStart,
  gameRoundId,
  getGameRound,
  openGameStakeTotal,
  resultOf,
  settleDueGames,
  settleGameRound,
} from './games.js';
import { balanceOf, mint, verifyLedger } from './ledger.js';
import { BET_CUTOFF_MS, GIVE_UP_MS, SETTLE_GRACE_MS } from './prediction.js';
import { SOAG_PER_BOAG } from './units.js';

const B = SOAG_PER_BOAG;
const START = 1_700_000_000_000 - (1_700_000_000_000 % GAME_ROUND_MS) + GAME_ROUND_MS;
const NOW = START - 20 * 60 * 1000;
const AFTER = START + GAME_ROUND_MS + SETTLE_GRACE_MS;
const SYMBOLS = ['BTCUSDT', 'ETHUSDT'];
const RANKING = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];

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

function guess(memberId: string, price: string, amount: string, now = NOW) {
  return enterClosest(db(), {
    memberId,
    symbol: 'BTCUSDT',
    symbols: SYMBOLS,
    price,
    amount,
    startsAt: gameBettableStart(now),
    now,
  });
}

function pick(memberId: string, symbol: string, amount: string, now = NOW) {
  return enterRanking(db(), {
    memberId,
    symbols: RANKING,
    pick: symbol,
    amount,
    startsAt: gameBettableStart(now),
    now,
  });
}

function candle(open: string, close: string, startsAt = START): Candle {
  const [low, high] = compareDecimal(open, close) <= 0 ? [open, close] : [close, open];
  return { openTime: startsAt, closeTime: startsAt + GAME_ROUND_MS - 1, open, high, low, close };
}

function assertBooks(): void {
  expect(balanceOf(db(), GAMES_ESCROW)).toBe(openGameStakeTotal(db()));
  expect(verifyLedger(db()).ok).toBe(true);
  expect(verifyAuditLog(db()).ok).toBe(true);
}

beforeEach(() => {
  handle = openTestDatabase();
  addMember(ALICE, 'alice');
  addMember(BOB, 'bob');
  addMember(CAROL, 'carol');
});

describe('10 進の計算', () => {
  it('桁をそろえた整数にする', () => {
    expect(scaleDecimals(['1.5', '20', '0.125'])).toEqual({ scale: 3, values: [1500n, 20000n, 125n] });
  });

  it('伸びをパーセントで出す', () => {
    expect(formatChange('100', '101.5')).toBe('+1.50%');
    expect(formatChange('200', '199')).toBe('-0.50%');
    expect(formatChange('3', '3.0')).toBe('0.00%');
  });

  it('いちばん伸びた銘柄を、割り算せずに比べる', () => {
    expect(
      bestPerformers([
        { symbol: 'A', open: '100', close: '101' },
        { symbol: 'B', open: '0.5', close: '0.506' },
        { symbol: 'C', open: '3', close: '2.9' },
      ]),
    ).toEqual(['B']);
    expect(
      bestPerformers([
        { symbol: 'A', open: '100', close: '102' },
        { symbol: 'B', open: '50', close: '51.0' },
      ]),
    ).toEqual(['A', 'B']);
  });
});

describe('回の区切り', () => {
  it('次に始まる 1 時間足に賭け、始まる 10 秒前に締め切る', () => {
    expect(gameBettableStart(NOW)).toBe(START);
    expect(gameBettableStart(START - BET_CUTOFF_MS - 1)).toBe(START);
    expect(gameBettableStart(START - BET_CUTOFF_MS + 1)).toBe(START + GAME_ROUND_MS);
  });
});

describe('終値予想', () => {
  it('参加すると賭け金を預かる', () => {
    expect(guess(ALICE, '64000.5', '10').ok).toBe(true);
    expect(balanceOf(db(), ALICE)).toBe(90n * B);
    expect(balanceOf(db(), GAMES_ESCROW)).toBe(10n * B);
    assertBooks();
  });

  it('1 回に 1 人 1 つ', () => {
    expect(guess(ALICE, '64000', '1').ok).toBe(true);
    const again = guess(ALICE, '65000', '1');
    expect(!again.ok && again.reason).toContain('もう参加しています');
    expect(balanceOf(db(), ALICE)).toBe(99n * B);
  });

  it('値段の形と銘柄を確かめる', () => {
    for (const price of ['', '0', '0.00', '-1', '1e5', '64,000', '1.123456789', '01']) {
      expect(guess(ALICE, price, '1').ok).toBe(false);
    }
    expect(
      enterClosest(db(), {
        memberId: ALICE,
        symbol: 'DOGEUSDT',
        symbols: SYMBOLS,
        price: '1',
        amount: '1',
        startsAt: START,
        now: NOW,
      }).ok,
    ).toBe(false);
    expect(balanceOf(db(), ALICE)).toBe(100n * B);
  });

  it('締め切った回には入れない', () => {
    const late = enterClosest(db(), {
      memberId: ALICE,
      symbol: 'BTCUSDT',
      symbols: SYMBOLS,
      price: '1',
      amount: '1',
      startsAt: START,
      now: START - BET_CUTOFF_MS + 1,
    });
    expect(late.ok).toBe(false);
  });

  it('いちばん近い人が取る', () => {
    guess(ALICE, '64000', '10');
    guess(BOB, '64100.25', '10');
    guess(CAROL, '63000', '10');
    const id = gameRoundId('closest', 'BTCUSDT', START);

    // 足が閉じて猶予が過ぎるまでは決着しない。
    expect(
      settleGameRound(db(), { roundId: id, candles: new Map([['BTCUSDT', candle('64010', '64090')]]), now: AFTER - 1 })
        .kind,
    ).toBe('waiting');

    const result = settleGameRound(db(), {
      roundId: id,
      candles: new Map([['BTCUSDT', candle('64010', '64090')]]),
      now: AFTER,
    });
    expect(result.kind).toBe('settled');
    expect(balanceOf(db(), BOB)).toBe(120n * B);
    expect(balanceOf(db(), ALICE)).toBe(90n * B);
    expect(balanceOf(db(), CAROL)).toBe(90n * B);
    const round = getGameRound(db(), id);
    expect(round === undefined ? undefined : resultOf(round).close).toBe('64090');
    assertBooks();

    // 二度目は何もしない。
    expect(
      settleGameRound(db(), { roundId: id, candles: new Map([['BTCUSDT', candle('1', '1')]]), now: AFTER + 1 }).kind,
    ).toBe('waiting');
    expect(balanceOf(db(), BOB)).toBe(120n * B);
  });

  it('1 人だけの回は返す', () => {
    guess(ALICE, '64000', '10');
    settleGameRound(db(), {
      roundId: gameRoundId('closest', 'BTCUSDT', START),
      candles: new Map([['BTCUSDT', candle('1', '64000')]]),
      now: AFTER,
    });
    expect(balanceOf(db(), ALICE)).toBe(100n * B);
    assertBooks();
  });

  it('値段が取れないまま諦める時刻を過ぎたら、全員に返す', () => {
    guess(ALICE, '64000', '10');
    guess(BOB, '64001', '5');
    const id = gameRoundId('closest', 'BTCUSDT', START);
    const empty = new Map<string, Candle | undefined>();

    expect(settleGameRound(db(), { roundId: id, candles: empty, now: START + GAME_ROUND_MS + GIVE_UP_MS - 1 }).kind).toBe(
      'waiting',
    );
    expect(settleGameRound(db(), { roundId: id, candles: empty, now: START + GAME_ROUND_MS + GIVE_UP_MS }).kind).toBe(
      'refunded',
    );
    expect(balanceOf(db(), ALICE)).toBe(100n * B);
    expect(balanceOf(db(), BOB)).toBe(100n * B);
    assertBooks();
  });

  it('違う足が返ってきたら使わない', () => {
    guess(ALICE, '64000', '10');
    guess(BOB, '64001', '5');
    const result = settleGameRound(db(), {
      roundId: gameRoundId('closest', 'BTCUSDT', START),
      candles: new Map([['BTCUSDT', candle('1', '2', START + GAME_ROUND_MS)]]),
      now: AFTER,
    });
    expect(result.kind).toBe('waiting');
  });
});

describe('順位予想', () => {
  it('いちばん伸びた銘柄に賭けた人で分ける', () => {
    expect(pick(ALICE, 'SOLUSDT', '10').ok).toBe(true);
    expect(pick(BOB, 'BTCUSDT', '30').ok).toBe(true);
    expect(pick(CAROL, 'SOLUSDT', '30').ok).toBe(true);
    assertBooks();

    const result = settleGameRound(db(), {
      roundId: gameRoundId('ranking', '', START),
      candles: new Map([
        ['BTCUSDT', candle('64000', '64640')], // +1%
        ['ETHUSDT', candle('3000', '2970')], // -1%
        ['SOLUSDT', candle('150', '153')], // +2%
      ]),
      now: AFTER,
    });
    expect(result.kind).toBe('settled');
    expect(balanceOf(db(), ALICE)).toBe(90n * B + 17n * B + 5n * B / 10n);
    expect(balanceOf(db(), CAROL)).toBe(70n * B + 52n * B + 5n * B / 10n);
    expect(balanceOf(db(), BOB)).toBe(70n * B);
    const round = getGameRound(db(), gameRoundId('ranking', '', START));
    expect(round === undefined ? [] : resultOf(round).winners).toEqual(['SOLUSDT']);
    assertBooks();
  });

  it('比べていない銘柄と、2 つ目の賭けは断る', () => {
    expect(pick(ALICE, 'DOGEUSDT', '1').ok).toBe(false);
    expect(pick(ALICE, 'BTCUSDT', '1').ok).toBe(true);
    expect(pick(ALICE, 'ETHUSDT', '1').ok).toBe(false);
  });

  it('途中で設定の銘柄が変わっても、回ができたときの銘柄で受け付ける', () => {
    expect(pick(ALICE, 'SOLUSDT', '1').ok).toBe(true);
    const changed = enterRanking(db(), {
      memberId: BOB,
      symbols: ['BTCUSDT', 'XRPUSDT'],
      pick: 'SOLUSDT',
      amount: '1',
      startsAt: START,
      now: NOW,
    });
    expect(changed.ok).toBe(true);
    expect(entriesOf(db(), gameRoundId('ranking', '', START))).toHaveLength(2);
  });

  it('1 つでも足が欠けていれば待つ', () => {
    pick(ALICE, 'SOLUSDT', '1');
    pick(BOB, 'BTCUSDT', '1');
    const result = settleGameRound(db(), {
      roundId: gameRoundId('ranking', '', START),
      candles: new Map([
        ['BTCUSDT', candle('1', '2')],
        ['SOLUSDT', candle('1', '2')],
      ]),
      now: AFTER,
    });
    expect(result.kind).toBe('waiting');
  });

  it('定期処理が 1 時間足を取り寄せて決着させる', async () => {
    pick(ALICE, 'SOLUSDT', '1');
    pick(BOB, 'BTCUSDT', '1');
    guess(CAROL, '64000', '1');
    guess(BOB, '64100', '1');

    const asked: string[] = [];
    const source: PriceSource = {
      candle: (symbol, openTime, interval) => {
        asked.push(`${symbol}:${interval ?? '5m'}`);
        if (symbol === 'ETHUSDT') return Promise.reject(new Error('down'));
        return Promise.resolve(candle('100', symbol === 'SOLUSDT' ? '110' : '101', openTime));
      },
      ticker: (symbol) => Promise.resolve({ symbol, price: '1' }),
    };

    // ETH が取れないので順位予想は待つ。終値予想は決着する。
    expect(await settleDueGames(db(), source, AFTER)).toEqual({ settled: 1, refunded: 0 });
    expect(asked.every((item) => item.endsWith(':1h'))).toBe(true);

    const later = await settleDueGames(db(), source, START + GAME_ROUND_MS + GIVE_UP_MS);
    expect(later).toEqual({ settled: 0, refunded: 1 });
    assertBooks();
  });
});

describe('値幅予想', () => {
  function band(memberId: string, key: string, amount: string, now = NOW) {
    return enterVolatility(db(), {
      memberId,
      symbol: 'ETHUSDT',
      symbols: SYMBOLS,
      band: key,
      amount,
      startsAt: gameBettableStart(now),
      now,
    });
  }

  it('値幅の帯を、境目ちょうどは上の帯として決める', () => {
    const at = (high: string, low: string, open = '100') => volatilityBand({ open, high, low });
    expect(at('100.49', '100')).toBe('0-0.5');
    expect(at('100.5', '100')).toBe('0.5-1');
    expect(at('101', '100.0')).toBe('1-1.5');
    expect(at('101.4999', '100')).toBe('1-1.5');
    expect(at('102', '100')).toBe('1.5-2.5');
    expect(at('130', '90')).toBe('2.5-');
    expect(at('64640', '64000', '64000')).toBe('1-1.5');
    expect(VOLATILITY_BANDS.map((item) => item.key)).toEqual(['0-0.5', '0.5-1', '1-1.5', '1.5-2.5', '2.5-']);
  });

  it('値幅をパーセントで出す', () => {
    expect(formatRange({ open: '64000', high: '64640', low: '64000' })).toBe('1.00%');
    expect(formatRange({ open: '3', high: '3.01', low: '2.99' })).toBe('0.66%');
  });

  it('帯と銘柄を確かめ、1 回に 1 人 1 つ', () => {
    expect(band(ALICE, '3-4', '1').ok).toBe(false);
    expect(
      enterVolatility(db(), {
        memberId: ALICE,
        symbol: 'DOGEUSDT',
        symbols: SYMBOLS,
        band: '0-0.5',
        amount: '1',
        startsAt: START,
        now: NOW,
      }).ok,
    ).toBe(false);
    expect(band(ALICE, '0-0.5', '1').ok).toBe(true);
    expect(band(ALICE, '2.5-', '1').ok).toBe(false);
    expect(balanceOf(db(), ALICE)).toBe(99n * B);
  });

  it('値幅が入った帯に賭けた人で分ける', () => {
    band(ALICE, '0.5-1', '10');
    band(BOB, '1-1.5', '30');
    band(CAROL, '0.5-1', '30');
    const id = gameRoundId('volatility', 'ETHUSDT', START);

    const result = settleGameRound(db(), {
      roundId: id,
      candles: new Map([
        [
          'ETHUSDT',
          { openTime: START, closeTime: START + GAME_ROUND_MS - 1, open: '100', high: '100.8', low: '100', close: '99.9' },
        ],
      ]),
      now: AFTER,
    });
    expect(result.kind).toBe('settled');
    expect(balanceOf(db(), ALICE)).toBe(90n * B + 17n * B + 5n * B / 10n);
    expect(balanceOf(db(), CAROL)).toBe(70n * B + 52n * B + 5n * B / 10n);
    expect(balanceOf(db(), BOB)).toBe(70n * B);
    const round = getGameRound(db(), id);
    expect(round === undefined ? undefined : resultOf(round)).toMatchObject({ band: '0.5-1', high: '100.8' });
    assertBooks();
  });

  it('定期処理でも 1 時間足を取り寄せる', async () => {
    band(ALICE, '0-0.5', '1');
    band(BOB, '2.5-', '1');
    const asked: string[] = [];
    const source: PriceSource = {
      candle: (symbol, openTime, interval) => {
        asked.push(`${symbol}:${interval ?? '5m'}`);
        return Promise.resolve({
          openTime,
          closeTime: openTime + GAME_ROUND_MS - 1,
          open: '100',
          high: '100.1',
          low: '100',
          close: '100',
        });
      },
      ticker: (symbol) => Promise.resolve({ symbol, price: '1' }),
    };
    expect(await settleDueGames(db(), source, AFTER)).toEqual({ settled: 1, refunded: 0 });
    expect(asked).toEqual(['ETHUSDT:1h']);
    expect(balanceOf(db(), ALICE)).toBe(101n * B);
    assertBooks();
  });
});
