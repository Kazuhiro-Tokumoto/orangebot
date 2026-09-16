import { Hono, type Context } from 'hono';
import { listAllMembers } from '../../db/members.js';
import type { MemberRow } from '../../db/schema.js';
import { balanceOf, formatAmount } from '../../domain/ledger.js';
import {
  MAX_BODY_LENGTH,
  createPost,
  deletePost,
  getPost,
  getThread,
  listTimeline,
  tipPost,
  type PostView,
} from '../../domain/social.js';
import { field, requireFullSession, type AppBindings, type RouteDeps } from '../context.js';
import { Notice } from '../views/forms.js';
import { Layout } from '../views/layout.js';

function when(ms: number): string {
  return new Date(ms).toLocaleString('ja-JP', { hour12: false });
}

/**
 * 書き込み後は画面を出し直さず、GET に移す。
 * そうしないと再読み込みで同じ投稿や投げ銭がもう一度送られてしまう。
 * 移った先に出す一言は、決まった符号だけを受け付ける。
 */
const DONE_MESSAGES: Readonly<Record<string, string>> = {
  posted: '投稿しました。',
  replied: '返信しました。',
  tipped: '投げ銭を送りました。',
  deleted: '投稿を消しました。',
};

function doneMessage(c: Context<AppBindings>): string | undefined {
  const code = c.req.query('done');
  return code === undefined ? undefined : DONE_MESSAGES[code];
}

function Compose(props: {
  readonly action: string;
  readonly parentId?: string | undefined;
  readonly placeholder: string;
  readonly submit: string;
}) {
  return (
    <form class="stack" method="post" action={props.action} style="max-width:none">
      {props.parentId === undefined ? null : (
        <input type="hidden" name="parentId" value={props.parentId} />
      )}
      <textarea
        class="input"
        name="body"
        rows={3}
        required
        maxlength={MAX_BODY_LENGTH}
        placeholder={props.placeholder}
      />
      <button class="btn" type="submit">
        {props.submit}
      </button>
    </form>
  );
}

function PostCard(props: {
  readonly view: PostView;
  readonly author: MemberRow | undefined;
  readonly viewerId: string;
  /** 時系列では返信数とスレッドへの入口を出す。スレッドの中では返信と投げ銭の操作を出す。 */
  readonly mode: 'timeline' | 'thread';
  readonly threadId: string;
  readonly replyingTo?: boolean | undefined;
}) {
  const { post, tips, replies } = props.view;
  const deleted = post.deletedAt !== null;
  const mine = post.authorId === props.viewerId;

  return (
    <article class={`panel post${props.replyingTo === true ? ' replying' : ''}`} id={post.id}>
      <div class="row" style="justify-content:space-between">
        <strong>{props.author?.displayName ?? '不明なメンバー'}</strong>
        <span class="field-hint">{when(post.createdAt)}</span>
      </div>

      {deleted ? (
        <p class="muted post-body">この投稿は消されました。</p>
      ) : (
        <p class="post-body">{post.body}</p>
      )}

      <div class="row post-meta">
        {tips.count > 0 ? (
          <span class="tag accent">
            投げ銭 {formatAmount(tips.total)} BOAG ・ {String(tips.count)} 回
          </span>
        ) : null}

        {props.mode === 'timeline' ? (
          <a class="plain" href={`/posts/${post.id}`}>
            {replies > 0 ? `返信 ${String(replies)} 件` : '返信する'}
          </a>
        ) : deleted ? null : (
          <a class="plain" href={`/posts/${props.threadId}?reply=${post.id}#compose`}>
            返信する
          </a>
        )}
      </div>

      {props.mode === 'thread' && !deleted ? (
        <div class="row" style="margin-top:10px">
          {mine ? (
            <form method="post" action={`/posts/${post.id}/delete`}>
              <button class="btn quiet" type="submit">
                消す
              </button>
            </form>
          ) : (
            <form class="row" method="post" action={`/posts/${post.id}/tip`}>
              <input
                class="input"
                name="amount"
                inputmode="numeric"
                required
                placeholder="10"
                style="width:7em"
              />
              <button class="btn quiet" type="submit">
                BOAG を投げる
              </button>
            </form>
          )}
        </div>
      ) : null}
    </article>
  );
}

