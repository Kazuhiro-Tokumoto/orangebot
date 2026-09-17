import { Hono, type Context } from 'hono';
import { listAllMembers } from '../../db/members.js';
import { balanceOf, formatAmount } from '../../domain/ledger.js';
import {
  CRITERIA_MAX,
  QUESTION_MAX,
  STALE_AFTER_MS,
  VERDICT_LABELS,
  listMarkets,
  marketImpliedReturn,
  marketView,
  placeMarketBet,
  type MarketView,
} from '../../domain/markets.js';
import { createProposal, listProposals } from '../../domain/proposals.js';
import { field, requireFullSession, type AppBindings, type RouteDeps } from '../context.js';
import { Notice } from '../views/forms.js';
import { GameTabs, Rules, dateTime } from '../views/games.js';
import { Layout } from '../views/layout.js';

/**
 * 画面の日時の入力 (datetime-local) は時差を持たないので、日本時間として読む。
 * 形が違えば NaN。
 */
export function parseJstDateTime(raw: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw)) return Number.NaN;
  return Date.parse(`${raw}:00+09:00`);
}

function statusLabel(view: MarketView, now: number): { readonly text: string; readonly tone: string } {
  const { market } = view;
  if (market.status === 'resolved') {
    return { text: `決着: ${market.outcome === null ? '-' : VERDICT_LABELS[market.outcome]}`, tone: 'ok' };
  }
  if (market.status === 'refunded') return { text: '無効 (返金)', tone: '' };
  if (now < market.closesAt) return { text: '受付中', tone: 'accent' };
  return { text: '判定待ち', tone: 'warn' };
}

