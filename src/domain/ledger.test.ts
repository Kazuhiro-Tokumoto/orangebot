import { beforeEach, describe, expect, it } from 'vitest';
import { verifyAuditLog } from '../db/audit.js';
import { openTestDatabase, type Database_ } from '../db/client.js';
import { getMemberByUsername, listActiveMembers, setMemberStatus } from '../db/members.js';
import { ledgerEntries } from '../db/schema.js';
import {
  LedgerError,
  SUPPLY_ACCOUNT,
  allBalances,
  balanceOf,
  burn,
  formatAmount,
  historyOf,
  mint,
  parseAmount,
  post,
  recentMovements,
  sendToMember,
  totalIssued,
  transfer,
  verifyLedger,
} from './ledger.js';
import { SOAG_PER_BOAG } from './units.js';
import { activateMember, createGenesisMember } from './members.js';
import { castVote, createProposal } from './proposals.js';

const T0 = 1_700_000_000_000;
const KAZUHIRO = '1529717434259345489';

let nextDiscordId = 1_700_000_000_000_000_000n;
function fakeDiscordId(): string {
  nextDiscordId += 1n;
  return nextDiscordId.toString();
}

let handle: Database_;

function db() {
  return handle.db;
}

function idOf(username: string): string {
  const member = getMemberByUsername(db(), username);
  if (member === undefined) throw new Error(`メンバーがいません: ${username}`);
  return member.id;
}

function addActiveMember(proposer: string, username: string, now = T0): string {
  const result = createProposal(db(), {
    type: 'member.add',
    proposedBy: idOf(proposer),
    payload: { discordId: fakeDiscordId(), username, displayName: username.toUpperCase() },
    now,
  });
  if (!result.ok) throw new Error(result.reason);

  let view = result.view;
  const proposerId = idOf(proposer);
  for (const voter of listActiveMembers(db())) {
    if (view.status !== 'open') break;
    if (voter.id === proposerId) continue;
    const voted = castVote(db(), {
      proposalId: view.id,
      memberId: voter.id,
      choice: 'approve',
      now,
    });
    if (voted.ok) view = voted.view;
  }

  const id = idOf(username);
  activateMember(db(), id, now);
  return id;
}

beforeEach(() => {
  handle = openTestDatabase();
  const genesis = createGenesisMember(db(), {
    discordId: KAZUHIRO,
    username: 'kazuhiro',
    displayName: '徳本 和寛',
    now: T0,
  });
  if (!genesis.ok) throw new Error(genesis.reason);
  activateMember(db(), genesis.member.id, T0);
});

describe('複式の決まり', () => {
  it('合計が 0 でない動きは書けない', () => {
    expect(() =>
      post(db(), {
        kind: 'transfer',
        movements: [
          { accountId: 'a', amount: 100n },
          { accountId: 'b', amount: -50n },
        ],
      }),
    ).toThrow(LedgerError);
  });

  it('1 行だけの動きは書けない', () => {
    expect(() => post(db(), { kind: 'mint', movements: [{ accountId: 'a', amount: 1n }] })).toThrow(
      LedgerError,
    );
  });

  it('金額 0 の行は書けない', () => {
    expect(() =>
      post(db(), {
        kind: 'transfer',
        movements: [
          { accountId: 'a', amount: 0n },
          { accountId: 'b', amount: 0n },
        ],
      }),
    ).toThrow(LedgerError);
  });

  it('空の台帳も健全', () => {
    const result = verifyLedger(db());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.issued).toBe(0n);
  });
});

describe('発行', () => {
  it('発行した分だけ残高と総量が増える', () => {
    const to = idOf('kazuhiro');
    expect(mint(db(), { to, amount: 1000n, ref: 'p1', now: T0 }).ok).toBe(true);

    expect(balanceOf(db(), to)).toBe(1000n);
    expect(totalIssued(db())).toBe(1000n);
    // 発行元は同じ額だけマイナスになる。
    expect(balanceOf(db(), SUPPLY_ACCOUNT)).toBe(-1000n);
    expect(verifyLedger(db()).ok).toBe(true);
  });

  it('0 以下は発行できない', () => {
    const to = idOf('kazuhiro');
    expect(mint(db(), { to, amount: 0n, ref: 'p1' }).ok).toBe(false);
    expect(mint(db(), { to, amount: -5n, ref: 'p1' }).ok).toBe(false);
  });

  it('特別口座へは発行できない', () => {
    expect(mint(db(), { to: SUPPLY_ACCOUNT, amount: 10n, ref: 'p1' }).ok).toBe(false);
  });

  it('大きな額でも桁が壊れない', () => {
    const to = idOf('kazuhiro');
    const huge = 12_345_678_901_234_567_890n;
    mint(db(), { to, amount: huge, ref: 'p1', now: T0 });
    expect(balanceOf(db(), to)).toBe(huge);
  });
});

