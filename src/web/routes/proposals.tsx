import { Hono, type Context } from 'hono';
import { getMember, listActiveMembers, listMembers } from '../../db/members.js';
import type { MemberRow } from '../../db/schema.js';
import {
  PROPOSAL_TYPE_LABELS,
  isProposalType,
  requiredApprovals,

} from '../../domain/governance.js';
import { balanceOf, formatAmount } from '../../domain/ledger.js';
import { issueEnrollLink } from '../../domain/members.js';
import {
  castVote,
  createProposal,
  listProposals,
  settleExpired,
  type ProposalView,
} from '../../domain/proposals.js';
import { field, requireFullSession, type AppBindings, type RouteDeps } from '../context.js';
import { Field, Notice, Select, Submit, TextArea } from '../views/forms.js';
import { Layout } from '../views/layout.js';

const STATUS_LABELS: Record<string, string> = {
  open: '審議中',
  approved: '可決',
  rejected: '否決',
  executed: '実行済み',
  expired: '期限切れ',
  cancelled: '取り消し',
};

const STATUS_TONE: Record<string, string> = {
  open: 'accent',
  approved: 'ok',
  executed: 'ok',
  rejected: 'bad',
  expired: 'warn',
  cancelled: '',
};

function when(ms: number): string {
  return new Date(ms).toLocaleString('ja-JP', { hour12: false });
}

function nameOf(members: readonly MemberRow[], id: string | null): string {
  if (id === null) return 'システム';
  return members.find((m) => m.id === id)?.displayName ?? id;
}

/** 提案 1 件の札。審議中なら投票ボタンが付く。 */
function Card(props: {
  readonly proposal: ProposalView;
  readonly members: readonly MemberRow[];
  readonly viewerId: string;
}) {
  const p = props.proposal;
  const myVote = p.votes.find((v) => v.memberId === props.viewerId && !v.voided);
  const canVote = p.status === 'open' && p.tally.eligible.includes(props.viewerId);

  return (
    <section class="panel">
      <div class="row" style="justify-content:space-between">
        <strong>{p.summary}</strong>
        <span class={`tag ${STATUS_TONE[p.status] ?? ''}`}>{STATUS_LABELS[p.status] ?? p.status}</span>
      </div>
      <p class="field-hint" style="margin:6px 0 12px">
        {PROPOSAL_TYPE_LABELS[p.type]} ・ 提案 {nameOf(props.members, p.proposedBy)} ・ {when(p.createdAt)}
      </p>

      <div class="row" style="gap:16px">
        <span class="mono">
          賛成 {String(p.tally.approvals)} / {String(p.tally.required)}
        </span>
        {p.tally.rejections > 0 ? (
          <span class="mono muted">反対 {String(p.tally.rejections)}</span>
        ) : null}
        {p.status === 'open' ? (
          <span class="muted">未投票 {String(p.tally.outstanding)} 人</span>
        ) : null}
      </div>

      {p.deadlocked ? (
        <p style="margin-top:12px">
          <span class="tag bad">承認者不在</span>{' '}
          <span class="field-hint">
            利害関係のない有権者がいないため、承認では決着しません。
          </span>
        </p>
      ) : null}

      {canVote ? (
        <form class="row" method="post" action={`/proposals/${p.id}/vote`} style="margin-top:14px">
          <button class="btn" type="submit" name="choice" value="approve">
            賛成
          </button>
          <button class="btn danger" type="submit" name="choice" value="reject">
            反対
          </button>
          {myVote === undefined ? null : (
            <span class="field-hint">
              いまの票: {myVote.choice === 'approve' ? '賛成' : '反対'}（変更できます）
            </span>
          )}
        </form>
      ) : p.status === 'open' ? (
        <p class="field-hint" style="margin-top:14px">
          {p.subjectMemberId === props.viewerId
            ? 'あなたが対象の提案なので、投票できません。'
            : 'この提案の有権者ではありません。'}
        </p>
      ) : null}
    </section>
  );
}