export function marketRoutes(deps: RouteDeps) {
  const app = new Hono<AppBindings>();
  app.use('/predict/markets', requireFullSession());
  app.use('/predict/markets/*', requireFullSession());

  async function renderList(c: Context<AppBindings>, error?: string) {
    const viewer = c.get('viewer');
    if (viewer === undefined) return c.redirect('/login');

    const now = Date.now();
    const views = listMarkets(deps.db);
    const pending = listProposals(deps.db, { status: 'open' }, now).filter(
      (proposal) => proposal.type === 'market.open',
    );

    return c.html(
      <Layout title="みんなで予想" viewer={viewer.member.displayName}>
        <h1>みんなで予想</h1>
        <GameTabs current="markets" />
        <p class="lede">
          メンバーが出した「はい / いいえ」の問いに BOAG を賭けます。問いを出すのも、答えを決めるのも、過半数の賛成が要ります。残高は{' '}
          {formatAmount(balanceOf(deps.db, viewer.member.id))} BOAG です。
        </p>

        {error === undefined ? null : <Notice tone="bad">{error}</Notice>}
        {c.req.query('done') === 'proposed' ? (
          <Notice tone="ok">
            問いを提案しました。可決すると賭けられるようになります。<a class="plain" href="/proposals">提案の一覧</a>
          </Notice>
        ) : null}

        <h2>問い</h2>
        <section class="panel">
          {views.length === 0 ? (
            <span class="muted">まだ問いはありません。</span>
          ) : (
            <div class="scroll">
              <table>
                <tr>
                  <th>問い</th>
                  <th>締め切り</th>
                  <th>はい / いいえ</th>
                  <th>状態</th>
                </tr>
                {views.map((view) => {
                  const status = statusLabel(view, now);
                  return (
                    <tr>
                      <td>
                        <a class="plain" href={`/predict/markets/${view.market.id}`}>
                          {view.market.question}
                        </a>
                      </td>
                      <td>{dateTime(view.market.closesAt)}</td>
                      <td class="mono">
                        {formatAmount(view.yes)} / {formatAmount(view.no)}
                      </td>
                      <td>
                        <span class={`tag ${status.tone}`}>{status.text}</span>
                      </td>
                    </tr>
                  );
                })}
              </table>
            </div>
          )}
        </section>

        {pending.length === 0 ? null : (
          <>
            <h2>投票中の問い</h2>
            <section class="panel">
              <ul style="margin:0;padding-left:20px">
                {pending.map((proposal) => (
                  <li>
                    {proposal.summary}{' '}
                    <span class="muted">
                      (賛成 {proposal.tally.approvals} / 必要 {proposal.tally.required})
                    </span>
                  </li>
                ))}
              </ul>
              <p class="field-hint" style="margin:8px 0 0">
                投票は <a class="plain" href="/proposals">提案</a> の画面からです。
              </p>
            </section>
          </>
        )}

        <h2>問いを出す</h2>
        <section class="panel">
          <form class="stack" method="post" action="/predict/markets/propose">
            <label class="field">
              <span class="field-label">問い</span>
              <input
                class="input"
                name="question"
                required
                maxlength={QUESTION_MAX}
                placeholder="今月中に BTC が 10 万ドルを超える?"
              />
              <span class="field-hint">「はい」か「いいえ」で答えが出る形にしてください。</span>
            </label>
            <label class="field">
              <span class="field-label">判定の基準</span>
              <textarea class="input" name="criteria" rows={3} maxlength={CRITERIA_MAX} />
              <span class="field-hint">
                何をもって「はい」とするか。どこの値段か、何時の時点か、など。判定の投票でみんなが見ます。
              </span>
            </label>
            <label class="field">
              <span class="field-label">締め切り (日本時間)</span>
              <input class="input" type="datetime-local" name="closesAt" required />
              <span class="field-hint">
                ここまで賭けられます。今から 1 時間以上先、1 年以内。可決までに過ぎると、問いは開かずに終わります。
              </span>
            </label>
            <button class="btn" type="submit">
              提案する
            </button>
          </form>
        </section>

        <Rules>
          <li>問いは過半数で可決すると開き、締め切りまで「はい」か「いいえ」に賭けられます。両方には賭けられません。</li>
          <li>締め切りの後、誰でも判定を提案できます。はい、いいえ、無効のどれかを選び、過半数で決まります。</li>
          <li>当てた側で、外した側の賭け金を賭け金に比例して分けます。胴元は取りません。</li>
          <li>無効の判定、片側にしか賭けが無い問い、締め切りから {Math.round(STALE_AFTER_MS / 86_400_000)} 日判定が決まらない問いは、全員に返します。</li>
          <li>賭けた人も判定に投票できます。基準を具体的に書いておくと揉めません。</li>
        </Rules>
      </Layout>,
      error === undefined ? 200 : 400,
    );
  }

  async function renderMarket(c: Context<AppBindings>, id: string, error?: string) {
    const viewer = c.get('viewer');
    if (viewer === undefined) return c.redirect('/login');

    const view = marketView(deps.db, id);
    if (view === undefined) return c.notFound();

    const now = Date.now();
    const { market } = view;
    const open = market.status === 'open' && now < market.closesAt;
    const awaiting = market.status === 'open' && now >= market.closesAt;
    const status = statusLabel(view, now);
    const names = new Map(listAllMembers(deps.db).map((member) => [member.id, member.displayName]));
    const myBets = view.bets.filter((bet) => bet.memberId === viewer.member.id);
    const mySide = myBets[0]?.side;
    const resolution = listProposals(deps.db, { status: 'open' }, now).find(
      (proposal) => proposal.type === 'market.resolve' && proposal.payload['marketId'] === market.id,
    );
    const done = c.req.query('done');

    return c.html(
      <Layout title="みんなで予想" viewer={viewer.member.displayName}>
        <h1>{market.question}</h1>
        <GameTabs current="markets" />
        <p class="row">
          <span class={`tag ${status.tone}`}>{status.text}</span>
          <span class="muted">締め切り {dateTime(market.closesAt)}</span>
        </p>

        {error === undefined ? null : <Notice tone="bad">{error}</Notice>}
        {done === 'bet' ? <Notice tone="ok">賭けました。</Notice> : null}
        {done === 'resolve' ? (
          <Notice tone="ok">
            判定を提案しました。<a class="plain" href="/proposals">提案の一覧</a>で投票できます。
          </Notice>
        ) : null}

        <section class="panel">
          <strong>判定の基準</strong>
          <p class="post-body">{market.criteria === '' ? '(書かれていません)' : market.criteria}</p>
        </section>

        <div class="grid">
          <div class="stat">
            <div class="k">はいに賭けた合計</div>
            <div class="big">{formatAmount(view.yes)}</div>
            <div class="k">当たれば 1 BOAG が {marketImpliedReturn(view, 'yes') ?? '-'} BOAG に</div>
          </div>
          <div class="stat">
            <div class="k">いいえに賭けた合計</div>
            <div class="big">{formatAmount(view.no)}</div>
            <div class="k">当たれば 1 BOAG が {marketImpliedReturn(view, 'no') ?? '-'} BOAG に</div>
          </div>
        </div>

        {open ? (
          <section class="panel" style="margin-top:14px">
            {mySide === undefined ? null : (
              <p class="field-hint" style="margin:0 0 12px">
                あなたは{VERDICT_LABELS[mySide]}に{' '}
                {formatAmount(myBets.reduce((sum, bet) => sum + BigInt(bet.stake), 0n))} BOAG 賭けています。
              </p>
            )}
            <form class="stack" method="post" action={`/predict/markets/${market.id}/bet`}>
              <label class="field">
                <span class="field-label">賭け金 (BOAG)</span>
                <input class="input" name="amount" inputmode="decimal" required placeholder="1" />
                <span class="field-hint">
                  0.000001 以上。小数は 16 桁まで。残高は {formatAmount(balanceOf(deps.db, viewer.member.id))} BOAG。
                </span>
              </label>
              <div class="row">
                <button class="btn" type="submit" name="side" value="yes">
                  はい
                </button>
                <button class="btn danger" type="submit" name="side" value="no">
                  いいえ
                </button>
              </div>
            </form>
          </section>
        ) : null}

        {awaiting ? (
          <section class="panel" style="margin-top:14px">
            <strong>判定</strong>
            {resolution === undefined ? (
              <form class="stack" method="post" action={`/predict/markets/${market.id}/resolve`}>
                <p class="field-hint" style="margin:0">
                  締め切りを過ぎました。答えを提案してください。過半数の賛成で決まり、払い戻します。
                </p>
                <div class="row">
                  <button class="btn" type="submit" name="outcome" value="yes">
                    はい
                  </button>
                  <button class="btn danger" type="submit" name="outcome" value="no">
                    いいえ
                  </button>
                  <button class="btn quiet" type="submit" name="outcome" value="void">
                    無効にして返す
                  </button>
                </div>
              </form>
            ) : (
              <p class="field-hint" style="margin:6px 0 0">
                判定の提案が出ています: {resolution.summary} (賛成 {resolution.tally.approvals} / 必要{' '}
                {resolution.tally.required})。<a class="plain" href="/proposals">投票する</a>
              </p>
            )}
          </section>
        ) : null}

        <h2>賭け</h2>
        <section class="panel">
          {view.bets.length === 0 ? (
            <span class="muted">まだ賭けはありません。</span>
          ) : (
            <div class="scroll">
              <table>
                <tr>
                  <th>日時</th>
                  <th>メンバー</th>
                  <th>側</th>
                  <th>賭け金</th>
                  <th>払い戻し</th>
                </tr>
                {view.bets.map((bet) => (
                  <tr>
                    <td>{dateTime(bet.placedAt)}</td>
                    <td>{names.get(bet.memberId) ?? bet.memberId}</td>
                    <td>{VERDICT_LABELS[bet.side]}</td>
                    <td class="mono">{formatAmount(BigInt(bet.stake))}</td>
                    <td class="mono">{bet.payout === null ? '-' : formatAmount(BigInt(bet.payout))}</td>
                  </tr>
                ))}
              </table>
            </div>
          )}
        </section>

        <p>
          <a class="plain" href="/predict/markets">
            問いの一覧へ
          </a>
        </p>
      </Layout>,
      error === undefined ? 200 : 400,
    );
  }

  app.get('/predict/markets', (c) => renderList(c));

  app.post('/predict/markets/propose', async (c) => {
    const viewer = c.get('viewer');
    if (viewer === undefined) return c.redirect('/login');

    const form = await c.req.formData();
    const closesAt = parseJstDateTime(field(form, 'closesAt'));
    const result = createProposal(deps.db, {
      type: 'market.open',
      proposedBy: viewer.member.id,
      payload: {
        question: field(form, 'question'),
        criteria: field(form, 'criteria'),
        closesAt: Number.isNaN(closesAt) ? null : closesAt,
      },
    });
    if (!result.ok) return renderList(c, result.reason);
    deps.notify.announce(result.view, viewer.member.displayName);
    return c.redirect('/predict/markets?done=proposed');
  });

  app.get('/predict/markets/:id', (c) => renderMarket(c, c.req.param('id')));

  app.post('/predict/markets/:id/bet', async (c) => {
    const viewer = c.get('viewer');
    if (viewer === undefined) return c.redirect('/login');

    const id = c.req.param('id');
    const form = await c.req.formData();
    const result = placeMarketBet(deps.db, {
      marketId: id,
      memberId: viewer.member.id,
      side: field(form, 'side'),
      amount: field(form, 'amount'),
    });
    if (!result.ok) return renderMarket(c, id, result.reason);
    return c.redirect(`/predict/markets/${encodeURIComponent(id)}?done=bet`);
  });

  app.post('/predict/markets/:id/resolve', async (c) => {
    const viewer = c.get('viewer');
    if (viewer === undefined) return c.redirect('/login');

    const id = c.req.param('id');
    const form = await c.req.formData();
    const result = createProposal(deps.db, {
      type: 'market.resolve',
      proposedBy: viewer.member.id,
      payload: { marketId: id, outcome: field(form, 'outcome') },
    });
    if (!result.ok) return renderMarket(c, id, result.reason);
    deps.notify.announce(result.view, viewer.member.displayName);
    return c.redirect(`/predict/markets/${encodeURIComponent(id)}?done=resolve`);
  });

  return app;
}
