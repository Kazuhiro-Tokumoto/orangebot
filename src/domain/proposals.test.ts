import { beforeEach, describe, expect, it } from 'vitest';
import { verifyAuditLog } from '../db/audit.js';
import { openTestDatabase, type Database_ } from '../db/client.js';
import { getMemberByUsername, listActiveMembers, listAllMembers } from '../db/members.js';
import { activateMember, createGenesisMember } from './members.js';
import {
  DEFAULT_PROPOSAL_TTL_MS,
  castVote,
  createProposal,
  getProposal,
  settle,
  settleExpired,
} from './proposals.js';
import { findUsableTicket } from './tickets.js';

const T0 = 1_700_000_000_000;

let handle: Database_;

function db() {
  return handle.db;
}

function idOf(username: string): string {
  const member = getMemberByUsername(db(), username);
  if (member === undefined) throw new Error(`メンバーがいません: ${username}`);
  return member.id;
}

/** 提案を通してメンバーを増やし、登録まで済ませて有権者にする。 */
function addActiveMember(proposer: string, username: string, now = T0): string {
  const result = createProposal(db(), {
    type: 'member.add',
    proposedBy: idOf(proposer),
    payload: { username, displayName: username.toUpperCase() },
    now,
  });
  if (!result.ok) throw new Error(`追加に失敗: ${result.reason}`);

  // 提案者の 1 票では足りないぶんを、残りの有権者から集める。
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

  // 可決しただけでは pending。本人の登録が済んで初めて active になる。
  if (view.status !== 'executed') {
    throw new Error(`まだ可決していません: ${view.status}`);
  }
  const id = idOf(username);
  activateMember(db(), id, now);
  return id;
}

beforeEach(() => {
  handle = openTestDatabase();
  createGenesisMember(db(), {
    username: 'kazuhiro',
    displayName: '徳本 和寛',
    now: T0,
  });
});