function ProposalsPage(props: {
  readonly viewer: MemberRow;
  readonly members: readonly MemberRow[];
  readonly active: readonly MemberRow[];
  readonly open: readonly ProposalView[];
  readonly closed: readonly ProposalView[];
  readonly balance: bigint;
  readonly error?: string | undefined;
  readonly notice?: string | undefined;
}) {
  const others = props.active.filter((m) => m.id !== props.viewer.id);
  const pending = props.members.filter((m) => m.status === 'pending');
  const suspended = props.members.filter((m) => m.status === 'suspended');
  const required = requiredApprovals(props.active.length);

  const memberOptions = others.map((m) => ({ value: m.id, label: `${m.displayName}（${m.username}）` }));

  return (
    <Layout title="提案" viewer={props.viewer.displayName}>
      <h1>提案</h1>
      <p class="lede">
        有効なメンバーは {String(props.active.length)} 人。可決には {String(required)} 票要ります。
        あなたの残高は {formatAmount(props.balance)} BOAG です。
      </p>

      {props.error === undefined ? null : <Notice tone="bad">{props.error}</Notice>}
      {props.notice === undefined ? null : <Notice tone="ok">{props.notice}</Notice>}

      <h2>審議中</h2>
      {props.open.length === 0 ? (
        <section class="panel">
          <span class="muted">審議中の提案はありません。</span>
        </section>
      ) : (
        props.open.map((p) => (
          <Card proposal={p} members={props.members} viewerId={props.viewer.id} />
        ))
      )}

      <h2>新しい提案</h2>

      <section class="panel">
        <strong>メンバーを追加する</strong>
        <p class="field-hint" style="margin:4px 0 14px">
          可決すると登録待ちの枠ができます。本人に渡す登録リンクは、そのあと下の一覧から出せます。
        </p>
        <form class="stack" method="post" action="/proposals/member-add">
          <Field
            label="Discord のユーザー ID"
            name="discordId"
            required
            inputmode="numeric"
            placeholder="1529717434259345489"
            hint="Discord の開発者モードを有効にして、相手を右クリックしてコピーします。"
          />
          <Field
            label="ユーザー名"
            name="username"
            required
            placeholder="new-member"
            hint="英小文字、数字、ハイフン、アンダースコアで 2〜39 文字。ログインに使います。"
          />
          <Field label="表示名" name="displayName" required placeholder="山田 太郎" />
          <Submit>この内容で提案する</Submit>
        </form>
      </section>

      <section class="panel">
        <strong>BOAG を発行する</strong>
        <p class="field-hint" style="margin:4px 0 14px">
          無から作る操作なので、発行先の本人は投票できません。
          自分宛に発行したい場合は、他のメンバーに提案してもらってください。
        </p>
        {memberOptions.length === 0 ? (
          <span class="muted">発行先にできる相手がいません。</span>
        ) : (
          <form class="stack" method="post" action="/proposals/mint">
            <Select label="発行先" name="subjectMemberId" options={memberOptions} />
            <Field label="発行額" name="amount" required inputmode="numeric" placeholder="1000" hint="1 以上の整数。" />
            <TextArea label="理由" name="memo" rows={2} hint="監査ログと提案の一覧に残ります。" />
            <Submit>この内容で提案する</Submit>
          </form>
        )}
      </section>

      <section class="panel">
        <strong>メンバーの状態を変える</strong>
        <p class="field-hint" style="margin:4px 0 14px">
          除名と一時停止では、対象の本人は投票できません。最後の 1 人は除名も停止もできません。
        </p>
        {memberOptions.length === 0 && suspended.length === 0 ? (
          <span class="muted">対象にできる相手がいません。</span>
        ) : (
          <form class="stack" method="post" action="/proposals/member-status">
            <Select
              label="対象"
              name="subjectMemberId"
              options={[
                ...memberOptions,
                ...suspended.map((m) => ({
                  value: m.id,
                  label: `${m.displayName}（停止中）`,
                })),
              ]}
            />
            <Select
              label="操作"
              name="type"
              options={[
                { value: 'member.suspend', label: '一時停止する' },
                { value: 'member.reinstate', label: '停止を解いて復帰させる' },
                { value: 'member.remove', label: '除名する' },
                { value: 'credential.factor_reset', label: '二要素認証を再登録させる' },
              ]}
            />
            <Submit>この内容で提案する</Submit>
          </form>
        )}
      </section>

      {pending.length === 0 ? null : (
        <>
          <h2>登録待ちのメンバー</h2>
          <section class="panel">
            <p class="field-hint" style="margin:0 0 14px">
              登録リンクを発行して本人に渡してください。一度しか表示されません。
              発行し直すと前のリンクは使えなくなります。
            </p>
            {pending.map((m) => (
              <form
                class="row"
                method="post"
                action="/proposals/enroll-link"
                style="padding:7px 0;border-top:1px solid var(--line)"
              >
                <input type="hidden" name="memberId" value={m.id} />
                <span style="flex:1">
                  {m.displayName} <span class="muted mono">（{m.username}）</span>
                </span>
                <button class="btn quiet" type="submit">
                  登録リンクを出す
                </button>
              </form>
            ))}
          </section>
        </>
      )}

      <h2>決着済み</h2>
      {props.closed.length === 0 ? (
        <section class="panel">
          <span class="muted">まだありません。</span>
        </section>
      ) : (
        props.closed
          .slice(0, 20)
          .map((p) => <Card proposal={p} members={props.members} viewerId={props.viewer.id} />)
      )}

      <form method="post" action="/logout" style="margin-top:36px">
        <button class="btn quiet" type="submit">
          ログアウト
        </button>
      </form>
    </Layout>
  );
}