describe('送金', () => {
  beforeEach(() => {
    addActiveMember('kazuhiro', 'second');
    mint(db(), { to: idOf('kazuhiro'), amount: 500n, ref: 'p1', now: T0 });
  });

  it('残高が動き、総量は変わらない', () => {
    const result = transfer(db(), {
      from: idOf('kazuhiro'),
      to: idOf('second'),
      amount: 200n,
      now: T0 + 1000,
    });
    expect(result.ok).toBe(true);
    expect(balanceOf(db(), idOf('kazuhiro'))).toBe(300n);
    expect(balanceOf(db(), idOf('second'))).toBe(200n);
    expect(totalIssued(db())).toBe(500n);
    expect(verifyLedger(db()).ok).toBe(true);
  });

  it('残高より多くは送れない', () => {
    const result = transfer(db(), {
      from: idOf('kazuhiro'),
      to: idOf('second'),
      amount: 501n,
      now: T0 + 1000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('残高が足りません');
    expect(balanceOf(db(), idOf('kazuhiro'))).toBe(500n);
  });

  it('断られた送金は行を残さない', () => {
    transfer(db(), { from: idOf('second'), to: idOf('kazuhiro'), amount: 1n, now: T0 });
    expect(balanceOf(db(), idOf('second'))).toBe(0n);
    expect(verifyLedger(db()).ok).toBe(true);
  });

  it('自分には送れない', () => {
    const me = idOf('kazuhiro');
    expect(transfer(db(), { from: me, to: me, amount: 1n }).ok).toBe(false);
  });

  it('履歴が残る', () => {
    transfer(db(), {
      from: idOf('kazuhiro'),
      to: idOf('second'),
      amount: 200n,
      memo: 'おつかれさま',
      now: T0 + 1000,
    });
    const rows = historyOf(db(), idOf('second'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.memo).toBe('おつかれさま');
  });
});

describe('メンバー同士のやりとり', () => {
  beforeEach(() => {
    addActiveMember('kazuhiro', 'second');
    mint(db(), { to: idOf('kazuhiro'), amount: SOAG_PER_BOAG * 5n, ref: 'p1', now: T0 });
  });

  it('画面の入力そのままで送れる', () => {
    const result = sendToMember(db(), {
      fromMemberId: idOf('kazuhiro'),
      toMemberId: idOf('second'),
      amount: '1.5',
      memo: 'ありがとう',
      now: T0 + 1000,
    });

    expect(result.ok).toBe(true);
    expect(balanceOf(db(), idOf('second'))).toBe((SOAG_PER_BOAG * 3n) / 2n);
    expect(balanceOf(db(), idOf('kazuhiro'))).toBe((SOAG_PER_BOAG * 7n) / 2n);
    expect(verifyLedger(db()).ok).toBe(true);
  });

  it('0 以下や読めない額は断る', () => {
    for (const amount of ['0', '-1', 'いくらか', '']) {
      const result = sendToMember(db(), {
        fromMemberId: idOf('kazuhiro'),
        toMemberId: idOf('second'),
        amount,
        now: T0 + 1000,
      });
      expect(result.ok).toBe(false);
    }
    expect(balanceOf(db(), idOf('kazuhiro'))).toBe(SOAG_PER_BOAG * 5n);
  });

  it('いないメンバーには送れない', () => {
    const result = sendToMember(db(), {
      fromMemberId: idOf('kazuhiro'),
      toMemberId: '1700000000000000999',
      amount: '1',
      now: T0 + 1000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('宛先');
  });

  it('有効でないメンバーは受け取れない', () => {
    setMemberStatus(db(), idOf('second'), 'suspended', T0 + 500);
    const result = sendToMember(db(), {
      fromMemberId: idOf('kazuhiro'),
      toMemberId: idOf('second'),
      amount: '1',
      now: T0 + 1000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('受け取れない');
  });

  it('有効でないメンバーは送れない', () => {
    setMemberStatus(db(), idOf('kazuhiro'), 'suspended', T0 + 500);
    const result = sendToMember(db(), {
      fromMemberId: idOf('kazuhiro'),
      toMemberId: idOf('second'),
      amount: '1',
      now: T0 + 1000,
    });
    expect(result.ok).toBe(false);
  });

  it('動きの一覧に相手と向きが出る', () => {
    sendToMember(db(), {
      fromMemberId: idOf('kazuhiro'),
      toMemberId: idOf('second'),
      amount: '2',
      memo: 'おつかれさま',
      now: T0 + 1000,
    });

    const sent = recentMovements(db(), idOf('kazuhiro'));
    expect(sent[0]).toMatchObject({
      kind: 'transfer',
      amount: -SOAG_PER_BOAG * 2n,
      counterparty: idOf('second'),
      memo: 'おつかれさま',
    });

    const received = recentMovements(db(), idOf('second'));
    expect(received[0]).toMatchObject({
      kind: 'transfer',
      amount: SOAG_PER_BOAG * 2n,
      counterparty: idOf('kazuhiro'),
    });

    // 発行は特別口座からの動きとして出る。
    const mintRow = sent.find((movement) => movement.kind === 'mint');
    expect(mintRow?.counterparty).toBe(SUPPLY_ACCOUNT);
  });
});

describe('焼却', () => {
  it('総量が減る', () => {
    const to = idOf('kazuhiro');
    mint(db(), { to, amount: 100n, ref: 'p1', now: T0 });
    expect(burn(db(), { from: to, amount: 40n, now: T0 + 1 }).ok).toBe(true);
    expect(balanceOf(db(), to)).toBe(60n);
    expect(totalIssued(db())).toBe(60n);
    expect(verifyLedger(db()).ok).toBe(true);
  });
});

describe('検査', () => {
  it('行を直接書き換えると不整合を見つける', () => {
    const to = idOf('kazuhiro');
    mint(db(), { to, amount: 100n, ref: 'p1', now: T0 });

    // 台帳を経由せずに残高を水増しする。
    handle.raw.prepare("UPDATE ledger_entries SET amount = '999' WHERE amount = '100'").run();

    const result = verifyLedger(db());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.imbalance).not.toBe(0n);
  });

  it('行を消しても見つける', () => {
    mint(db(), { to: idOf('kazuhiro'), amount: 100n, ref: 'p1', now: T0 });
    handle.raw.prepare('DELETE FROM ledger_entries WHERE account_id = ?').run(SUPPLY_ACCOUNT);
    expect(verifyLedger(db()).ok).toBe(false);
  });

  it('残高の一覧が取れる', () => {
    addActiveMember('kazuhiro', 'second');
    mint(db(), { to: idOf('kazuhiro'), amount: 100n, ref: 'p1', now: T0 });
    mint(db(), { to: idOf('second'), amount: 300n, ref: 'p2', now: T0 });

    const balances = allBalances(db());
    expect(balances[0]?.balance).toBe(300n);
    expect(balances.find((b) => b.accountId === SUPPLY_ACCOUNT)?.balance).toBe(-400n);
  });
});

describe('発行は過半数の承認を要する', () => {
  it('1 人しかいなければ自分では発行できない', () => {
    // 発行先が自分なので有権者から外れ、承認できる人がいなくなる。
    const result = createProposal(db(), {
      type: 'ledger.mint',
      proposedBy: idOf('kazuhiro'),
      subjectMemberId: idOf('kazuhiro'),
      payload: { amount: '1000' },
      now: T0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.view.deadlocked).toBe(true);
    expect(result.view.status).toBe('open');
    expect(balanceOf(db(), idOf('kazuhiro'))).toBe(0n);
  });

  it('小数の額も 16 桁までなら発行できる', () => {
    addActiveMember('kazuhiro', 'second');
    const result = createProposal(db(), {
      type: 'ledger.mint',
      proposedBy: idOf('kazuhiro'),
      subjectMemberId: idOf('second'),
      payload: { amount: '0.0000000000000001' },
      now: T0,
    });
    expect(result.ok && result.view.status).toBe('executed');
    expect(balanceOf(db(), idOf('second'))).toBe(1n);
  });

  it('他人宛なら自分の 1 票で通る', () => {
    addActiveMember('kazuhiro', 'second');
    const result = createProposal(db(), {
      type: 'ledger.mint',
      proposedBy: idOf('kazuhiro'),
      subjectMemberId: idOf('second'),
      payload: { amount: '1000', memo: '初期配布' },
      now: T0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 有権者は発行先を除いた kazuhiro のみ。
    expect(result.view.tally.eligible).toEqual([idOf('kazuhiro')]);
    expect(result.view.status).toBe('executed');
    // 提案の額は BOAG で書き、台帳には SOAG の整数で入る。
    expect(balanceOf(db(), idOf('second'))).toBe(1000n * SOAG_PER_BOAG);
    expect(verifyLedger(db()).ok).toBe(true);
  });

  it('3 人いれば 2 票必要', () => {
    addActiveMember('kazuhiro', 'second');
    addActiveMember('kazuhiro', 'third');

    const result = createProposal(db(), {
      type: 'ledger.mint',
      proposedBy: idOf('kazuhiro'),
      subjectMemberId: idOf('third'),
      payload: { amount: '50' },
      now: T0,
    });
    if (!result.ok) return;
    expect(result.view.tally.required).toBe(2);
    expect(result.view.status).toBe('open');
    expect(balanceOf(db(), idOf('third'))).toBe(0n);

    const voted = castVote(db(), {
      proposalId: result.view.id,
      memberId: idOf('second'),
      choice: 'approve',
      now: T0 + 1000,
    });
    expect(voted.ok).toBe(true);
    expect(balanceOf(db(), idOf('third'))).toBe(50n * SOAG_PER_BOAG);
  });

  it('否決されれば発行されない', () => {
    addActiveMember('kazuhiro', 'second');
    addActiveMember('kazuhiro', 'third');

    const result = createProposal(db(), {
      type: 'ledger.mint',
      proposedBy: idOf('kazuhiro'),
      subjectMemberId: idOf('third'),
      payload: { amount: '50' },
      now: T0,
      proposerApproves: false,
    });
    if (!result.ok) return;

    castVote(db(), {
      proposalId: result.view.id,
      memberId: idOf('kazuhiro'),
      choice: 'reject',
      now: T0 + 1000,
    });
    castVote(db(), {
      proposalId: result.view.id,
      memberId: idOf('second'),
      choice: 'reject',
      now: T0 + 2000,
    });

    expect(balanceOf(db(), idOf('third'))).toBe(0n);
    expect(totalIssued(db())).toBe(0n);
  });

  it('二重に決着させても 1 回しか発行されない', () => {
    addActiveMember('kazuhiro', 'second');
    const result = createProposal(db(), {
      type: 'ledger.mint',
      proposedBy: idOf('kazuhiro'),
      subjectMemberId: idOf('second'),
      payload: { amount: '1000' },
      now: T0,
    });
    if (!result.ok) return;

    expect(balanceOf(db(), idOf('second'))).toBe(1000n * SOAG_PER_BOAG);
    expect(db().select().from(ledgerEntries).all()).toHaveLength(2);
  });

  it('額が不正なら提案を作れない', () => {
    addActiveMember('kazuhiro', 'second');
    for (const amount of ['0', '-5', 'abc', '', '0.00000000000000001']) {
      const result = createProposal(db(), {
        type: 'ledger.mint',
        proposedBy: idOf('kazuhiro'),
        subjectMemberId: idOf('second'),
        payload: { amount },
        now: T0,
      });
      expect(result.ok).toBe(false);
    }
  });

  it('監査ログが壊れない', () => {
    addActiveMember('kazuhiro', 'second');
    createProposal(db(), {
      type: 'ledger.mint',
      proposedBy: idOf('kazuhiro'),
      subjectMemberId: idOf('second'),
      payload: { amount: '1000' },
      now: T0,
    });
    expect(verifyAuditLog(db()).ok).toBe(true);
  });
});

describe('金額の読み書き', () => {
  it('入力を BOAG として読み、SOAG の整数にする', () => {
    expect(parseAmount('1000')).toBe(1000n * 10n ** 16n);
    expect(parseAmount(' 1,000 ')).toBe(1000n * 10n ** 16n);
    expect(parseAmount('1.5')).toBe(15n * 10n ** 15n);
    expect(parseAmount('0.0000000000000001')).toBe(1n);
    expect(parseAmount('0')).toBeUndefined();
    expect(parseAmount('-1')).toBeUndefined();
    expect(parseAmount('0.00000000000000001')).toBeUndefined();
    expect(parseAmount('abc')).toBeUndefined();
    expect(parseAmount('')).toBeUndefined();
  });

  it('SOAG を BOAG として表示する', () => {
    expect(formatAmount(1234567n * 10n ** 16n)).toBe('1,234,567');
    expect(formatAmount(1n)).toBe('0.0000000000000001');
    expect(formatAmount(-25n * 10n ** 15n)).toBe('-2.5');
  });
});
