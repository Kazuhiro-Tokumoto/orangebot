import { beforeEach, describe, expect, it } from 'vitest';
import { verifyAuditLog } from '../db/audit.js';
import { openTestDatabase, type Database_ } from '../db/client.js';
import { exchangeWithdrawals, members } from '../db/schema.js';
import {
  GIVE_UP_AFTER_MS,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  creditDeposit,
  deliverDueWithdrawals,
  listWithdrawals,
  ptToSoag,
  requestWithdrawal,
  requeueWithdrawal,
  retryDelay,
  type DeliveryOutcome,
  type PartnerClient,
} from './exchange.js';
import { EXCHANGE_ACCOUNT, balanceOf, mint, verifyLedger } from './ledger.js';
import { SOAG_PER_BOAG } from './units.js';

const T0 = 1_800_000_000_000;
const ME = '1529717434259345489';
const LIMITS = { maxPtPerRequest: 100_000_000_000n, maxPtPerDay: 1_000_000_000_000n };

let handle: Database_;

function db() {
  return handle.db;
}

function withdrawalRow(id: string) {
  return listWithdrawals(db(), ME).find((row) => row.id === id);
}

/** 決め打ちの答えを順に返す相手。 */
function partner(...outcomes: DeliveryOutcome[]): PartnerClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    deliver: (withdrawal) => {
      calls.push(`${withdrawal.id}:${withdrawal.pt}:${withdrawal.discordId}`);
      const next = outcomes.shift() ?? { kind: 'retry', status: 503, message: '落ちている' };
      return Promise.resolve(next);
    },
  };
}

beforeEach(() => {
  handle = openTestDatabase();
  db()
    .insert(members)
    .values({ id: ME, username: 'me', displayName: 'me', status: 'active', createdAt: 0, activatedAt: 0 })
    .run();
});

describe('換算', () => {
  it('10,000,000 pt で 1 BOAG', () => {
    expect(ptToSoag(10_000_000n)).toBe(SOAG_PER_BOAG);
    expect(ptToSoag(1n)).toBe(10n ** 9n);
  });
});

describe('入金', () => {
  function credit(id: string, pt: unknown, discordId: unknown = ME, now = T0) {
    return creditDeposit(db(), { id, discordId, pt, limits: LIMITS, now });
  }

  it('pt を BOAG にして本人に付ける', () => {
    const result = credit('oogiri-1', '25000000');
    expect(result.ok && result.replayed).toBe(false);
    expect(balanceOf(db(), ME)).toBe(25n * SOAG_PER_BOAG / 10n);
    expect(balanceOf(db(), EXCHANGE_ACCOUNT)).toBe(-(25n * SOAG_PER_BOAG) / 10n);
    expect(verifyLedger(db()).ok).toBe(true);
    expect(verifyAuditLog(db()).ok).toBe(true);
  });

  it('同じ id と同じ内容なら、何度来ても 1 回だけ付ける', () => {
    credit('oogiri-1', '10000000');
    const again = credit('oogiri-1', '10000000', ME, T0 + 5000);

    expect(again.ok && again.replayed).toBe(true);
    expect(balanceOf(db(), ME)).toBe(SOAG_PER_BOAG);
  });

  it('同じ id で内容が違えば断る', () => {
    credit('oogiri-1', '10000000');
    const conflict = credit('oogiri-1', '20000000');
    expect(!conflict.ok && conflict.code).toBe('idempotency_conflict');
    expect(balanceOf(db(), ME)).toBe(SOAG_PER_BOAG);
  });

  it('知らない相手や、有効でないメンバーには付けない', () => {
    const unknown = credit('oogiri-2', '1', '1700000000000000009');
    expect(!unknown.ok && unknown.code).toBe('member_not_found');
  });

  it('pt の形が違えば断る', () => {
    for (const pt of ['0', '-1', '1.5', 10, '', '01']) {
      const result = credit(`bad-${String(pt)}`, pt);
      expect(!result.ok && result.code).toBe('invalid_request');
    }
    expect(credit('id with space', '1').ok).toBe(false);
  });

  it('1 回の上限と 24 時間の上限を超えたら断る', () => {
    const one = creditDeposit(db(), {
      id: 'big',
      discordId: ME,
      pt: '11',
      limits: { maxPtPerRequest: 10n, maxPtPerDay: 100n },
      now: T0,
    });
    expect(!one.ok && one.code).toBe('limit_exceeded');

    const limits = { maxPtPerRequest: 10n, maxPtPerDay: 15n };
    expect(creditDeposit(db(), { id: 'a', discordId: ME, pt: '10', limits, now: T0 }).ok).toBe(true);
    const over = creditDeposit(db(), { id: 'b', discordId: ME, pt: '6', limits, now: T0 + 1000 });
    expect(!over.ok && over.code).toBe('limit_exceeded');

    // 24 時間経てば枠が戻る。
    expect(
      creditDeposit(db(), { id: 'c', discordId: ME, pt: '6', limits, now: T0 + 24 * 60 * 60 * 1000 + 1 }).ok,
    ).toBe(true);
  });
});

