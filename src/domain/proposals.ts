import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { appendAudit } from '../db/audit.js';
import type { Db } from '../db/client.js';
import { getMember, getMemberByUsername, listActiveMembers, setMemberStatus } from '../db/members.js';
import {
  members,
  passkeys,
  passwordCredentials,
  proposalVoters,
  proposals,
  sessions,
  totpCredentials,
  votes,
  type MemberRow,
  type ProposalRow,
} from '../db/schema.js';
import {
  PROPOSAL_TYPE_LABELS,
  evaluate,
  validateProposal,
  type Ballot,
  type ProposalType,
  type TallyResult,
  type VoterSnapshot,
  type VoteChoice,
} from './governance.js';
import {
  activateTicketsForProposal,
  issueTicket,
  revokeOpenTickets,
  revokeTicketsForProposal,
} from './tickets.js';

export const DEFAULT_PROPOSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_-]{1,38}$/;

export interface MemberAddPayload {
  readonly username: string;
  readonly displayName: string;
  readonly discordId: string | null;
}

export interface VoteView {
  readonly memberId: string;
  readonly choice: VoteChoice;
  readonly votedAt: number;
  readonly voided: boolean;
}

export interface ProposalView {
  readonly id: string;
  readonly type: ProposalType;
  readonly status: ProposalRow['status'];
  readonly summary: string;
  readonly payload: Record<string, unknown>;
  readonly proposedBy: string | null;
  readonly subjectMemberId: string | null;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly decidedAt: number | null;
  readonly executedAt: number | null;
  readonly tally: TallyResult;
  readonly deadlocked: boolean;
  readonly votes: readonly VoteView[];
}

export type Failure = { readonly ok: false; readonly reason: string };

export type CreateProposalResult =
  | {
      readonly ok: true;
      readonly view: ProposalView;
      /** パスワード再発行のときだけ返る。申請者にその場で一度だけ見せる。 */
      readonly resetToken?: string;
    }
  | Failure;

export type VoteResult = { readonly ok: true; readonly view: ProposalView } | Failure;

// --- 読み取り -------------------------------------------------------------

function loadVoters(db: Db, proposalId: string): VoterSnapshot[] {
  return db
    .select({ memberId: proposalVoters.memberId, status: members.status })
    .from(proposalVoters)
    .innerJoin(members, eq(members.id, proposalVoters.memberId))
    .where(eq(proposalVoters.proposalId, proposalId))
    .all();
}

function loadBallots(db: Db, proposalId: string): (Ballot & VoteView)[] {
  return db
    .select()
    .from(votes)
    .where(eq(votes.proposalId, proposalId))
    .all()
    .map((row) => ({
      memberId: row.memberId,
      choice: row.choice,
      votedAt: row.votedAt,
      voided: row.voidedAt !== null,
    }));
}

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toView(db: Db, row: ProposalRow, now: number): ProposalView {
  const voters = loadVoters(db, row.id);
  const ballots = loadBallots(db, row.id);
  const result = evaluate({
    type: row.type as ProposalType,
    subjectMemberId: row.subjectMemberId,
    status: row.status,
    voters,
    ballots,
    expiresAt: row.expiresAt,
    now,
  });

  return {
    id: row.id,
    type: row.type as ProposalType,
    status: row.status,
    summary: row.summary,
    payload: parsePayload(row.payload),
    proposedBy: row.proposedBy,
    subjectMemberId: row.subjectMemberId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    decidedAt: row.decidedAt,
    executedAt: row.executedAt,
    tally: result.tally,
    deadlocked: result.deadlocked,
    votes: ballots,
  };
}

export function getProposal(db: Db, id: string, now = Date.now()): ProposalView | undefined {
  const row = db.select().from(proposals).where(eq(proposals.id, id)).get();
  return row === undefined ? undefined : toView(db, row, now);
}

export function listProposals(
  db: Db,
  filter: { readonly status?: ProposalRow['status'] } = {},
  now = Date.now(),
): ProposalView[] {
  const rows =
    filter.status === undefined
      ? db.select().from(proposals).orderBy(desc(proposals.createdAt)).all()
      : db
          .select()
          .from(proposals)
          .where(eq(proposals.status, filter.status))
          .orderBy(desc(proposals.createdAt))
          .all();
  return rows.map((row) => toView(db, row, now));
}

