import { appendAudit } from '../db/audit.js';
import type { Db } from '../db/client.js';
import { getMember, isDiscordId, listAllMembers, setMemberStatus } from '../db/members.js';
import { members as membersTable, type MemberRow } from '../db/schema.js';
import { issueTicket, revokeOpenTickets } from './tickets.js';

export type Failure = { readonly ok: false; readonly reason: string };

export interface CreateGenesisInput {
  /** Discord のユーザー ID。そのままメンバー ID になる。 */
  readonly discordId: string;
  readonly username: string;
  readonly displayName: string;
  readonly now?: number;
}

export interface GenesisResult {
  readonly ok: true;
  readonly member: MemberRow;
  /** 登録リンクの引換券。一度だけ表示する。 */
  readonly enrollToken: string;
  readonly expiresAt: number;
}

/**
 * 最初の 1 人を作る。
 *
 * 承認を経ずにメンバーを増やせる唯一の入口なので、
 * 既にメンバーが 1 人でもいれば断る。以後の追加は必ず提案と承認を通る。
 *
 * ここで作るのは登録待ちの器と、その人だけが使える登録リンクだけ。
 * パスワードも二要素も、本人がそのリンクを開いて設定する。
 * 初回だけ別の入口を用意すると、そこが一番弱い場所として残り続けるため。
 */
export function createGenesisMember(db: Db, input: CreateGenesisInput): GenesisResult | Failure {
  const now = input.now ?? Date.now();

  return db.transaction((tx) => {
    if (listAllMembers(tx).length > 0) {
      return { ok: false, reason: '既にメンバーが存在します。追加は提案と承認を通してください' };
    }
    if (!isDiscordId(input.discordId)) {
      return { ok: false, reason: 'Discord のユーザー ID は 17〜20 桁の数字です' };
    }

    const member: MemberRow = {
      id: input.discordId,
      username: input.username,
      displayName: input.displayName,
      // 最初の 1 人は登録待ちから始める。パスワードと二要素は登録リンクから設定する。
      status: 'pending',
      createdAt: now,
      activatedAt: null,
    };

    tx.insert(membersTable).values(member).run();
    const ticket = issueTicket(tx, {
      kind: 'enroll',
      memberId: member.id,
      status: 'active',
      now,
    });

    appendAudit(tx, {
      at: now,
      actorMemberId: null,
      action: 'member.genesis',
      detail: { memberId: member.id, username: member.username },
    });

    return { ok: true, member, enrollToken: ticket.token, expiresAt: ticket.expiresAt };
  });
}

export interface EnrollLinkResult {
  readonly ok: true;
  readonly token: string;
  readonly expiresAt: number;
}

/**
 * 加入待ちのメンバーに登録リンクを発行する。
 *
 * 券は一度しか表示できないので、渡しそこねたら発行し直す。
 * 発行し直すと古いリンクは無効になる。
 */
export function issueEnrollLink(
  db: Db,
  input: {
    readonly memberId: string;
    readonly actorMemberId: string | null;
    readonly now?: number;
  },
): EnrollLinkResult | Failure {
  const now = input.now ?? Date.now();

  return db.transaction((tx) => {
    const member = getMember(tx, input.memberId);
    if (member === undefined) return { ok: false, reason: 'メンバーが見つかりません' };
    if (member.status !== 'pending') {
      return { ok: false, reason: '登録リンクを出せるのは加入待ちのメンバーだけです' };
    }

    revokeOpenTickets(tx, member.id, 'enroll');
    const ticket = issueTicket(tx, {
      kind: 'enroll',
      memberId: member.id,
      status: 'active',
      now,
    });

    appendAudit(tx, {
      at: now,
      actorMemberId: input.actorMemberId,
      action: 'member.enroll_link_issued',
      detail: { memberId: member.id },
    });

    return { ok: true, token: ticket.token, expiresAt: ticket.expiresAt };
  });
}

/** 登録が完了したメンバーを有効にする。 */
export function activateMember(db: Db, memberId: string, now = Date.now()): void {
  setMemberStatus(db, memberId, 'active', now);
  appendAudit(db, {
    at: now,
    actorMemberId: memberId,
    action: 'member.activated',
    detail: { memberId },
  });
}
