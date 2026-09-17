import { Hono, type Context } from 'hono';
import type { ExchangeWithdrawalRow } from '../../db/schema.js';
import {
  listDeposits,
  listWithdrawals,
  requestWithdrawal,
  requeueWithdrawal,
} from '../../domain/exchange.js';
import { balanceOf, formatAmount } from '../../domain/ledger.js';
import { PT_PER_BOAG, SOAG_PER_PT } from '../../domain/units.js';
import { field, requireFullSession, type AppBindings, type RouteDeps } from '../context.js';
import { Field, Notice, Submit } from '../views/forms.js';
import { Layout } from '../views/layout.js';

function when(ms: number): string {
  return new Date(ms).toLocaleString('ja-JP', { hour12: false });
}

const WITHDRAW_LABEL: Readonly<Record<ExchangeWithdrawalRow['status'], string>> = {
  pending: '送っています',
  delivered: '届きました',
  refunded: '返金しました',
  stuck: '止まっています',
};

const WITHDRAW_TONE: Readonly<Record<ExchangeWithdrawalRow['status'], string>> = {
  pending: 'warn',
  delivered: 'ok',
  refunded: 'bad',
  stuck: 'bad',
};

const DONE: Readonly<Record<string, string>> = {
  requested: '受け付けました。相手の bot へ送っています。届くと「届きました」に変わります。',
  requeued: 'もう一度送る列に戻しました。',
};

/**
 * pt との交換の画面。
 *
 * BOAG から pt へはここから出す。pt から BOAG へは相手の bot 側で操作する。
 */
export function exchangeRoutes(deps: RouteDeps) {
  const app = new Hono<AppBindings>();
  app.use('/exchange', requireFullSession());
  app.use('/exchange/*', requireFullSession());

  const config = deps.env.exchange;

  function render(c: Context<AppBindings>, error?: string) {
    const viewer = c.get('viewer');
    if (viewer === undefined) return c.redirect('/login');

    const done = DONE[c.req.query('done') ?? ''];
    const balance = balanceOf(deps.db, viewer.member.id);
    const withdrawals = listWithdrawals(deps.db, viewer.member.id);
    const deposits = listDeposits(deps.db, viewer.member.id);

    return c.html(
      <Layout title="pt との交換" viewer={viewer.member.displayName}>
        <h1>pt との交換</h1>
        <p class="lede">
          {PT_PER_BOAG.toLocaleString('en-US')} pt = 1 BOAG です。1 pt は{' '}
          {formatAmount(SOAG_PER_PT)} BOAG にあたります。残高は {formatAmount(balance)} BOAG です。
        </p>

        {error === undefined ? null : <Notice tone="bad">{error}</Notice>}
        {done === undefined ? null : <Notice tone="ok">{done}</Notice>}

        {config === undefined ? (
          <Notice tone="warn">交換は止めてあります (EXCHANGE_SECRET が未設定)。</Notice>
        ) : (
          <>
            <h2>BOAG を pt に換える</h2>
            <section class="panel">
              {config.partnerUrl === undefined ? (
                <span class="muted">相手の受け口が未設定なので、pt へは換えられません。</span>
              ) : (
                <>
                  <p class="field-hint" style="margin:0 0 14px">
                    BOAG はすぐ残高から引かれ、相手の bot に届くまで送り続けます。
                    相手がはっきり断った場合だけ、自動で返金します。
                  </p>
                  <form class="stack" method="post" action="/exchange/withdraw">
                    <Field
                      label="受け取る pt"
                      name="pt"
                      required
                      inputmode="numeric"
                      placeholder="10000000"
                      hint={`1 以上の整数。1 回 ${config.limits.maxPtPerRequest.toLocaleString('en-US')} pt まで。`}
                    />
                    <Submit>換える</Submit>
                  </form>
                </>
              )}
            </section>

            <h2>pt を BOAG に換える</h2>
            <section class="panel">
              <span class="field-hint">
                相手の bot の側で操作してください。届いた分は下の「受け取った入金」に出ます。
              </span>
            </section>
          </>
        )}

        <h2>出した交換</h2>
        <section class="panel">
          {withdrawals.length === 0 ? (
            <span class="muted">まだありません。</span>
          ) : (
            <div class="scroll">
              <table>
                <tr>
                  <th>日時</th>
                  <th>pt</th>
                  <th>BOAG</th>
                  <th>状態</th>
                  <th>送った回数</th>
                  <th />
                </tr>
                {withdrawals.map((row) => (
                  <tr>
                    <td>{when(row.createdAt)}</td>
                    <td class="mono">{BigInt(row.pt).toLocaleString('en-US')}</td>
                    <td class="mono">{formatAmount(BigInt(row.soag))}</td>
                    <td>
                      <span class={`tag ${WITHDRAW_TONE[row.status]}`}>{WITHDRAW_LABEL[row.status]}</span>
                      {row.lastError === null || row.status === 'delivered' ? null : (
                        <div class="field-hint">{row.lastError}</div>
                      )}
                    </td>
                    <td class="mono">{String(row.attempts)}</td>
                    <td>
                      {row.status === 'stuck' ? (
                        <form method="post" action={`/exchange/withdraw/${row.id}/requeue`}>
                          <button class="btn quiet" type="submit">
                            もう一度送る
                          </button>
                        </form>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </table>
            </div>
          )}
        </section>

        <h2>受け取った入金</h2>
        <section class="panel">
          {deposits.length === 0 ? (
            <span class="muted">まだありません。</span>
          ) : (
            <div class="scroll">
              <table>
                <tr>
                  <th>日時</th>
                  <th>pt</th>
                  <th>BOAG</th>
                  <th>相手の取引番号</th>
                </tr>
                {deposits.map((row) => (
                  <tr>
                    <td>{when(row.createdAt)}</td>
                    <td class="mono">{BigInt(row.pt).toLocaleString('en-US')}</td>
                    <td class="mono">{formatAmount(BigInt(row.soag))}</td>
                    <td class="mono muted">{row.id}</td>
                  </tr>
                ))}
              </table>
            </div>
          )}
        </section>
      </Layout>,
      error === undefined ? 200 : 400,
    );
  }

  app.get('/exchange', (c) => render(c));

  app.post('/exchange/withdraw', async (c) => {
    const viewer = c.get('viewer');
    if (viewer === undefined) return c.redirect('/login');
    if (config?.partnerUrl === undefined) return render(c, '相手の受け口が未設定です');

    const form = await c.req.formData();
    const result = requestWithdrawal(deps.db, {
      memberId: viewer.member.id,
      pt: field(form, 'pt'),
      limits: config.limits,
    });
    if (!result.ok) return render(c, result.message);

    // 次の巡回を待たずに、すぐ 1 回送ってみる。失敗しても巡回が続きを引き受ける。
    deps.onWithdrawalRequested?.();
    return c.redirect('/exchange?done=requested');
  });

  app.post('/exchange/withdraw/:id/requeue', (c) => {
    const viewer = c.get('viewer');
    if (viewer === undefined) return c.redirect('/login');

    const result = requeueWithdrawal(deps.db, { id: c.req.param('id'), memberId: viewer.member.id });
    if (!result.ok) return render(c, result.message);
    deps.onWithdrawalRequested?.();
    return c.redirect('/exchange?done=requeued');
  });

  return app;
}