// --- 作成 -----------------------------------------------------------------

function describe(type: ProposalType, subject: MemberRow | undefined, payload: MemberAddPayload | null): string {
  const label = PROPOSAL_TYPE_LABELS[type];
  if (type === 'member.add' && payload !== null) {
    return `${label}: ${payload.displayName}（${payload.username}）`;
  }
  return subject === undefined ? label : `${label}: ${subject.displayName}（${subject.username}）`;
}

function validateMemberAddPayload(db: Db, payload: Record<string, unknown>): MemberAddPayload | Failure {
  const username = typeof payload['username'] === 'string' ? payload['username'].trim() : '';
  const displayName = typeof payload['displayName'] === 'string' ? payload['displayName'].trim() : '';
  const discordIdRaw = payload['discordId'];
  const discordId = typeof discordIdRaw === 'string' && discordIdRaw.trim() !== '' ? discordIdRaw.trim() : null;

  if (!USERNAME_PATTERN.test(username)) {
    return {
      ok: false,
      reason: 'ユーザー名は英小文字・数字・ハイフン・アンダースコアで 2〜39 文字にしてください',
    };
  }
  if (displayName === '') return { ok: false, reason: '表示名を入力してください' };
  if (getMemberByUsername(db, username) !== undefined) {
    return { ok: false, reason: `ユーザー名 ${username} は既に使われています` };
  }
  return { username, displayName, discordId };
}

export interface CreateProposalInput {
  readonly type: ProposalType;
  /** 未ログインのパスワード再発行申請では null。 */
  readonly proposedBy: string | null;
  readonly subjectMemberId?: string | null;
  readonly payload?: Record<string, unknown>;
  readonly now?: number;
  readonly ttlMs?: number;
  /** 提案者が自動で賛成するか。既定は true。 */
  readonly proposerApproves?: boolean;
}

export function createProposal(db: Db, input: CreateProposalInput): CreateProposalResult {
  const now = input.now ?? Date.now();
  const ttlMs = input.ttlMs ?? DEFAULT_PROPOSAL_TTL_MS;

  return db.transaction((tx) => {
    const active = listActiveMembers(tx);
    const subjectId = input.subjectMemberId ?? null;
    const subject = subjectId === null ? undefined : getMember(tx, subjectId);

    if (subjectId !== null && subject === undefined) {
      return { ok: false, reason: '対象のメンバーが見つかりません' };
    }

    const guard = validateProposal({
      type: input.type,
      subjectMemberId: subjectId,
      activeMemberIds: active.map((m) => m.id),
    });
    if (!guard.ok) return guard;

    let addPayload: MemberAddPayload | null = null;
    if (input.type === 'member.add') {
      const parsed = validateMemberAddPayload(tx, input.payload ?? {});
      if ('ok' in parsed) return parsed;
      addPayload = parsed;
    } else if (subject === undefined) {
      return { ok: false, reason: 'この提案には対象メンバーの指定が必要です' };
    } else if (input.type === 'member.reinstate') {
      if (subject.status !== 'suspended') {
        return { ok: false, reason: '復帰させられるのは一時停止中のメンバーだけです' };
      }
    } else if (subject.status !== 'active') {
      return { ok: false, reason: '対象のメンバーが有効な状態ではありません' };
    }

    if (active.length === 0) {
      return { ok: false, reason: '有効なメンバーが 1 人もいないため提案を受け付けられません' };
    }

    const id = randomUUID();
    tx.insert(proposals)
      .values({
        id,
        type: input.type,
        summary: describe(input.type, subject, addPayload),
        payload: JSON.stringify(addPayload ?? input.payload ?? {}),
        proposedBy: input.proposedBy,
        subjectMemberId: subjectId,
        status: 'open',
        createdAt: now,
        expiresAt: now + ttlMs,
      })
      .run();

    // 有権者をこの瞬間で固定する。以後に加入した人はこの提案に投票できない。
    for (const member of active) {
      tx.insert(proposalVoters).values({ proposalId: id, memberId: member.id }).run();
    }

    let resetToken: string | undefined;
    if (input.type === 'credential.password_reset' && subject !== undefined) {
      revokeOpenTickets(tx, subject.id, 'password_reset');
      resetToken = issueTicket(tx, {
        kind: 'password_reset',
        memberId: subject.id,
        proposalId: id,
        status: 'pending',
        now,
      }).token;
    }

    appendAudit(tx, {
      at: now,
      actorMemberId: input.proposedBy,
      action: 'proposal.open',
      detail: { proposalId: id, type: input.type, subjectMemberId: subjectId },
    });

    // 提案者が有権者なら自動的に賛成として扱う。自分の提案に改めて投票させる意味がないため。
    if (input.proposerApproves !== false && input.proposedBy !== null) {
      recordVote(tx, id, input.proposedBy, 'approve', now);
    }

    const view = settle(tx, id, now);
    return resetToken === undefined ? { ok: true, view } : { ok: true, view, resetToken };
  });
}

