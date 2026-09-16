import { describe, expect, it } from 'vitest';
import {
  canVote,
  eligibleVoters,
  evaluate,
  excludesSubject,
  requiredApprovals,
  tally,
  validateProposal,
  type Ballot,
  type MemberStatus,
  type ProposalType,
  type VoterSnapshot,
} from './governance.js';

type VoterSpec = string | readonly [string, MemberStatus];

function voters(...entries: VoterSpec[]): VoterSnapshot[] {
  return entries.map((entry) =>
    typeof entry === 'string'
      ? { memberId: entry, status: 'active' }
      : { memberId: entry[0], status: entry[1] },
  );
}

function approve(...ids: string[]): Ballot[] {
  return ids.map((memberId) => ({ memberId, choice: 'approve' as const }));
}

function reject(...ids: string[]): Ballot[] {
  return ids.map((memberId) => ({ memberId, choice: 'reject' as const }));
}

const OPEN = {
  type: 'member.add' as ProposalType,
  subjectMemberId: null,
  status: 'open' as const,
  expiresAt: 2_000,
  now: 1_000,
};

describe('requiredApprovals', () => {
  it('厳密な過半数になる', () => {
    const table = new Map<number, number>([
      [1, 1],
      [2, 2],
      [3, 2],
      [4, 3],
      [5, 3],
      [6, 4],
      [7, 4],
      [8, 5],
      [9, 5],
      [10, 6],
    ]);
    for (const [size, expected] of table) {
      expect(requiredApprovals(size)).toBe(expected);
    }
  });

  it('どの人数でも必要数が半数を超える', () => {
    for (let n = 1; n <= 100; n += 1) {
      expect(requiredApprovals(n) * 2).toBeGreaterThan(n);
    }
  });

  it('過半数に届く最小の数を返す', () => {
    for (let n = 1; n <= 100; n += 1) {
      expect((requiredApprovals(n) - 1) * 2).toBeLessThanOrEqual(n);
    }
  });

  it('不正な入力を弾く', () => {
    expect(() => requiredApprovals(-1)).toThrow(RangeError);
    expect(() => requiredApprovals(1.5)).toThrow(RangeError);
  });
});

describe('メンバーが 1 人だけの状態', () => {
  const solo = { ...OPEN, voters: voters('kazuhiro') };

  it('単独で承認すれば可決する', () => {
    const result = evaluate({ ...solo, ballots: approve('kazuhiro') });
    expect(result.tally.required).toBe(1);
    expect(result.nextStatus).toBe('approved');
  });

  it('単独で反対すれば即座に否決される', () => {
    const result = evaluate({ ...solo, ballots: reject('kazuhiro') });
    expect(result.nextStatus).toBe('rejected');
  });

  it('投票しなければ未決のまま', () => {
    const result = evaluate({ ...solo, ballots: [] });
    expect(result.nextStatus).toBe('open');
    expect(result.tally.outstanding).toBe(1);
  });
});

describe('有権者が増えたときの挙動', () => {
  it('3 人なら 2 票で可決し、3 人目を待たない', () => {
    const result = evaluate({
      ...OPEN,
      voters: voters('a', 'b', 'c'),
      ballots: approve('a', 'b'),
    });
    expect(result.tally.required).toBe(2);
    expect(result.tally.outstanding).toBe(1);
    expect(result.nextStatus).toBe('approved');
  });

  it('3 人で 2 票反対されたら、残り 1 人を待たずに否決される', () => {
    const result = evaluate({
      ...OPEN,
      voters: voters('a', 'b', 'c'),
      ballots: reject('a', 'b'),
    });
    expect(result.nextStatus).toBe('rejected');
  });

  it('3 人で 1 賛成 1 反対ならまだ決まらない', () => {
    const result = evaluate({
      ...OPEN,
      voters: voters('a', 'b', 'c'),
      ballots: [...approve('a'), ...reject('b')],
    });
    expect(result.nextStatus).toBe('open');
  });

  it('4 人では 3 票必要で、2 対 2 は否決になる', () => {
    const result = evaluate({
      ...OPEN,
      voters: voters('a', 'b', 'c', 'd'),
      ballots: [...approve('a', 'b'), ...reject('c', 'd')],
    });
    expect(result.tally.required).toBe(3);
    expect(result.nextStatus).toBe('rejected');
  });

  it('棄権は賛成としては数えられず、期限切れで流れる', () => {
    const base = { ...OPEN, voters: voters('a', 'b', 'c'), ballots: approve('a') };
    expect(evaluate(base).nextStatus).toBe('open');
    expect(evaluate({ ...base, now: base.expiresAt }).nextStatus).toBe('expired');
  });
});