export function socialRoutes(deps: RouteDeps) {
  const app = new Hono<AppBindings>();
  for (const path of ['/timeline', '/timeline/*', '/posts', '/posts/*']) {
    app.use(path, requireFullSession());
  }

  function authors(): Map<string, MemberRow> {
    return new Map(listAllMembers(deps.db).map((member) => [member.id, member]));
  }

  function renderTimeline(c: Context<AppBindings>, error?: string) {
    const viewer = c.get('viewer');
    if (viewer === undefined) return c.redirect('/login');

    const byId = authors();
    const timeline = listTimeline(deps.db);

    return c.html(
      <Layout title="タイムライン" viewer={viewer.member.displayName}>
        <h1>タイムライン</h1>
        <p class="lede">
          メンバーだけが読み書きできます。あなたの残高は{' '}
          {formatAmount(balanceOf(deps.db, viewer.member.id))} BOAG です。
        </p>

        {error === undefined ? null : <Notice tone="bad">{error}</Notice>}
        {doneMessage(c) === undefined ? null : <Notice tone="ok">{doneMessage(c)}</Notice>}

        <section class="panel">
          <Compose action="/timeline" placeholder="いまどうしてる？" submit="投稿する" />
        </section>

        {timeline.length === 0 ? (
          <section class="panel">
            <span class="muted">まだ投稿がありません。</span>
          </section>
        ) : (
          timeline.map((view) => (
            <PostCard
              view={view}
              author={byId.get(view.post.authorId)}
              viewerId={viewer.member.id}
              mode="timeline"
              threadId={view.post.id}
            />
          ))
        )}
      </Layout>,
      error === undefined ? 200 : 400,
    );
  }

  function renderThread(c: Context<AppBindings>, postId: string, error?: string) {
    const viewer = c.get('viewer');
    if (viewer === undefined) return c.redirect('/login');

    const thread = getThread(deps.db, postId);
    if (thread === undefined) {
      return c.html(
        <Layout title="見つかりません" viewer={viewer.member.displayName}>
          <h1>見つかりません</h1>
          <p class="lede">その投稿はありません。</p>
        </Layout>,
        404,
      );
    }

    const byId = authors();
    const rootId = thread.root.post.id;
    const all = [thread.root, ...thread.replies];

    // 返信先の指定は、同じスレッドの消されていない投稿だけを受け付ける。
    const requested = c.req.query('reply');
    const target =
      all.find((view) => view.post.id === requested && view.post.deletedAt === null) ??
      (thread.root.post.deletedAt === null ? thread.root : undefined);

    return c.html(
      <Layout title="スレッド" viewer={viewer.member.displayName}>
        <p class="lede">
          <a class="plain" href="/timeline">
            タイムラインに戻る
          </a>
        </p>

        {error === undefined ? null : <Notice tone="bad">{error}</Notice>}
        {doneMessage(c) === undefined ? null : <Notice tone="ok">{doneMessage(c)}</Notice>}

        {all.map((view) => (
          <PostCard
            view={view}
            author={byId.get(view.post.authorId)}
            viewerId={viewer.member.id}
            mode="thread"
            threadId={rootId}
            replyingTo={target !== undefined && view.post.id === target.post.id && view !== thread.root}
          />
        ))}

        {target === undefined ? null : (
          <section class="panel" id="compose">
            <p class="field-hint" style="margin:0 0 10px">
              {byId.get(target.post.authorId)?.displayName ?? '不明なメンバー'} さんへの返信
            </p>
            <Compose
              action={`/posts/${rootId}/reply`}
              parentId={target.post.id}
              placeholder="返信を書く"
              submit="返信する"
            />
          </section>
        )}
      </Layout>,
      error === undefined ? 200 : 400,
    );
  }

  app.get('/timeline', (c) => renderTimeline(c));

  app.post('/timeline', async (c) => {
    const viewer = c.get('viewer');
    if (viewer === undefined) return c.redirect('/login');

    const form = await c.req.formData();
    const result = createPost(deps.db, { authorId: viewer.member.id, body: field(form, 'body') });
    if (!result.ok) return renderTimeline(c, result.reason);

    return c.redirect('/timeline?done=posted');
  });

  app.get('/posts/:id', (c) => renderThread(c, c.req.param('id')));

  app.post('/posts/:id/reply', async (c) => {
    const viewer = c.get('viewer');
    if (viewer === undefined) return c.redirect('/login');

    const threadId = c.req.param('id');
    const form = await c.req.formData();
    const parentId = field(form, 'parentId');

    // 返信先がこのスレッドのものでなければ断る。URL とフォームで別のスレッドを指されるのを防ぐ。
    const parent = getPost(deps.db, parentId);
    if (parent === undefined || (parent.rootId ?? parent.id) !== threadId) {
      return renderThread(c, threadId, '返信先がこのスレッドにありません');
    }

    const result = createPost(deps.db, {
      authorId: viewer.member.id,
      body: field(form, 'body'),
      parentId,
    });
    if (!result.ok) return renderThread(c, threadId, result.reason);

    return c.redirect(`/posts/${threadId}?done=replied#${result.post.id}`);
  });

  app.post('/posts/:id/tip', async (c) => {
    const viewer = c.get('viewer');
    if (viewer === undefined) return c.redirect('/login');

    const postId = c.req.param('id');
    const target = getPost(deps.db, postId);
    const threadId = target?.rootId ?? postId;

    const form = await c.req.formData();
    const result = tipPost(deps.db, {
      postId,
      fromMemberId: viewer.member.id,
      amount: field(form, 'amount'),
    });
    if (!result.ok) return renderThread(c, threadId, result.reason);

    return c.redirect(`/posts/${threadId}?done=tipped#${postId}`);
  });

  app.post('/posts/:id/delete', (c) => {
    const viewer = c.get('viewer');
    if (viewer === undefined) return c.redirect('/login');

    const postId = c.req.param('id');
    const target = getPost(deps.db, postId);
    const threadId = target?.rootId ?? postId;

    const result = deletePost(deps.db, { postId, memberId: viewer.member.id });
    if (!result.ok) return renderThread(c, threadId, result.reason);

    return c.redirect(`/posts/${threadId}?done=deleted`);
  });

  return app;
}
