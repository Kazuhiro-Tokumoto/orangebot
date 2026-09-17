import { describe, expect, it } from 'vitest';
import { closestTakesAll, splitPool, type Stake } from './payouts.js';

const B = 10n ** 16n;

function sum(map: ReadonlyMap<string, bigint>): bigint {
  return [...map.values()].reduce((total, value) => total + value, 0n);
}

/** 決まった種から作る乱数。試験を毎回同じにするため。 */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

describe('パリミュチュエル', () => {
  const stakes: Stake[] = [
    { id: 'a', stake: 3n * B },
    { id: 'b', stake: 1n * B },
    { id: 'c', stake: 4n * B },
  ];

  it('外れの賭け金を、当たりで賭け金に比例して分ける', () => {
    const payouts = splitPool(stakes, new Set(['a', 'b']));
    expect(payouts.get('a')).toBe(6n * B);
    expect(payouts.get('b')).toBe(2n * B);
    expect(payouts.get('c')).toBe(0n);
  });

  it('当たりが無いか、全部が当たりなら全員に返す', () => {
    expect(splitPool(stakes, new Set())).toEqual(new Map([['a', 3n * B], ['b', B], ['c', 4n * B]]));
    expect(splitPool(stakes, new Set(['a', 'b', 'c']))).toEqual(
      new Map([['a', 3n * B], ['b', B], ['c', 4n * B]]),
    );
  });

  it('端数は並びの最初の当たりに付き、合計は預かった額に一致する', () => {
    const odd: Stake[] = [
      { id: 'x', stake: 1n },
      { id: 'y', stake: 2n },
      { id: 'z', stake: 2n },
    ];
    const payouts = splitPool(odd, new Set(['x', 'y']));
    expect(sum(payouts)).toBe(5n);
    expect(payouts.get('x')).toBe(2n);
    expect(payouts.get('y')).toBe(3n);
  });
});

describe('いちばん近い予想の総取り', () => {
  it('賭け金が同じなら、いちばん近い人が全部を取る', () => {
    const payouts = closestTakesAll([
      { id: 'a', stake: B, error: 5n },
      { id: 'b', stake: B, error: 1n },
      { id: 'c', stake: B, error: 9n },
    ]);
    expect(payouts).toEqual(new Map([['a', 0n], ['b', 3n * B], ['c', 0n]]));
  });

  it('1 人の負けから取れるのは、自分の賭け金まで', () => {
    // 最低額で勝っても、大きな賭けを総取りはできない。
    const payouts = closestTakesAll([
      { id: 'small', stake: 1n * B, error: 0n },
      { id: 'big', stake: 100n * B, error: 10n },
    ]);
    expect(payouts.get('small')).toBe(2n * B);
    expect(payouts.get('big')).toBe(99n * B);
  });

  it('いちばん近い人が並んだら、賭け金に比例して分ける', () => {
    const payouts = closestTakesAll([
      { id: 'a', stake: 1n * B, error: 2n },
      { id: 'b', stake: 3n * B, error: 2n },
      { id: 'c', stake: 8n * B, error: 7n },
    ]);
    expect(payouts.get('a')).toBe(2n * B);
    expect(payouts.get('b')).toBe(6n * B);
    expect(payouts.get('c')).toBe(4n * B);
  });

  it('1 人だけか、全員が同じだけ近ければ全員に返す', () => {
    expect(closestTakesAll([{ id: 'a', stake: B, error: 3n }])).toEqual(new Map([['a', B]]));
    expect(
      closestTakesAll([
        { id: 'a', stake: B, error: 3n },
        { id: 'b', stake: 2n * B, error: 3n },
      ]),
    ).toEqual(new Map([['a', B], ['b', 2n * B]]));
  });

  it('どんな組み合わせでも、合計は預かった額に一致し、マイナスにならない', () => {
    const next = random(42);
    for (let round = 0; round < 500; round += 1) {
      const count = 1 + Math.floor(next() * 7);
      const entries = Array.from({ length: count }, (_, index) => ({
        id: String(index),
        stake: 1n + BigInt(Math.floor(next() * 1_000_000_007)),
        error: BigInt(Math.floor(next() * 4)),
      }));
      const payouts = closestTakesAll(entries);
      expect(sum(payouts)).toBe(entries.reduce((total, entry) => total + entry.stake, 0n));
      for (const entry of entries) {
        const payout = payouts.get(entry.id) ?? -1n;
        expect(payout >= 0n).toBe(true);
        // 取れる額は、負けた人数 x 自分の賭け金まで。
        expect(payout <= entry.stake * BigInt(count)).toBe(true);
      }

      const pool = splitPool(entries, new Set(entries.filter((entry) => entry.error === 0n).map((e) => e.id)));
      expect(sum(pool)).toBe(entries.reduce((total, entry) => total + entry.stake, 0n));
    }
  });
});
