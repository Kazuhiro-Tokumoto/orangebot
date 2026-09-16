/**
 * 合議制の中核。過半数承認の判定をここに閉じ込める。
 *
 * このモジュールは DB にもフレームワークにも依存しない純粋関数だけで構成する。
 * 意思決定のルールを 1 か所に集め、単体テストで網羅できるようにするため。
 */

export type MemberStatus = 'pending' | 'active' | 'suspended' | 'removed';

export type VoteChoice = 'approve' | 'reject';

export type ProposalStatus =
  | 'open'
  | 'approved'
  | 'rejected'
  | 'executed'
  | 'expired'
  | 'cancelled';

export type ProposalType =
  | 'member.add'
  | 'member.remove'
  | 'member.suspend'
  | 'member.reinstate'
  | 'credential.password_reset'
  | 'credential.factor_reset';

export const PROPOSAL_TYPES: readonly ProposalType[] = [
  'member.add',
  'member.remove',
  'member.suspend',
  'member.reinstate',
  'credential.password_reset',
  'credential.factor_reset',
];

export function isProposalType(value: string): value is ProposalType {
  return (PROPOSAL_TYPES as readonly string[]).includes(value);
}

/** 画面や Discord に出す日本語のラベル。 */
export const PROPOSAL_TYPE_LABELS: Readonly<Record<ProposalType, string>> = {
  'member.add': 'メンバーの追加',
  'member.remove': 'メンバーの除名',
  'member.suspend': 'メンバーの一時停止',
  'member.reinstate': 'メンバーの復帰',
  'credential.password_reset': 'パスワードの再発行',
  'credential.factor_reset': '二要素認証の再登録',
};

/**
 * 対象者本人が有権者から外れる提案の種類。
 * 自分の除名に反対したり、自分のパスワード再発行を自分で承認したりできないようにする。
 */
const SUBJECT_EXCLUDED_TYPES: ReadonlySet<ProposalType> = new Set<ProposalType>([
  'member.remove',
  'member.suspend',
  'credential.password_reset',
  'credential.factor_reset',
]);

/** 可決すると対象者が active でなくなる提案の種類。 */
const DEACTIVATING_TYPES: ReadonlySet<ProposalType> = new Set<ProposalType>([
  'member.remove',
  'member.suspend',
]);

export function excludesSubject(type: ProposalType): boolean {
  return SUBJECT_EXCLUDED_TYPES.has(type);
}

/**
 * 有権者 n 人に対して必要な承認数。厳密な過半数、すなわち floor(n / 2) + 1。
 *
 *   1 -> 1, 2 -> 2, 3 -> 2, 4 -> 3, 5 -> 3, 6 -> 4, 7 -> 4, 10 -> 6
 *
 * 母数は「投票した人」ではなく「有権者全員」なので、棄権は事実上の反対として働く。
 * n = 0 のときは 1 を返す。有権者がいない以上到達不能であることを、そのまま数で表している。
 */
export function requiredApprovals(electorateSize: number): number {
  if (!Number.isInteger(electorateSize) || electorateSize < 0) {
    throw new RangeError(`有権者数は 0 以上の整数である必要があります: ${String(electorateSize)}`);
  }
  return Math.floor(electorateSize / 2) + 1;
}

/** 提案作成時にスナップショットした有権者と、その人の「現在の」状態。 */
export interface VoterSnapshot {
  readonly memberId: string;
  readonly status: MemberStatus;
}

export interface Ballot {
  readonly memberId: string;
  readonly choice: VoteChoice;
  /** メンバーが離脱・停止された等の理由で無効化された票。 */
  readonly voided?: boolean;
}

export interface ElectorateInput {
  readonly type: ProposalType;
  readonly subjectMemberId: string | null;
  readonly voters: readonly VoterSnapshot[];
}

/**
 * 実際に票を投じられる人を求める。
 *
 * スナップショットに含まれていても、今 active でない人は母数から外れる。
 * 投票の途中で加入した人はそもそもスナップショットに入っていないので、票の水増しは起きない。
 */
export function eligibleVoters(input: ElectorateInput): readonly string[] {
  const excluded = excludesSubject(input.type) ? input.subjectMemberId : null;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const voter of input.voters) {
    if (voter.status !== 'active') continue;
    if (voter.memberId === excluded) continue;
    if (seen.has(voter.memberId)) continue;
    seen.add(voter.memberId);
    result.push(voter.memberId);
  }
  return result;
}