// --- 投票 -----------------------------------------------------------------

function recordVote(db: Db, proposalId: string, memberId: string, choice: VoteChoice, now: number): void {
  db.insert(votes)
    .values({ proposalId, memberId, choice, votedAt: now })
    .onConflictDoUpdate({
      target: [votes.proposalId, votes.memberId],
      set: { choice, votedAt: now, voidedAt: null },
    })
    .run();

  appendAudit(db, {
    at: now,
    actorMemberId: memberId,
    action: 'vote.cast',
    detail: { proposalId, choice },
  });
}

export function castVote(
  db: Db,
  input: {
    readonly proposalId: string;
    readonly memberId: string;
    readonly choice: VoteChoice;
    readonly now?: number;
  },
): VoteResult {
  const now = input.now ?? Date.now();

  return db.transaction((tx) => {
    const row = tx.select().from(proposals).where(eq(proposals.id, input.proposalId)).get();
    if (row === undefined) return { ok: false, reason: '提案が見つかりません' };
    if (row.status !== 'open') return { ok: false, reason: 'この提案は既に決着しています' };
    if (now >= row.expiresAt) {
      return { ok: true, view: settle(tx, row.id, now) };
    }

    const current = toView(tx, row, now);
    if (!current.tally.eligible.includes(input.memberId)) {
      return { ok: false, reason: 'この提案に投票する資格がありません' };
    }

    recordVote(tx, row.id, input.memberId, input.choice, now);
    return { ok: true, view: settle(tx, row.id, now) };
  });
}

// --- 決着と実行 -----------------------------------------------------------

/**
 * 提案の状態を評価し、決着していれば確定させる。可決なら実行まで進める。
 *
 * 実行は status を 'approved' から 'executed' に進める 1 回だけ行われる。
 * 同じトランザクションの中で status を見てから書くので、二重実行は起こらない。
 */
export function settle(db: Db, proposalId: string, now = Date.now()): ProposalView {
  const row = db.select().from(proposals).where(eq(proposals.id, proposalId)).get();
  if (row === undefined) throw new Error(`提案が見つかりません: ${proposalId}`);
  if (row.status !== 'open') return toView(db, row, now);

  const view = toView(db, row, now);
  const next = evaluate({
    type: view.type,
    subjectMemberId: view.subjectMemberId,
    status: 'open',
    voters: loadVoters(db, proposalId),
    ballots: loadBallots(db, proposalId),
    expiresAt: row.expiresAt,
    now,
  }).nextStatus;

  if (next === 'open') return view;

  if (next === 'rejected' || next === 'expired') {
    db.update(proposals)
      .set({ status: next, decidedAt: now })
      .where(eq(proposals.id, proposalId))
      .run();
    revokeTicketsForProposal(db, proposalId);
    appendAudit(db, {
      at: now,
      actorMemberId: null,
      action: `proposal.${next}`,
      detail: { proposalId, approvals: view.tally.approvals, rejections: view.tally.rejections },
    });
    return getProposal(db, proposalId, now) ?? view;
  }

  // 可決。承認を記録してから実行に移る。
  db.update(proposals)
    .set({ status: 'approved', decidedAt: now })
    .where(eq(proposals.id, proposalId))
    .run();
  appendAudit(db, {
    at: now,
    actorMemberId: null,
    action: 'proposal.approved',
    detail: { proposalId, approvals: view.tally.approvals, required: view.tally.required },
  });

  executeProposal(db, row, now);

  db.update(proposals)
    .set({ status: 'executed', executedAt: now })
    .where(eq(proposals.id, proposalId))
    .run();
  activateTicketsForProposal(db, proposalId, now);
  appendAudit(db, {
    at: now,
    actorMemberId: null,
    action: 'proposal.executed',
    detail: { proposalId, type: row.type },
  });

  return getProposal(db, proposalId, now) ?? view;
}

