import { beforeEach, describe, expect, it } from 'vitest';
import { verifyAuditLog } from '../db/audit.js';
import { openTestDatabase, type Database_ } from '../db/client.js';
import { members } from '../db/schema.js';
import { balanceOf, mint, verifyLedger } from './ledger.js';
import {
  MARKETS_ESCROW,
  MIN_OPEN_MS,
  STALE_AFTER_MS,
  getMarket,
  listMarkets,
  marketView,
  openMarketStakeTotal,
  placeMarketBet,
  refundStaleMarkets,
} from './markets.js';
import { castVote, createProposal } from './proposals.js';
import { SOAG_PER_BOAG } from './units.js';

const B = SOAG_PER_BOAG;
const T0 = 1_800_000_000_000;
const CLOSES = T0 + 3 * 24 * 60 * 60 * 1000;

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

/** 問いを出して、BOB の賛成で可決させる。 */
function openQuestion(closesAt = CLOSES, now = T0): string {
  const proposal = createProposal(db(), {
    type: 'market.open',
    proposedBy: ALICE,
    payload: { question: '週末までに雨が降る?', criteria: '気象庁の東京の観測で 1mm 以上', closesAt },
    now,
  });
  if (!proposal.ok) throw new Error(proposal.reason);
  expect(proposal.view.status).toBe('open');
  const vote = castVote(db(), { proposalId: proposal.view.id, memberId: BOB, choice: 'approve', now });
  if (!vote.ok) throw new Error(vote.reason);
  expect(vote.view.status).toBe('executed');

  const market = listMarkets(db()).find((view) => view.market.proposalId === proposal.view.id);
  if (market === undefined) throw new Error('問いが開いていない');
  return market.market.id;
}

function bet(memberId: string, marketId: string, side: string, amount: string, now = T0 + 1000) {
  return placeMarketBet(db(), { marketId, memberId, side, amount, now });
}

function resolve(marketId: string, outcome: string, now = CLOSES) {
  const proposal = createProposal(db(), {
    type: 'market.resolve',
    proposedBy: BOB,
    payload: { marketId, outcome },
    now,
  });
  if (!proposal.ok) return proposal;
  const vote = castVote(db(), { proposalId: proposal.view.id, memberId: CAROL, choice: 'approve', now });
  return vote;
}

function assertBooks(): void {
  expect(balanceOf(db(), MARKETS_ESCROW)).toBe(openMarketStakeTotal(db()));
  expect(verifyLedger(db()).ok).toBe(true);
  expect(verifyAuditLog(db()).ok).toBe(true);
}

beforeEach(() => {
  handle = openTestDatabase();
  addMember(ALICE, 'alice');
  addMember(BOB, 'bob');
  addMember(CAROL, 'carol');
});

describe('問いを出す', () => {
  it('可決するまで問いは開かない', () => {
    const proposal = createProposal(db(), {
      type: 'market.open',
      proposedBy: ALICE,
      payload: { question: '週末までに雨が降る?', criteria: '', closesAt: CLOSES },
      now: T0,
    });
    expect(proposal.ok && proposal.view.summary).toBe('みんなで予想の問い: 週末までに雨が降る?');
    expect(listMarkets(db())).toHaveLength(0);

    const id = openQuestion();
    expect(getMarket(db(), id)?.status).toBe('open');
  });

  it('問いと締め切りの形を確かめる', () => {
    const cases: Record<string, unknown>[] = [
      { question: '', closesAt: CLOSES },
      { question: 'あ'.repeat(201), closesAt: CLOSES },
      { question: '?', criteria: 'い'.repeat(1001), closesAt: CLOSES },
      { question: '?', closesAt: T0 + MIN_OPEN_MS - 1 },
      { question: '?', closesAt: T0 + 400 * 24 * 60 * 60 * 1000 },
      { question: '?', closesAt: '明日' },
      { question: '?', closesAt: null },
    ];
    for (const payload of cases) {
      expect(createProposal(db(), { type: 'market.open', proposedBy: ALICE, payload, now: T0 }).ok).toBe(false);
    }
  });

  it('可決までに締め切りを過ぎていたら、開かずに終わる', () => {
    const proposal = createProposal(db(), {
      type: 'market.open',
      proposedBy: ALICE,
      payload: { question: '?', criteria: '', closesAt: T0 + MIN_OPEN_MS },
      now: T0,
    });
    if (!proposal.ok) throw new Error(proposal.reason);
    castVote(db(), { proposalId: proposal.view.id, memberId: BOB, choice: 'approve', now: T0 + MIN_OPEN_MS });

    const [view] = listMarkets(db());
    expect(view?.market.status).toBe('refunded');
    expect(bet(ALICE, view?.market.id ?? '', 'yes', '1', T0 + MIN_OPEN_MS).ok).toBe(false);
  });
});

