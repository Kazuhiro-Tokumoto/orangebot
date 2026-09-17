import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { getMember } from '../db/members.js';
import { ledgerEntries, posts, type PostRow } from '../db/schema.js';
import { parseAmount, transfer } from './ledger.js';

/**
 * メンバーどうしの投稿。
 *
 * 書けるのは有効なメンバーだけ。返信は何段でも繋がるが、画面ではスレッドの先頭の下に
 * 時刻順で並べる。投げ銭は BOAG の台帳にそのまま載せ、ref で投稿を指す。
 * 投稿の側に金額を持たないので、台帳と食い違う余地が無い。
 */

export const MAX_BODY_LENGTH = 1000;
export const TIMELINE_LIMIT = 50;

export type SocialFailure = { readonly ok: false; readonly reason: string };

/** 投げ銭の台帳行に入れる由来。 */
export function tipRef(postId: string): string {
  return `post:${postId}`;
}

function normalizeBody(raw: string): string {
  // 改行は残し、行末の空白と前後の空行だけ落とす。
  return raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

function checkAuthor(db: Db, memberId: string): SocialFailure | undefined {
  const member = getMember(db, memberId);
  if (member === undefined || member.status !== 'active') {
    return { ok: false, reason: '有効なメンバーだけが書けます' };
  }
  return undefined;
}

function checkBody(body: string): SocialFailure | undefined {
  if (body === '') return { ok: false, reason: '本文が空です' };
  // 文字数は見た目の 1 文字で数える。サロゲートペアの文字を 2 と数えると上限が不公平になる。
  if ([...body].length > MAX_BODY_LENGTH) {
    return { ok: false, reason: `本文は ${String(MAX_BODY_LENGTH)} 文字までです` };
  }
  return undefined;
}

export function getPost(db: Db, id: string): PostRow | undefined {
  return db.select().from(posts).where(eq(posts.id, id)).get();
}

export type CreatePostResult = { readonly ok: true; readonly post: PostRow } | SocialFailure;

export function createPost(
  db: Db,
  input: {
    readonly authorId: string;
    readonly body: string;
    /** 返信先。省けばスレッドの先頭になる。 */
    readonly parentId?: string | undefined;
    readonly now?: number;
  },
): CreatePostResult {
  const author = checkAuthor(db, input.authorId);
  if (author !== undefined) return author;

  const body = normalizeBody(input.body);
  const invalid = checkBody(body);
  if (invalid !== undefined) return invalid;

  let parentId: string | null = null;
  let rootId: string | null = null;
  if (input.parentId !== undefined && input.parentId !== '') {
    const parent = getPost(db, input.parentId);
    if (parent === undefined) return { ok: false, reason: '返信先が見つかりません' };
    if (parent.deletedAt !== null) return { ok: false, reason: '消された投稿には返信できません' };
    parentId = parent.id;
    rootId = parent.rootId ?? parent.id;
  }

  const row: PostRow = {
    id: randomUUID(),
    authorId: input.authorId,
    parentId,
    rootId,
    body,
    createdAt: input.now ?? Date.now(),
    deletedAt: null,
  };
  db.insert(posts).values(row).run();

  return { ok: true, post: row };
}

/**
 * 自分の投稿を消す。
 *
 * 行は残して本文だけ空にする。返信の繋がりと、その投稿に付いた投げ銭の記録を残すため。
 */
export function deletePost(
  db: Db,
  input: { readonly postId: string; readonly memberId: string; readonly now?: number },
): { readonly ok: true } | SocialFailure {
  const row = getPost(db, input.postId);
  if (row === undefined || row.deletedAt !== null) {
    return { ok: false, reason: 'その投稿はありません' };
  }
  if (row.authorId !== input.memberId) return { ok: false, reason: '自分の投稿だけ消せます' };

  db.update(posts)
    .set({ body: '', deletedAt: input.now ?? Date.now() })
    .where(eq(posts.id, row.id))
    .run();

  return { ok: true };
}

export interface TipSummary {
  readonly total: bigint;
  readonly count: number;
}

const NO_TIPS: TipSummary = { total: 0n, count: 0 };

/** 投稿ごとの投げ銭の合計。台帳の受け取り側の行だけを数える。 */
export function tipsFor(db: Db, postIds: readonly string[]): Map<string, TipSummary> {
  const result = new Map<string, TipSummary>();
  if (postIds.length === 0) return result;

  const rows = db
    .select({ ref: ledgerEntries.ref, amount: ledgerEntries.amount })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.kind, 'transfer'),
        inArray(
          ledgerEntries.ref,
          postIds.map((id) => tipRef(id)),
        ),
      ),
    )
    .all();

  for (const row of rows) {
    const amount = BigInt(row.amount);
    // 送り手の行は負、受け手の行は正。正の側だけを足せば二重に数えない。
    if (amount <= 0n || row.ref === null) continue;
    const postId = row.ref.slice('post:'.length);
    const current = result.get(postId) ?? NO_TIPS;
    result.set(postId, { total: current.total + amount, count: current.count + 1 });
  }

  return result;
}