/** 可決した提案の効果を適用する。呼び出し元のトランザクションの中で動く。 */
function executeProposal(db: Db, row: ProposalRow, now: number): void {
  const type = row.type as ProposalType;
  const subjectId = row.subjectMemberId;

  switch (type) {
    case 'member.add': {
      const payload = parsePayload(row.payload) as unknown as MemberAddPayload;
      // 加入直後は pending。本人がパスワードと二要素を登録して初めて active になる。
      db.insert(members)
        .values({
          id: randomUUID(),
          username: payload.username,
          displayName: payload.displayName,
          status: 'pending',
          discordId: payload.discordId,
          createdAt: now,
        })
        .run();
      return;
    }

    case 'member.remove': {
      if (subjectId === null) return;
      setMemberStatus(db, subjectId, 'removed', now);
      revokeAccess(db, subjectId);
      voidOpenVotes(db, subjectId, now);
      return;
    }

    case 'member.suspend': {
      if (subjectId === null) return;
      setMemberStatus(db, subjectId, 'suspended', now);
      db.delete(sessions).where(eq(sessions.memberId, subjectId)).run();
      voidOpenVotes(db, subjectId, now);
      return;
    }

    case 'member.reinstate': {
      if (subjectId === null) return;
      setMemberStatus(db, subjectId, 'active', now);
      return;
    }

    case 'credential.password_reset':
      // 券を有効化するだけ。実際の再設定は本人がリンクを開いて行う。
      return;

    case 'credential.factor_reset': {
      if (subjectId === null) return;
      // 二要素を白紙に戻す。再登録が済むまでログインできない状態にする。
      db.delete(totpCredentials).where(eq(totpCredentials.memberId, subjectId)).run();
      db.delete(passkeys).where(eq(passkeys.memberId, subjectId)).run();
      db.delete(sessions).where(eq(sessions.memberId, subjectId)).run();
      setMemberStatus(db, subjectId, 'pending', now);
      revokeOpenTickets(db, subjectId, 'enroll');
      issueTicketForProposal(db, subjectId, row.id, now);
      return;
    }
  }
}

function issueTicketForProposal(db: Db, memberId: string, proposalId: string, now: number): void {
  issueTicket(db, { kind: 'enroll', memberId, proposalId, status: 'pending', now });
}

function revokeAccess(db: Db, memberId: string): void {
  db.delete(sessions).where(eq(sessions.memberId, memberId)).run();
  db.delete(passwordCredentials).where(eq(passwordCredentials.memberId, memberId)).run();
  db.delete(totpCredentials).where(eq(totpCredentials.memberId, memberId)).run();
  db.delete(passkeys).where(eq(passkeys.memberId, memberId)).run();
}

/** 停止・除名されたメンバーが未決の提案に入れていた票を無効化する。 */
function voidOpenVotes(db: Db, memberId: string, now: number): void {
  const open = db.select().from(proposals).where(eq(proposals.status, 'open')).all();
  for (const proposal of open) {
    db.update(votes)
      .set({ voidedAt: now })
      .where(and(eq(votes.proposalId, proposal.id), eq(votes.memberId, memberId)))
      .run();
  }
}

/**
 * 期限切れの提案をまとめて片付ける。定期実行と画面表示の前に呼ぶ。
 */
export function settleExpired(db: Db, now = Date.now()): number {
  const open = db.select().from(proposals).where(eq(proposals.status, 'open')).all();
  let changed = 0;
  for (const row of open) {
    const before = row.status;
    const after = settle(db, row.id, now).status;
    if (before !== after) changed += 1;
  }
  return changed;
}