describe('賭ける', () => {
  it('締め切りまで賭けられ、両方には賭けられない', () => {
    const id = openQuestion();
    expect(bet(ALICE, id, 'yes', '10').ok).toBe(true);
    expect(bet(ALICE, id, 'yes', '5').ok).toBe(true);
    expect(bet(ALICE, id, 'no', '1').ok).toBe(false);
    expect(bet(BOB, id, 'maybe', '1').ok).toBe(false);
    expect(bet(BOB, id, 'no', '1', CLOSES).ok).toBe(false);
    expect(balanceOf(db(), ALICE)).toBe(85n * B);
    assertBooks();
  });
});

describe('判定', () => {
  it('締め切りの前には判定を提案できない', () => {
    const id = openQuestion();
    const early = resolve(id, 'yes', CLOSES - 1);
    expect(!early.ok && early.reason).toContain('締め切りの後');
  });

  it('当てた側で、外した側の賭け金を分ける', () => {
    const id = openQuestion();
    bet(ALICE, id, 'yes', '10', T0 + 1);
    bet(BOB, id, 'no', '30', T0 + 2);
    bet(CAROL, id, 'yes', '30', T0 + 3);

    const result = resolve(id, 'yes');
    expect(result.ok && result.view.summary).toBe('みんなで予想の判定: 週末までに雨が降る? → はい');
    expect(getMarket(db(), id)).toMatchObject({ status: 'resolved', outcome: 'yes' });
    expect(balanceOf(db(), ALICE)).toBe(90n * B + 17n * B + 5n * B / 10n);
    expect(balanceOf(db(), CAROL)).toBe(70n * B + 52n * B + 5n * B / 10n);
    expect(balanceOf(db(), BOB)).toBe(70n * B);
    expect(marketView(db(), id)?.bets.map((row) => row.payout)).toEqual([
      (175n * B / 10n).toString(),
      '0',
      (525n * B / 10n).toString(),
    ]);
    assertBooks();
  });

  it('無効なら全員に返す', () => {
    const id = openQuestion();
    bet(ALICE, id, 'yes', '10');
    bet(BOB, id, 'no', '30');
    expect(resolve(id, 'void').ok).toBe(true);
    expect(getMarket(db(), id)?.status).toBe('refunded');
    expect(balanceOf(db(), ALICE)).toBe(100n * B);
    expect(balanceOf(db(), BOB)).toBe(100n * B);
    assertBooks();
  });

  it('判定の提案は 1 つずつ。決着した問いにはもう出せない', () => {
    const id = openQuestion();
    const first = createProposal(db(), {
      type: 'market.resolve',
      proposedBy: BOB,
      payload: { marketId: id, outcome: 'yes' },
      now: CLOSES,
    });
    expect(first.ok).toBe(true);
    const second = createProposal(db(), {
      type: 'market.resolve',
      proposedBy: CAROL,
      payload: { marketId: id, outcome: 'no' },
      now: CLOSES,
    });
    expect(!second.ok && second.reason).toContain('もう判定の提案が出ています');

    if (!first.ok) return;
    castVote(db(), { proposalId: first.view.id, memberId: CAROL, choice: 'approve', now: CLOSES });
    const after = resolve(id, 'no', CLOSES + 1);
    expect(!after.ok && after.reason).toContain('もう決着');
  });

  it('知らない問いと、形の違う答えは断る', () => {
    const id = openQuestion();
    expect(resolve('nope', 'yes').ok).toBe(false);
    expect(resolve(id, 'maybe').ok).toBe(false);
  });

  it('締め切りから長く判定が決まらなければ、全員に返す', () => {
    const id = openQuestion();
    bet(ALICE, id, 'yes', '10');
    bet(BOB, id, 'no', '5');

    expect(refundStaleMarkets(db(), CLOSES + STALE_AFTER_MS - 1)).toBe(0);
    expect(refundStaleMarkets(db(), CLOSES + STALE_AFTER_MS)).toBe(1);
    expect(getMarket(db(), id)?.status).toBe('refunded');
    expect(balanceOf(db(), ALICE)).toBe(100n * B);
    assertBooks();
  });

  it('返金の後に判定の提案が可決しても、二重に払わない', () => {
    const id = openQuestion();
    bet(ALICE, id, 'yes', '10');
    bet(BOB, id, 'no', '5');
    const now = CLOSES + STALE_AFTER_MS - 1000;
    const proposal = createProposal(db(), {
      type: 'market.resolve',
      proposedBy: BOB,
      payload: { marketId: id, outcome: 'yes' },
      now,
    });
    if (!proposal.ok) throw new Error(proposal.reason);

    refundStaleMarkets(db(), CLOSES + STALE_AFTER_MS);
    castVote(db(), { proposalId: proposal.view.id, memberId: CAROL, choice: 'approve', now: now + 2000 });

    expect(balanceOf(db(), ALICE)).toBe(100n * B);
    expect(balanceOf(db(), BOB)).toBe(100n * B);
    assertBooks();
  });
});