export type TipResult = { readonly ok: true; readonly txId: string } | SocialFailure;

/** 投稿に BOAG を投げる。書き手の口座へそのまま送る。 */
export function tipPost(
  db: Db,
  input: {
    readonly postId: string;
    readonly fromMemberId: string;
    readonly amount: string;
    readonly now?: number;
  },
): TipResult {
  const tipper = checkAuthor(db, input.fromMemberId);
  if (tipper !== undefined) return { ok: false, reason: '有効なメンバーだけが投げ銭できます' };

  const post = getPost(db, input.postId);
  if (post === undefined || post.deletedAt !== null) {
    return { ok: false, reason: 'その投稿はありません' };
  }
  if (post.authorId === input.fromMemberId) {
    return { ok: false, reason: '自分の投稿には投げ銭できません' };
  }

  const recipient = getMember(db, post.authorId);
  if (recipient === undefined || recipient.status !== 'active') {
    return { ok: false, reason: '書き手が今は受け取れない状態です' };
  }

  const amount = parseAmount(input.amount);
  if (amount === undefined) {
    return { ok: false, reason: '投げ銭は 0 より大きく、小数 16 桁までで入れてください' };
  }

  return transfer(db, {
    from: input.fromMemberId,
    to: post.authorId,
    amount,
    ref: tipRef(post.id),
    memo: '投げ銭',
    now: input.now ?? Date.now(),
  });
}

export interface PostView {
  readonly post: PostRow;
  readonly tips: TipSummary;
  readonly replies: number;
}

function withCounts(db: Db, rows: readonly PostRow[]): PostView[] {
  const ids = rows.map((row) => row.id);
  const tips = tipsFor(db, ids);

  const replyCounts = new Map<string, number>();
  if (ids.length > 0) {
    const replies = db
      .select({ rootId: posts.rootId })
      .from(posts)
      .where(and(inArray(posts.rootId, ids), isNull(posts.deletedAt)))
      .all();
    for (const reply of replies) {
      if (reply.rootId === null) continue;
      replyCounts.set(reply.rootId, (replyCounts.get(reply.rootId) ?? 0) + 1);
    }
  }

  return rows.map((row) => ({
    post: row,
    tips: tips.get(row.id) ?? NO_TIPS,
    replies: replyCounts.get(row.id) ?? 0,
  }));
}

/** スレッドの先頭だけを新しい順に。 */
export function listTimeline(db: Db, limit = TIMELINE_LIMIT): PostView[] {
  const rows = db
    .select()
    .from(posts)
    .where(isNull(posts.parentId))
    .orderBy(desc(posts.createdAt))
    .limit(limit)
    .all();
  return withCounts(db, rows);
}

export interface ThreadView {
  readonly root: PostView;
  /** 先頭の下にぶら下がる全ての返信。古い順。 */
  readonly replies: readonly PostView[];
}

/** 投稿 1 件から、そのスレッド全体を引く。返信を渡されても先頭から出す。 */
export function getThread(db: Db, postId: string): ThreadView | undefined {
  const start = getPost(db, postId);
  if (start === undefined) return undefined;

  const root = start.rootId === null ? start : getPost(db, start.rootId);
  if (root === undefined) return undefined;

  const replies = db
    .select()
    .from(posts)
    .where(eq(posts.rootId, root.id))
    .all()
    .sort((a, b) => a.createdAt - b.createdAt);

  const [rootView, ...replyViews] = withCounts(db, [root, ...replies]);
  if (rootView === undefined) return undefined;
  return { root: rootView, replies: replyViews };
}