/** 一度だけ見せるリンクの画面。 */
function LinkPage(props: { readonly title: string; readonly lead: string; readonly link: string }) {
  return (
    <Layout title={props.title}>
      <h1>{props.title}</h1>
      <Notice tone="bad">このリンクはここでしか表示されません。</Notice>
      <p class="lede">{props.lead}</p>
      <section class="panel secret">
        <code>{props.link}</code>
      </section>
      <p class="lede">
        <a class="plain" href="/proposals">
          提案に戻る
        </a>
      </p>
    </Layout>
  );
}

export function proposalRoutes(deps: RouteDeps) {
  const app = new Hono<AppBindings>();
  app.use('/proposals', requireFullSession());
  app.use('/proposals/*', requireFullSession());

  function render(c: Context<AppBindings>, error?: string, notice?: string) {
    const viewer = c.get('viewer');
    if (viewer === undefined) return c.redirect('/login');

    const now = Date.now();
    settleExpired(deps.db, now);

    const all = listProposals(deps.db, {}, now);
    return c.html(
      <ProposalsPage
        viewer={viewer.member}
        members={listMembers(deps.db)}
        active={listActiveMembers(deps.db)}
        open={all.filter((p) => p.status === 'open')}
        closed={all.filter((p) => p.status !== 'open')}
        balance={balanceOf(deps.db, viewer.member.id)}
        error={error}
        notice={notice}
      />,
      error === undefined ? 200 : 400,
    );
  }

  app.get('/proposals', (c) => render(c));

  app.post('/proposals/member-add', async (c) => {
    const viewer = c.get('viewer');
    if (viewer === undefined) return c.redirect('/login');

    const form = await c.req.formData();
    const result = createProposal(deps.db, {
      type: 'member.add',
      proposedBy: viewer.member.id,
      payload: {
        discordId: field(form, 'discordId').trim(),
        username: field(form, 'username').trim(),
        displayName: field(form, 'displayName').trim(),
      },
    });

    if (!result.ok) return render(c, result.reason);
    deps.notify.announce(result.view, viewer.member.displayName);
    return render(c, undefined, summarise(result.view));
  });

  app.post('/proposals/mint', async (c) => {
    const viewer = c.get('viewer');
    if (viewer === undefined) return c.redirect('/login');

    const form = await c.req.formData();
    const subjectMemberId = field(form, 'subjectMemberId');

    // 対象者は有権者から外れるので、自分宛だと誰も承認できない提案が居座る。
    // 画面の選択肢にも自分は出していないが、直接叩かれた場合はここで断る。
    if (subjectMemberId === viewer.member.id) {
      return render(c, '自分宛の発行は提案できません。他のメンバーに出してもらってください');
    }

    const result = createProposal(deps.db, {
      type: 'ledger.mint',
      proposedBy: viewer.member.id,
      subjectMemberId,
      payload: {
        amount: field(form, 'amount'),
        memo: field(form, 'memo'),
      },
    });

    if (!result.ok) return render(c, result.reason);
    deps.notify.announce(result.view, viewer.member.displayName);
    return render(c, undefined, summarise(result.view));
  });

  app.post('/proposals/member-status', async (c) => {
    const viewer = c.get('viewer');
    if (viewer === undefined) return c.redirect('/login');

    const form = await c.req.formData();
    const type = field(form, 'type');
    if (!isProposalType(type)) return render(c, '知らない操作です');

    const result = createProposal(deps.db, {
      type,
      proposedBy: viewer.member.id,
      subjectMemberId: field(form, 'subjectMemberId'),
    });

    if (!result.ok) return render(c, result.reason);
    deps.notify.announce(result.view, viewer.member.displayName);
    return render(c, undefined, summarise(result.view));
  });

  app.post('/proposals/:id/vote', async (c) => {
    const viewer = c.get('viewer');
    if (viewer === undefined) return c.redirect('/login');

    const form = await c.req.formData();
    const choice = field(form, 'choice');
    if (choice !== 'approve' && choice !== 'reject') return render(c, '賛成か反対を選んでください');

    const result = castVote(deps.db, {
      proposalId: c.req.param('id'),
      memberId: viewer.member.id,
      choice,
    });

    if (!result.ok) return render(c, result.reason);
    // 1 票ごとに流すと煩いので、決着したときだけ知らせる。
    if (result.view.status !== 'open') deps.notify.announce(result.view);
    return render(c, undefined, summarise(result.view));
  });

  /** 登録待ちのメンバーに渡すリンクを出す。 */
  app.post('/proposals/enroll-link', async (c) => {
    const viewer = c.get('viewer');
    if (viewer === undefined) return c.redirect('/login');

    const form = await c.req.formData();
    const memberId = field(form, 'memberId');
    const result = issueEnrollLink(deps.db, { memberId, actorMemberId: viewer.member.id });

    if (!result.ok) return render(c, result.reason);

    const link = `${deps.env.webOrigin}/enroll?token=${result.token}`;
    const member = getMember(deps.db, memberId);
    const sent = await deps.notify.deliverLink({
      discordId: memberId,
      kind: 'enroll',
      url: link,
      expiresAt: result.expiresAt,
      displayName: member?.displayName ?? '',
    });

    return c.html(
      <LinkPage
        title="登録リンク"
        lead={
          sent.ok
            ? '本人に DM で送りました。念のため、この画面にも一度だけ出しておきます。7 日で切れます。'
            : `${sent.reason}。下のリンクを本人に直接渡してください。7 日で切れます。`
        }
        link={link}
      />,
    );
  });

  return app;

  function summarise(view: ProposalView): string {
    if (view.status === 'executed') return `可決して実行されました: ${view.summary}`;
    if (view.status === 'rejected') return `否決されました: ${view.summary}`;
    if (view.deadlocked) return `${view.summary} は承認できる人がいないため決着しません`;
    const remaining = view.tally.required - view.tally.approvals;
    return `${view.summary} を受け付けました。あと ${String(remaining)} 票で可決します`;
  }
}