describe('最初の 1 人', () => {
  it('genesis で作れるのは 1 回だけ', () => {
    const second = createGenesisMember(db(), {
      username: 'someone',
      displayName: 'Someone',
      now: T0,
    });
    expect(second.ok).toBe(false);
  });

  it('1 人だけなので提案は即座に可決して実行される', () => {
    const result = createProposal(db(), {
      type: 'member.add',
      proposedBy: idOf('kazuhiro'),
      payload: { username: 'second', displayName: 'Second' },
      now: T0,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.view.tally.required).toBe(1);
    expect(result.view.status).toBe('executed');
  });

  it('追加されたメンバーは登録が済むまで有権者に入らない', () => {
    createProposal(db(), {
      type: 'member.add',
      proposedBy: idOf('kazuhiro'),
      payload: { username: 'second', displayName: 'Second' },
      now: T0,
    });

    expect(getMemberByUsername(db(), 'second')?.status).toBe('pending');
    expect(listActiveMembers(db())).toHaveLength(1);
  });
});

describe('2 人になったあと', () => {
  beforeEach(() => {
    addActiveMember('kazuhiro', 'second');
  });

  it('提案者 1 人の賛成では足りず、2 票目で可決する', () => {
    const created = createProposal(db(), {
      type: 'member.add',
      proposedBy: idOf('kazuhiro'),
      payload: { username: 'third', displayName: 'Third' },
      now: T0,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(created.view.tally.required).toBe(2);
    expect(created.view.tally.approvals).toBe(1);
    expect(created.view.status).toBe('open');

    const voted = castVote(db(), {
      proposalId: created.view.id,
      memberId: idOf('second'),
      choice: 'approve',
      now: T0 + 1000,
    });
    expect(voted.ok).toBe(true);
    if (!voted.ok) return;
    expect(voted.view.status).toBe('executed');
    expect(getMemberByUsername(db(), 'third')?.status).toBe('pending');
  });

  it('1 人が反対すれば過半数に届かず否決される', () => {
    const created = createProposal(db(), {
      type: 'member.add',
      proposedBy: idOf('kazuhiro'),
      payload: { username: 'third', displayName: 'Third' },
      now: T0,
    });
    if (!created.ok) return;

    const voted = castVote(db(), {
      proposalId: created.view.id,
      memberId: idOf('second'),
      choice: 'reject',
      now: T0 + 1000,
    });
    expect(voted.ok).toBe(true);
    if (!voted.ok) return;
    expect(voted.view.status).toBe('rejected');
    expect(getMemberByUsername(db(), 'third')).toBeUndefined();
  });

  it('決着した提案には投票できない', () => {
    const created = createProposal(db(), {
      type: 'member.add',
      proposedBy: idOf('kazuhiro'),
      payload: { username: 'third', displayName: 'Third' },
      now: T0,
    });
    if (!created.ok) return;
    castVote(db(), {
      proposalId: created.view.id,
      memberId: idOf('second'),
      choice: 'approve',
      now: T0 + 1000,
    });

    const again = castVote(db(), {
      proposalId: created.view.id,
      memberId: idOf('second'),
      choice: 'reject',
      now: T0 + 2000,
    });
    expect(again.ok).toBe(false);
  });

  it('加入待ちのメンバーは投票できない', () => {
    // まず third を可決まで持っていく。登録前なので status は pending のまま。
    const add = createProposal(db(), {
      type: 'member.add',
      proposedBy: idOf('kazuhiro'),
      payload: { username: 'third', displayName: 'Third' },
      now: T0,
    });
    if (!add.ok) return;
    castVote(db(), {
      proposalId: add.view.id,
      memberId: idOf('second'),
      choice: 'approve',
      now: T0 + 1000,
    });
    expect(getMemberByUsername(db(), 'third')?.status).toBe('pending');

    const created = createProposal(db(), {
      type: 'member.add',
      proposedBy: idOf('kazuhiro'),
      payload: { username: 'fourth', displayName: 'Fourth' },
      now: T0 + 2000,
    });
    if (!created.ok) return;

    const result = castVote(db(), {
      proposalId: created.view.id,
      memberId: idOf('third'),
      choice: 'approve',
      now: T0 + 3000,
    });
    expect(result.ok).toBe(false);
  });

  it('可決した提案を再度決着させても効果は 1 回だけ', () => {
    const created = createProposal(db(), {
      type: 'member.add',
      proposedBy: idOf('kazuhiro'),
      payload: { username: 'third', displayName: 'Third' },
      now: T0,
    });
    if (!created.ok) return;
    castVote(db(), {
      proposalId: created.view.id,
      memberId: idOf('second'),
      choice: 'approve',
      now: T0 + 1000,
    });

    const before = listAllMembers(db()).length;
    settle(db(), created.view.id, T0 + 2000);
    settle(db(), created.view.id, T0 + 3000);
    expect(listAllMembers(db())).toHaveLength(before);
  });
});

describe('パスワード再発行', () => {
  it('申請者は有権者から外れ、残りの過半数で可決する', () => {
    addActiveMember('kazuhiro', 'second');

    const created = createProposal(db(), {
      type: 'credential.password_reset',
      // 未ログインからの申請なので提案者はいない。
      proposedBy: null,
      subjectMemberId: idOf('second'),
      now: T0,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(created.view.tally.eligible).toEqual([idOf('kazuhiro')]);
    expect(created.view.tally.required).toBe(1);
    expect(created.view.status).toBe('open');
    expect(created.resetToken).toBeTypeOf('string');

    // 承認前の券はまだ使えない。
    const before = findUsableTicket(db(), 'password_reset', created.resetToken!, T0);
    expect(before.ok).toBe(false);

    const voted = castVote(db(), {
      proposalId: created.view.id,
      memberId: idOf('kazuhiro'),
      choice: 'approve',
      now: T0 + 1000,
    });
    expect(voted.ok).toBe(true);
    if (!voted.ok) return;
    expect(voted.view.status).toBe('executed');

    const after = findUsableTicket(db(), 'password_reset', created.resetToken!, T0 + 2000);
    expect(after.ok).toBe(true);
  });

  it('本人 1 人しかいなければデッドロックし、券は有効にならない', () => {
    const created = createProposal(db(), {
      type: 'credential.password_reset',
      proposedBy: null,
      subjectMemberId: idOf('kazuhiro'),
      now: T0,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(created.view.deadlocked).toBe(true);
    expect(created.view.tally.electorateSize).toBe(0);
    expect(created.view.status).toBe('open');

    const lookup = findUsableTicket(db(), 'password_reset', created.resetToken!, T0);
    expect(lookup.ok).toBe(false);
    if (!lookup.ok) expect(lookup.reason).toContain('承認');
  });

  it('本人は自分の再発行を承認できない', () => {
    addActiveMember('kazuhiro', 'second');
    const created = createProposal(db(), {
      type: 'credential.password_reset',
      proposedBy: null,
      subjectMemberId: idOf('second'),
      now: T0,
    });
    if (!created.ok) return;

    const result = castVote(db(), {
      proposalId: created.view.id,
      memberId: idOf('second'),
      choice: 'approve',
      now: T0 + 1000,
    });
    expect(result.ok).toBe(false);
  });
});

describe('除名と停止', () => {
  it('最後の 1 人は除名できない', () => {
    const result = createProposal(db(), {
      type: 'member.remove',
      proposedBy: idOf('kazuhiro'),
      subjectMemberId: idOf('kazuhiro'),
      now: T0,
    });
    expect(result.ok).toBe(false);
  });

  it('停止されたメンバーの票は無効化され、母数からも外れる', () => {
    addActiveMember('kazuhiro', 'bravo');
    addActiveMember('kazuhiro', 'carol');
    expect(listActiveMembers(db())).toHaveLength(3);

    // 3 人で 2 票必要。提案者の 1 票と c の反対で拮抗させる。
    const p1 = createProposal(db(), {
      type: 'member.add',
      proposedBy: idOf('kazuhiro'),
      payload: { username: 'newbie', displayName: 'Newbie' },
      now: T0,
    });
    if (!p1.ok) return;
    castVote(db(), {
      proposalId: p1.view.id,
      memberId: idOf('carol'),
      choice: 'reject',
      now: T0 + 1000,
    });
    expect(getProposal(db(), p1.view.id, T0 + 1000)?.status).toBe('open');

    // c を停止する。有権者は c を除いた 2 人なので 2 票必要。
    const p2 = createProposal(db(), {
      type: 'member.suspend',
      proposedBy: idOf('kazuhiro'),
      subjectMemberId: idOf('carol'),
      now: T0 + 2000,
    });
    if (!p2.ok) return;
    expect(p2.view.tally.eligible).not.toContain(idOf('carol'));
    castVote(db(), {
      proposalId: p2.view.id,
      memberId: idOf('bravo'),
      choice: 'approve',
      now: T0 + 3000,
    });
    expect(getMemberByUsername(db(), 'carol')?.status).toBe('suspended');

    // p1 の母数から c が抜け、c の反対票も消えている。
    const after = getProposal(db(), p1.view.id, T0 + 4000);
    expect(after?.tally.electorateSize).toBe(2);
    expect(after?.tally.rejections).toBe(0);
    expect(after?.tally.approvals).toBe(1);
    expect(after?.status).toBe('open');

    // 残った b が賛成すれば 2 票で可決する。
    const final = castVote(db(), {
      proposalId: p1.view.id,
      memberId: idOf('bravo'),
      choice: 'approve',
      now: T0 + 5000,
    });
    expect(final.ok).toBe(true);
    if (final.ok) expect(final.view.status).toBe('executed');
  });
});

describe('期限切れ', () => {
  it('期限を過ぎた提案は expired になる', () => {
    addActiveMember('kazuhiro', 'second');
    const created = createProposal(db(), {
      type: 'member.add',
      proposedBy: idOf('kazuhiro'),
      payload: { username: 'third', displayName: 'Third' },
      now: T0,
    });
    if (!created.ok) return;
    expect(created.view.status).toBe('open');

    const changed = settleExpired(db(), T0 + DEFAULT_PROPOSAL_TTL_MS + 1);
    expect(changed).toBe(1);
    expect(getProposal(db(), created.view.id)?.status).toBe('expired');
  });
});

describe('監査ログ', () => {
  it('一連の操作を通しても連鎖が壊れない', () => {
    addActiveMember('kazuhiro', 'second');
    const created = createProposal(db(), {
      type: 'member.add',
      proposedBy: idOf('kazuhiro'),
      payload: { username: 'third', displayName: 'Third' },
      now: T0,
    });
    if (created.ok) {
      castVote(db(), {
        proposalId: created.view.id,
        memberId: idOf('second'),
        choice: 'approve',
        now: T0 + 1000,
      });
    }

    expect(verifyAuditLog(db()).ok).toBe(true);
  });
});
