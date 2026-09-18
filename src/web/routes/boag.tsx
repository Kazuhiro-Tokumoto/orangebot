import { Hono, type Context } from 'hono';
import { listActiveMembers, listAllMembers } from '../../db/members.js';
import type { MemberRow } from '../../db/schema.js';
import {
  EXCHANGE_ACCOUNT,
  SUPPLY_ACCOUNT,
  balanceOf,
  formatAmount,
  recentMovements,
  sendToMember,
  type MovementView,
} from '../../domain/ledger.js';
import { field, requireFullSession, type AppBindings, type RouteDeps } from '../context.js';
import { Field, Notice, Select, Submit, TextArea } from '../views/forms.js';
import { Layout } from '../views/layout.js';

function when(ms: number): string {
  return new Date(ms).toLocaleString('ja-JP', { hour12: false });
}

const DONE: Readonly<Record<string, string>> = {
  sent: '送りました。相手の残高にすぐ入っています。',
};

/** 動きの見出し。同じ transfer でも、自分から見た向きで呼び名が変わる。 */
function kindLabel(movement: MovementView): string {
  if (movement.kind === 'mint') return '発行';
  if (movement.kind === 'burn') return '焼却';
  if (movement.kind === 'exchange') return 'pt との交換';
  if (movement.ref?.startsWith('post:') === true) {
    return movement.amount > 0n ? '投げ銭を受け取り' : '投げ銭';
  }
  return movement.amount > 0n ? '受け取り' : '送り';
}

/** 口座の呼び名。特別口座はそのまま出しても分からないので言い換える。 */
function accountLabel(members: readonly MemberRow[], accountId: string | null): string {
  if (accountId === null) return '-';
  if (accountId === SUPPLY_ACCOUNT) return '発行元';
  if (accountId === EXCHANGE_ACCOUNT) return 'pt との交換';
  const member = members.find((m) => m.id === accountId);
  return member === undefined ? accountId : member.displayName;
}

function BoagPage(props: {
  readonly viewer: MemberRow;
  readonly members: readonly MemberRow[];
  readonly others: readonly MemberRow[];
  readonly balance: bigint;
  readonly movements: readonly MovementView[];
  readonly error?: string | undefined;
  readonly done?: string | undefined;
}) {
  return (
    <Layout title="BOAG のやりとり" viewer={props.viewer.displayName}>
      <h1>BOAG のやりとり</h1>
      <p class="lede">
        あなたの残高は {formatAmount(props.balance)} BOAG です。
        送るのに承認は要りません。自分の残高を動かすだけで、総量は変わらないためです。
      </p>

      {props.error === undefined ? null : <Notice tone="bad">{props.error}</Notice>}
      {props.done === undefined ? null : <Notice tone="ok">{props.done}</Notice>}

      <h2>メンバーに送る</h2>
      <section class="panel">
        {props.others.length === 0 ? (
          <span class="muted">送れる相手がいません。</span>
        ) : (
          <>
            <p class="field-hint" style="margin:0 0 14px">
              送った分はすぐ相手の残高に入ります。取り消せません。
              受け取れるのは有効なメンバーだけです。
            </p>
            <form class="stack" method="post" action="/boag/send">
              <Select
                label="宛先"
                name="toMemberId"
                options={props.others.map((m) => ({
                  value: m.id,
                  label: `${m.displayName}（${m.username}）`,
                }))}
              />
              <Field
                label="送る額"
                name="amount"
                required
                inputmode="decimal"
                placeholder="1000"
                hint="0 より大きく、小数 16 桁まで。"
              />
              <TextArea
                label="ひとこと"
                name="memo"
                rows={2}
                hint="台帳に残ります。省いても構いません。"
              />
              <Submit>送る</Submit>
            </form>
          </>
        )}
      </section>

      <h2>台帳の動き</h2>
      <section class="panel">
        {props.movements.length === 0 ? (
          <span class="muted">まだありません。</span>
        ) : (
          <div class="scroll">
            <table>
              <tr>
                <th>日時</th>
                <th>種類</th>
                <th>相手</th>
                <th>増減</th>
                <th>ひとこと</th>
              </tr>
              {props.movements.map((movement) => (
                <tr>
                  <td>{when(movement.createdAt)}</td>
                  <td>{kindLabel(movement)}</td>
                  <td>{accountLabel(props.members, movement.counterparty)}</td>
                  <td class="mono">
                    {movement.amount > 0n ? '+' : ''}
                    {formatAmount(movement.amount)}
                  </td>
                  <td class="muted">{movement.memo}</td>
                </tr>
              ))}
            </table>
          </div>
        )}
      </section>
    </Layout>
  );
}

/**
 * メンバー同士の BOAG のやりとり。
 *
 * pt との交換は /exchange、発行は提案。ここは既にある残高を動かすだけの画面である。
 */
export function boagRoutes(deps: RouteDeps) {
  const app = new Hono<AppBindings>();
  app.use('/boag', requireFullSession());
  app.use('/boag/*', requireFullSession());

  function render(c: Context<AppBindings>, error?: string) {
    const viewer = c.get('viewer');
    if (viewer === undefined) return c.redirect('/login');

    return c.html(
      <BoagPage
        viewer={viewer.member}
        members={listAllMembers(deps.db)}
        others={listActiveMembers(deps.db).filter((m) => m.id !== viewer.member.id)}
        balance={balanceOf(deps.db, viewer.member.id)}
        movements={recentMovements(deps.db, viewer.member.id)}
        error={error}
        done={DONE[c.req.query('done') ?? '']}
      />,
      error === undefined ? 200 : 400,
    );
  }

  app.get('/boag', (c) => render(c));

  app.post('/boag/send', async (c) => {
    const viewer = c.get('viewer');
    if (viewer === undefined) return c.redirect('/login');

    const form = await c.req.formData();
    const result = sendToMember(deps.db, {
      fromMemberId: viewer.member.id,
      toMemberId: field(form, 'toMemberId'),
      amount: field(form, 'amount'),
      memo: field(form, 'memo'),
    });
    if (!result.ok) return render(c, result.reason);

    return c.redirect('/boag?done=sent');
  });

  return app;
}
