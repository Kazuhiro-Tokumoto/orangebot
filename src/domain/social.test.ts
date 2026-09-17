import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { verifyAuditLog } from '../db/audit.js';
import { openTestDatabase, type Database_ } from '../db/client.js';
import { members, type MemberRow } from '../db/schema.js';
import { balanceOf, mint, verifyLedger } from './ledger.js';
import { SOAG_PER_BOAG } from './units.js';
import {
  MAX_BODY_LENGTH,
  createPost,
  deletePost,
  getThread,
  listTimeline,
  tipPost,
  tipsFor,
} from './social.js';

const T0 = 1_700_000_000_000;
const ALICE = '1529717434259345489';
const BOB = '1700000000000000001';
/** 1 BOAG。台帳は SOAG の整数で持つ。 */
const B = SOAG_PER_BOAG;

let handle: Database_;

function db() {
  return handle.db;
}

function addMember(id: string, username: string, status: MemberRow['status'] = 'active'): void {
  db()
    .insert(members)
    .values({ id, username, displayName: username.toUpperCase(), status, createdAt: T0, activatedAt: T0 })
    .run();
}

function post(authorId: string, body: string, parentId?: string, now = T0): string {
  const result = createPost(db(), { authorId, body, parentId, now });
  if (!result.ok) throw new Error(result.reason);
  return result.post.id;
}

beforeEach(() => {
  handle = openTestDatabase();
  addMember(ALICE, 'alice');
  addMember(BOB, 'bob');
});

describe('投稿', () => {
  it('前後の空白を落として保存する', () => {
    const result = createPost(db(), { authorId: ALICE, body: '  こんにちは  \r\n\r\n', now: T0 });
    expect(result.ok && result.post.body).toBe('こんにちは');
  });

  it('空の本文は断る', () => {
    expect(createPost(db(), { authorId: ALICE, body: '   \n ', now: T0 }).ok).toBe(false);
  });

  it('長さは見た目の文字数で数える', () => {
    // サロゲートペアで表す文字。JavaScript の length では 1 文字が 2 と数えられる。
    const wide = '𠮷'.repeat(MAX_BODY_LENGTH);
    expect(createPost(db(), { authorId: ALICE, body: wide, now: T0 }).ok).toBe(true);
    expect(createPost(db(), { authorId: ALICE, body: `${wide}𠮷`, now: T0 }).ok).toBe(false);
  });

  it('有効なメンバーでなければ書けない', () => {
    addMember('1700000000000000009', 'carol', 'suspended');
    const result = createPost(db(), { authorId: '1700000000000000009', body: 'やあ', now: T0 });
    expect(result.ok).toBe(false);
  });
});

describe('時系列', () => {
  it('スレッドの先頭だけを新しい順に並べる', () => {
    const first = post(ALICE, '最初', undefined, T0);
    const second = post(BOB, '二つ目', undefined, T0 + 1);
    post(BOB, '返信', first, T0 + 2);

    const timeline = listTimeline(db());
    expect(timeline.map((view) => view.post.id)).toEqual([second, first]);
    expect(timeline[1]?.replies).toBe(1);
  });
});

describe('返信', () => {
  it('返信の返信も同じスレッドの先頭を指す', () => {
    const root = post(ALICE, '先頭');
    const reply = post(BOB, '返信', root, T0 + 1);
    const nested = post(ALICE, '返信の返信', reply, T0 + 2);

    const thread = getThread(db(), nested);
    expect(thread?.root.post.id).toBe(root);
    expect(thread?.replies.map((view) => view.post.id)).toEqual([reply, nested]);
    expect(thread?.replies[1]?.post.parentId).toBe(reply);
  });

  it('無い投稿には返信できない', () => {
    const result = createPost(db(), { authorId: ALICE, body: 'x', parentId: 'nai', now: T0 });
    expect(result.ok).toBe(false);
  });

  it('消された投稿には返信できない', () => {
    const root = post(ALICE, '消す');
    deletePost(db(), { postId: root, memberId: ALICE, now: T0 });

    const result = createPost(db(), { authorId: BOB, body: 'x', parentId: root, now: T0 });
    expect(result.ok).toBe(false);
  });
});