describe('出金', () => {
  beforeEach(() => {
    mint(db(), { to: ME, amount: 10n * SOAG_PER_BOAG, ref: 'test', now: 0 });
  });

  function withdraw(pt: string) {
    const result = requestWithdrawal(db(), { memberId: ME, pt, limits: LIMITS, now: T0 });
    if (!result.ok) throw new Error(result.message);
    return result.withdrawal;
  }

  it('先に残高から引き、届くまでの記録を作る', () => {
    const row = withdraw('30000000');
    expect(row.status).toBe('pending');
    expect(balanceOf(db(), ME)).toBe(7n * SOAG_PER_BOAG);
    expect(balanceOf(db(), EXCHANGE_ACCOUNT)).toBe(3n * SOAG_PER_BOAG);
  });

  it('残高が足りなければ何もしない', () => {
    const result = requestWithdrawal(db(), { memberId: ME, pt: '100000001', limits: LIMITS, now: T0 });
    expect(!result.ok && result.code).toBe('insufficient_balance');
    expect(balanceOf(db(), ME)).toBe(10n * SOAG_PER_BOAG);
  });

  it('届いたら終わり', async () => {
    const row = withdraw('10000000');
    const client = partner({ kind: 'delivered' });

    const report = await deliverDueWithdrawals(db(), client, T0);
    expect(report.delivered).toBe(1);
    expect(client.calls).toEqual([`${row.id}:10000000:${ME}`]);
    expect(withdrawalRow(row.id)?.status).toBe('delivered');
    expect(balanceOf(db(), ME)).toBe(9n * SOAG_PER_BOAG);
  });

  it('相手がはっきり断ったら返金する', async () => {
    const row = withdraw('10000000');
    await deliverDueWithdrawals(db(), partner({ kind: 'rejected', status: 404, message: 'いない' }), T0);

    expect(withdrawalRow(row.id)?.status).toBe('refunded');
    expect(balanceOf(db(), ME)).toBe(10n * SOAG_PER_BOAG);
    expect(balanceOf(db(), EXCHANGE_ACCOUNT)).toBe(0n);
    expect(verifyLedger(db()).ok).toBe(true);
  });

  it('届いたか分からなければ返金せず、間隔を空けて同じ id で送り直す', async () => {
    const row = withdraw('10000000');
    const client = partner(
      { kind: 'retry', status: null, message: 'ECONNRESET' },
      { kind: 'retry', status: 503, message: '落ちている' },
      { kind: 'delivered' },
    );

    await deliverDueWithdrawals(db(), client, T0);
    expect(withdrawalRow(row.id)?.nextAttemptAt).toBe(T0 + RETRY_BASE_MS);
    expect(balanceOf(db(), ME)).toBe(9n * SOAG_PER_BOAG);

    // 間隔が空くまでは送らない。
    await deliverDueWithdrawals(db(), client, T0 + RETRY_BASE_MS - 1);
    expect(client.calls).toHaveLength(1);

    await deliverDueWithdrawals(db(), client, T0 + RETRY_BASE_MS);
    expect(withdrawalRow(row.id)?.nextAttemptAt).toBe(T0 + RETRY_BASE_MS + 2 * RETRY_BASE_MS);

    await deliverDueWithdrawals(db(), client, T0 + 3 * RETRY_BASE_MS);
    expect(withdrawalRow(row.id)?.status).toBe('delivered');
    expect(new Set(client.calls).size).toBe(1);
  });

  it('送り直しの間隔は倍々で、1 時間で頭打ち', () => {
    expect(retryDelay(1)).toBe(RETRY_BASE_MS);
    expect(retryDelay(2)).toBe(2 * RETRY_BASE_MS);
    expect(retryDelay(50)).toBe(RETRY_MAX_MS);
  });

  it('id の衝突や、長く届かないものは止めて人に任せる。返金はしない', async () => {
    const conflict = withdraw('10000000');
    await deliverDueWithdrawals(db(), partner({ kind: 'conflict', status: 409, message: '別の内容' }), T0);
    expect(withdrawalRow(conflict.id)?.status).toBe('stuck');

    const old = withdraw('10000000');
    await deliverDueWithdrawals(db(), partner(), T0 + GIVE_UP_AFTER_MS);
    expect(withdrawalRow(old.id)?.status).toBe('stuck');

    expect(balanceOf(db(), ME)).toBe(8n * SOAG_PER_BOAG);
  });

  it('止まったものは本人が送り直せる', async () => {
    const row = withdraw('10000000');
    await deliverDueWithdrawals(db(), partner({ kind: 'conflict', status: 409, message: '別の内容' }), T0);

    expect(requeueWithdrawal(db(), { id: row.id, memberId: '1700000000000000009', now: T0 }).ok).toBe(false);
    expect(requeueWithdrawal(db(), { id: row.id, memberId: ME, now: T0 + 1 }).ok).toBe(true);

    await deliverDueWithdrawals(db(), partner({ kind: 'delivered' }), T0 + 1);
    expect(withdrawalRow(row.id)?.status).toBe('delivered');
  });

  it('送っている最中に巡回が重なっても、同じ出金を二度拾わない', async () => {
    withdraw('10000000');
    let release: () => void = () => undefined;
    const slow: PartnerClient = {
      deliver: () =>
        new Promise((resolve) => {
          release = () => {
            resolve({ kind: 'delivered' });
          };
        }),
    };
    const counting = partner({ kind: 'delivered' });

    const first = deliverDueWithdrawals(db(), slow, T0);
    const second = await deliverDueWithdrawals(db(), counting, T0 + 1);
    release();
    await first;

    expect(second.delivered).toBe(0);
    expect(counting.calls).toHaveLength(0);
    expect(db().select().from(exchangeWithdrawals).all()[0]?.status).toBe('delivered');
  });
});