export type TallyOutcome = 'open' | 'approved' | 'rejected' | 'deadlocked';

export interface TallyResult {
  readonly eligible: readonly string[];
  readonly electorateSize: number;
  readonly required: number;
  readonly approvals: number;
  readonly rejections: number;
  /** まだ投票していない有権者の数。 */
  readonly outstanding: number;
  readonly outcome: TallyOutcome;
}

export interface TallyInput extends ElectorateInput {
  readonly ballots: readonly Ballot[];
}

/**
 * 票を集計して、その時点の結論を出す。
 *
 * 可決は承認数が必要数に届いた時点で確定する。全員の投票は待たない。
 * 否決は「残り全員が賛成しても必要数に届かない」時点で確定する。
 *   反対票 > 有権者数 - 必要承認数
 */
export function tally(input: TallyInput): TallyResult {
  const eligible = eligibleVoters(input);
  const eligibleSet = new Set(eligible);

  // 1 人 1 票に正規化する。同じ人の票が複数あれば最後のものを採る。
  const effective = new Map<string, VoteChoice>();
  for (const ballot of input.ballots) {
    if (ballot.voided === true) continue;
    if (!eligibleSet.has(ballot.memberId)) continue;
    effective.set(ballot.memberId, ballot.choice);
  }

  let approvals = 0;
  let rejections = 0;
  for (const choice of effective.values()) {
    if (choice === 'approve') approvals += 1;
    else rejections += 1;
  }

  const electorateSize = eligible.length;
  const required = requiredApprovals(electorateSize);
  const outstanding = electorateSize - effective.size;

  let outcome: TallyOutcome;
  if (electorateSize === 0) {
    // 利害関係者を除いた結果、承認できる人が誰もいない。承認では永久に進まない。
    outcome = 'deadlocked';
  } else if (approvals >= required) {
    outcome = 'approved';
  } else if (rejections > electorateSize - required) {
    outcome = 'rejected';
  } else {
    outcome = 'open';
  }

  return { eligible, electorateSize, required, approvals, rejections, outstanding, outcome };
}

export interface EvaluationInput extends TallyInput {
  readonly status: ProposalStatus;
  readonly expiresAt: number;
  readonly now: number;
}

export interface Evaluation {
  readonly tally: TallyResult;
  readonly nextStatus: ProposalStatus;
  /**
   * 有権者が 0 人で、承認による決着があり得ない状態。
   * パスワード再発行がここに落ちた場合はリカバリコードでしか復旧できない。
   */
  readonly deadlocked: boolean;
}

/**
 * 提案の次の状態を決める。決着済みの提案には触れない。
 */
export function evaluate(input: EvaluationInput): Evaluation {
  const result = tally(input);
  const deadlocked = result.outcome === 'deadlocked';

  if (input.status !== 'open') {
    return { tally: result, nextStatus: input.status, deadlocked };
  }
  if (input.now >= input.expiresAt) {
    return { tally: result, nextStatus: 'expired', deadlocked };
  }
  if (result.outcome === 'approved') {
    return { tally: result, nextStatus: 'approved', deadlocked };
  }
  if (result.outcome === 'rejected') {
    return { tally: result, nextStatus: 'rejected', deadlocked };
  }
  return { tally: result, nextStatus: 'open', deadlocked };
}

/** 指定のメンバーがこの提案に投票できるか。 */
export function canVote(input: ElectorateInput, memberId: string): boolean {
  return eligibleVoters(input).includes(memberId);
}

export type ProposalRejection =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * 提案を作ってよいかを検査する。
 *
 * active なメンバーが 0 人になる提案は、以後いかなる決定もできなくなるため作らせない。
 */
export function validateProposal(input: {
  readonly type: ProposalType;
  readonly subjectMemberId: string | null;
  readonly activeMemberIds: readonly string[];
}): ProposalRejection {
  const { type, subjectMemberId, activeMemberIds } = input;

  if (DEACTIVATING_TYPES.has(type)) {
    if (subjectMemberId === null) {
      return { ok: false, reason: `${type} には対象メンバーの指定が必要です` };
    }
    const remaining = activeMemberIds.filter((id) => id !== subjectMemberId);
    if (remaining.length === 0) {
      return {
        ok: false,
        reason: '最後の有効なメンバーは除名も停止もできません（組織の意思決定が不可能になるため）',
      };
    }
  }

  if (excludesSubject(type) && subjectMemberId === null) {
    return { ok: false, reason: `${type} には対象メンバーの指定が必要です` };
  }

  return { ok: true };
}