describe('有権者スナップショット', () => {
  it('投票中に加入した人は母数に入らない', () => {
    // スナップショットは a と b だけ。c は提案が立った後に加入したのでここには現れない。
    const result = tally({
      type: 'member.add',
      subjectMemberId: null,
      voters: voters('a', 'b'),
      ballots: [...approve('a'), ...approve('c')],
    });
    expect(result.electorateSize).toBe(2);
    expect(result.required).toBe(2);
    expect(result.approvals).toBe(1);
    expect(result.outcome).toBe('open');
  });

  it('離脱したメンバーは母数から外れ、票も数えられない', () => {
    const result = tally({
      type: 'member.add',
      subjectMemberId: null,
      voters: voters('a', 'b', ['c', 'removed']),
      ballots: approve('a', 'c'),
    });
    expect(result.eligible).toEqual(['a', 'b']);
    expect(result.approvals).toBe(1);
    expect(result.required).toBe(2);
  });

  it('停止中と加入前のメンバーも母数から外れる', () => {
    const result = tally({
      type: 'member.add',
      subjectMemberId: null,
      voters: voters('a', ['b', 'suspended'], ['c', 'pending']),
      ballots: approve('a'),
    });
    expect(result.eligible).toEqual(['a']);
    expect(result.outcome).toBe('approved');
  });

  it('無効化された票は数えない', () => {
    const result = tally({
      type: 'member.add',
      subjectMemberId: null,
      voters: voters('a', 'b', 'c'),
      ballots: [{ memberId: 'a', choice: 'approve', voided: true }, ...approve('b')],
    });
    expect(result.approvals).toBe(1);
    expect(result.outcome).toBe('open');
  });

  it('同じ人が投票し直したら最後の票だけ有効', () => {
    const result = tally({
      type: 'member.add',
      subjectMemberId: null,
      voters: voters('a', 'b', 'c'),
      ballots: [
        { memberId: 'a', choice: 'reject' },
        { memberId: 'a', choice: 'approve' },
        ...approve('b'),
      ],
    });
    expect(result.approvals).toBe(2);
    expect(result.rejections).toBe(0);
    expect(result.outcome).toBe('approved');
  });
});

describe('利害関係者の除外', () => {
  it('パスワード再発行では申請者本人が有権者から外れる', () => {
    const input = {
      type: 'credential.password_reset' as ProposalType,
      subjectMemberId: 'b',
      voters: voters('a', 'b', 'c'),
    };
    expect(eligibleVoters(input)).toEqual(['a', 'c']);
    expect(canVote(input, 'b')).toBe(false);
    expect(canVote(input, 'a')).toBe(true);
  });

  it('本人を除いた過半数で可決する', () => {
    // 有権者は a と c の 2 人なので 2 票必要。
    const base = {
      ...OPEN,
      type: 'credential.password_reset' as ProposalType,
      subjectMemberId: 'b',
      voters: voters('a', 'b', 'c'),
    };
    expect(evaluate({ ...base, ballots: approve('a') }).nextStatus).toBe('open');
    expect(evaluate({ ...base, ballots: approve('a', 'c') }).nextStatus).toBe('approved');
  });

  it('本人の票は投じられても無視される', () => {
    const result = tally({
      type: 'credential.password_reset',
      subjectMemberId: 'b',
      voters: voters('a', 'b', 'c'),
      ballots: approve('a', 'b'),
    });
    expect(result.approvals).toBe(1);
    expect(result.outcome).toBe('open');
  });

  it('除名提案では対象者が投票できない', () => {
    const input = {
      type: 'member.remove' as ProposalType,
      subjectMemberId: 'c',
      voters: voters('a', 'b', 'c'),
    };
    expect(eligibleVoters(input)).toEqual(['a', 'b']);
  });

  it('メンバー追加は誰も除外しない', () => {
    expect(excludesSubject('member.add')).toBe(false);
    expect(
      eligibleVoters({ type: 'member.add', subjectMemberId: 'x', voters: voters('a', 'b') }),
    ).toEqual(['a', 'b']);
  });
});

describe('デッドロック', () => {
  it('本人 1 人しかいない状態のパスワード再発行は承認では進まない', () => {
    const result = evaluate({
      ...OPEN,
      type: 'credential.password_reset',
      subjectMemberId: 'kazuhiro',
      voters: voters('kazuhiro'),
      ballots: [],
    });
    expect(result.tally.electorateSize).toBe(0);
    expect(result.deadlocked).toBe(true);
    expect(result.nextStatus).toBe('open');
    // 必要数 1 に対して有権者 0 人。承認では到達できないことが数に表れている。
    expect(result.tally.required).toBe(1);
  });

  it('2 人目がいればデッドロックしない', () => {
    const result = evaluate({
      ...OPEN,
      type: 'credential.password_reset',
      subjectMemberId: 'kazuhiro',
      voters: voters('kazuhiro', 'second'),
      ballots: approve('second'),
    });
    expect(result.deadlocked).toBe(false);
    expect(result.nextStatus).toBe('approved');
  });

  it('最後の有効メンバーは除名できない', () => {
    const result = validateProposal({
      type: 'member.remove',
      subjectMemberId: 'kazuhiro',
      activeMemberIds: ['kazuhiro'],
    });
    expect(result.ok).toBe(false);
  });

  it('メンバーが 2 人いれば除名提案を作れる', () => {
    const result = validateProposal({
      type: 'member.remove',
      subjectMemberId: 'second',
      activeMemberIds: ['kazuhiro', 'second'],
    });
    expect(result.ok).toBe(true);
  });

  it('対象者のいない除名提案は作れない', () => {
    const result = validateProposal({
      type: 'member.remove',
      subjectMemberId: null,
      activeMemberIds: ['a', 'b'],
    });
    expect(result.ok).toBe(false);
  });
});

describe('決着済みの提案', () => {
  it.each(['approved', 'rejected', 'executed', 'expired', 'cancelled'] as const)(
    '%s の提案は再評価しても状態が変わらない',
    (status) => {
      const result = evaluate({
        ...OPEN,
        status,
        voters: voters('a', 'b', 'c'),
        ballots: reject('a', 'b', 'c'),
      });
      expect(result.nextStatus).toBe(status);
    },
  );
});