describe('削除', () => {
  it('本文だけ消して、スレッドの繋がりは残す', () => {
    const root = post(ALICE, '消す');
    const reply = post(BOB, '返信', root, T0 + 1);

    expect(deletePost(db(), { postId: root, memberId: ALICE, now: T0 + 2 }).ok).toBe(true);

    const thread = getThread(db(), reply);
    expect(thread?.root.post.body).toBe('');
    expect(thread?.root.post.deletedAt).toBe(T0 + 2);
    expect(thread?.replies).toHaveLength(1);
  });

  it('他人の投稿は消せない', () => {
    const root = post(ALICE, 'わたしの');
    expect(deletePost(db(), { postId: root, memberId: BOB, now: T0 }).ok).toBe(false);
  });
});

describe('投げ銭', () => {
  beforeEach(() => {
    mint(db(), { to: BOB, amount: 100n * B, ref: 'test', now: T0 });
  });

  it('小数の額も投げられる', () => {
    const root = post(ALICE, 'いい話');
    expect(tipPost(db(), { postId: root, fromMemberId: BOB, amount: '0.5', now: T0 }).ok).toBe(true);
    expect(balanceOf(db(), ALICE)).toBe(B / 2n);
  });

  it('書き手の口座へそのまま移る', () => {
    const root = post(ALICE, 'いい話');
    const result = tipPost(db(), { postId: root, fromMemberId: BOB, amount: '30', now: T0 });

    expect(result.ok).toBe(true);
    expect(balanceOf(db(), BOB)).toBe(70n * B);
    expect(balanceOf(db(), ALICE)).toBe(30n * B);
    expect(verifyLedger(db()).ok).toBe(true);
    expect(verifyAuditLog(db()).ok).toBe(true);
  });

  it('投稿ごとの合計と回数を数える', () => {
    const root = post(ALICE, 'いい話');
    tipPost(db(), { postId: root, fromMemberId: BOB, amount: '10', now: T0 });
    tipPost(db(), { postId: root, fromMemberId: BOB, amount: '5', now: T0 });

    expect(tipsFor(db(), [root]).get(root)).toEqual({ total: 15n * B, count: 2 });
    expect(listTimeline(db())[0]?.tips.total).toBe(15n * B);
  });

  it('残高を超えては投げられない', () => {
    const root = post(ALICE, 'いい話');
    const result = tipPost(db(), { postId: root, fromMemberId: BOB, amount: '101', now: T0 });

    expect(result.ok).toBe(false);
    expect(balanceOf(db(), BOB)).toBe(100n * B);
  });

  it('自分の投稿には投げられない', () => {
    const own = post(BOB, '自分の');
    expect(tipPost(db(), { postId: own, fromMemberId: BOB, amount: '1', now: T0 }).ok).toBe(false);
  });

  it('0 以下の額や、小数 17 桁以上は断る', () => {
    const root = post(ALICE, 'いい話');
    for (const amount of ['0', '-5', '0.00000000000000001', 'たくさん']) {
      expect(tipPost(db(), { postId: root, fromMemberId: BOB, amount, now: T0 }).ok).toBe(false);
    }
    expect(balanceOf(db(), BOB)).toBe(100n * B);
  });

  it('消された投稿には投げられない', () => {
    const root = post(ALICE, '消す');
    deletePost(db(), { postId: root, memberId: ALICE, now: T0 });

    expect(tipPost(db(), { postId: root, fromMemberId: BOB, amount: '1', now: T0 }).ok).toBe(false);
  });

  it('消しても、付いた投げ銭の記録は残る', () => {
    const root = post(ALICE, 'いい話');
    tipPost(db(), { postId: root, fromMemberId: BOB, amount: '10', now: T0 });
    deletePost(db(), { postId: root, memberId: ALICE, now: T0 });

    expect(tipsFor(db(), [root]).get(root)?.total).toBe(10n * B);
    expect(balanceOf(db(), ALICE)).toBe(10n * B);
  });

  it('停止中の書き手には投げられない', () => {
    const root = post(ALICE, 'いい話');
    db().update(members).set({ status: 'suspended' }).where(eq(members.id, ALICE)).run();

    expect(tipPost(db(), { postId: root, fromMemberId: BOB, amount: '1', now: T0 }).ok).toBe(false);
    expect(balanceOf(db(), BOB)).toBe(100n * B);
  });
});
