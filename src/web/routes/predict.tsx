import { Hono, type Context } from 'hono';
import type { PredictionBetRow } from '../../db/schema.js';
import { balanceOf, formatAmount } from '../../domain/ledger.js';
import {
  BET_CUTOFF_MS,
  ROUND_MS,
  bettableStart,
  impliedReturn,
  placeBet,
  recentRounds,
  roundId,
  roundView,
  type RoundView,
} from '../../domain/prediction.js';
import type { Ticker } from '../../market/price.js';
import { field, requireFullSession, type AppBindings, type RouteDeps } from '../context.js';
import { Notice } from '../views/forms.js';
import { COUNTDOWN_SCRIPT, GameTabs, Rules, clock } from '../views/games.js';
import { Layout } from '../views/layout.js';

const OUTCOME_LABEL = { up: '上', down: '下', flat: '変わらず' } as const;

/** 値段の問い合わせを数秒だけ覚えておく。開くたびに取引所へ行かないため。 */
const TICKER_CACHE_MS = 5_000;

function mineIn(view: RoundView | undefined, memberId: string): PredictionBetRow[] {
  return view === undefined ? [] : view.bets.filter((bet) => bet.memberId === memberId);
}

function sumStake(bets: readonly PredictionBetRow[]): bigint {
  return bets.reduce((sum, bet) => sum + BigInt(bet.stake), 0n);
}

function Pools({ view }: { view: RoundView | undefined }) {
  const up = view?.pools.up ?? 0n;
  const down = view?.pools.down ?? 0n;
  const pools = { up, down };
  return (
    <div class="grid">
      <div class="stat">
        <div class="k">上に賭けた合計</div>
        <div class="big">{formatAmount(up)}</div>
        <div class="k">当たれば 1 BOAG が {impliedReturn(pools, 'up') ?? '-'} BOAG に</div>
      </div>
      <div class="stat">
        <div class="k">下に賭けた合計</div>
        <div class="big">{formatAmount(down)}</div>
        <div class="k">当たれば 1 BOAG が {impliedReturn(pools, 'down') ?? '-'} BOAG に</div>
      </div>
    </div>
  );
}

export function predictRoutes(deps: RouteDeps) {
  const app = new Hono<AppBindings>();
  app.use('/predict', requireFullSession());
  app.use('/predict/*', requireFullSession());

  const symbols = deps.env.prediction?.symbols ?? [];
  const tickerCache = new Map<string, { readonly at: number; readonly ticker: Ticker }>();

  async function tickerFor(symbol: string): Promise<Ticker | undefined> {
    if (deps.prices === undefined) return undefined;
    const cached = tickerCache.get(symbol);
    if (cached !== undefined && Date.now() - cached.at < TICKER_CACHE_MS) return cached.ticker;
    try {
      const ticker = await deps.prices.ticker(symbol);
      tickerCache.set(symbol, { at: Date.now(), ticker });
      return ticker;
    } catch {
      return undefined;
    }
  }

  function pickSymbol(c: Context<AppBindings>, fallback?: string): string | undefined {
    const wanted = (fallback ?? c.req.query('symbol') ?? '').toUpperCase();
    return symbols.includes(wanted) ? wanted : symbols[0];
  }

  async function render(c: Context<AppBindings>, error?: string, chosen?: string) {
    const viewer = c.get('viewer');
    if (viewer === undefined) return c.redirect('/login');

    const symbol = pickSymbol(c, chosen);
    if (symbol === undefined) {
      return c.html(
        <Layout title="値動きの予想" viewer={viewer.member.displayName}>
          <h1>値動きの予想</h1>
          <GameTabs current="updown" />
          <Notice tone="warn">予想は止めてあります (PREDICTION_SYMBOLS=none)。</Notice>
        </Layout>,
      );
    }

    const now = Date.now();
    const next = bettableStart(now);
    const current = next - ROUND_MS;
    const nextView = roundView(deps.db, roundId(symbol, next));
    const currentView = roundView(deps.db, roundId(symbol, current));
    const history = recentRounds(deps.db, symbol, 20).filter((view) => view.round.status !== 'open');
    const ticker = await tickerFor(symbol);
    const myNext = mineIn(nextView, viewer.member.id);
    const myCurrent = mineIn(currentView, viewer.member.id);
    const done = c.req.query('done') === 'bet';

    return c.html(
      <Layout title="値動きの予想" viewer={viewer.member.displayName} script={COUNTDOWN_SCRIPT}>
        <h1>値動きの予想</h1>
        <GameTabs current="updown" />
        <p class="lede">
          次の 5 分で上がるか下がるかを BOAG で予想します。残高は{' '}
          {formatAmount(balanceOf(deps.db, viewer.member.id))} BOAG です。
        </p>

        <p class="row">
          {symbols.map((item) => (
            <a class={`tag ${item === symbol ? 'accent' : ''}`} href={`/predict?symbol=${item}`}>
              {item}
            </a>
          ))}
        </p>

        {error === undefined ? null : <Notice tone="bad">{error}</Notice>}
        {done ? <Notice tone="ok">賭けました。</Notice> : null}

        <section class="panel">
          <div class="row" style="justify-content:space-between">
            <strong>いまの値段</strong>
            <span class="big mono">{ticker?.price ?? '取れません'}</span>
          </div>
        </section>

        <h2>
          次の回 {clock(next)} から {clock(next + ROUND_MS)} まで
        </h2>
        <p class="field-hint" id="countdown" data-deadline={String(next - BET_CUTOFF_MS)}>
          {clock(next - BET_CUTOFF_MS)} に締め切り
        </p>
        <Pools view={nextView} />

        <section class="panel" style="margin-top:14px">
          {myNext.length === 0 ? null : (
            <p class="field-hint" style="margin:0 0 12px">
              この回にあなたは {myNext[0]?.side === 'up' ? '上' : '下'} へ{' '}
              {formatAmount(sumStake(myNext))} BOAG 賭けています。
            </p>
          )}
          <form class="stack" method="post" action="/predict/bet">
            <input type="hidden" name="symbol" value={symbol} />
            <input type="hidden" name="startsAt" value={String(next)} />
            <label class="field">
              <span class="field-label">賭け金 (BOAG)</span>
              <input class="input" name="amount" inputmode="decimal" required placeholder="1" />
              <span class="field-hint">0.000001 以上。小数は 16 桁まで。</span>
            </label>
            <div class="row">
              <button class="btn" type="submit" name="side" value="up">
                上がる
              </button>
              <button class="btn danger" type="submit" name="side" value="down">
                下がる
              </button>
            </div>
          </form>
        </section>

        <h2>
          進行中の回 {clock(current)} から {clock(next)} まで
        </h2>
        <p class="field-hint">締め切り済みです。足が閉じてしばらくすると決着します。</p>
        <Pools view={currentView} />
        {myCurrent.length === 0 ? null : (
          <p class="field-hint" style="margin-top:10px">
            あなたは {myCurrent[0]?.side === 'up' ? '上' : '下'} へ {formatAmount(sumStake(myCurrent))}{' '}
            BOAG 賭けています。
          </p>
        )}

        <h2>これまでの回</h2>
        <section class="panel">
          {history.length === 0 ? (
            <span class="muted">まだ決着した回はありません。</span>
          ) : (
            <div class="scroll">
              <table>
                <tr>
                  <th>回</th>
                  <th>始値</th>
                  <th>終値</th>
                  <th>結果</th>
                  <th>上 / 下</th>
                  <th>あなた</th>
                </tr>
                {history.map((view) => {
                  const mine = mineIn(view, viewer.member.id);
                  const payout = mine.reduce((sum, bet) => sum + BigInt(bet.payout ?? '0'), 0n);
                  return (
                    <tr>
                      <td>{clock(view.round.startsAt)}</td>
                      <td class="mono">{view.round.openPrice ?? '-'}</td>
                      <td class="mono">{view.round.closePrice ?? '-'}</td>
                      <td>
                        {view.round.status === 'refunded'
                          ? '返金'
                          : view.round.outcome === null
                            ? '-'
                            : OUTCOME_LABEL[view.round.outcome]}
                      </td>
                      <td class="mono">
                        {formatAmount(view.pools.up)} / {formatAmount(view.pools.down)}
                      </td>
                      <td class="mono">
                        {mine.length === 0
                          ? '-'
                          : `${formatAmount(sumStake(mine))} → ${formatAmount(payout)}`}
                      </td>
                    </tr>
                  );
                })}
              </table>
            </div>
          )}
        </section>

        <Rules>
            <li>回は取引所 (Binance) の 5 分足 1 本です。始まる 10 秒前に締め切ります。</li>
            <li>終値が始値より上なら「上がる」、下なら「下がる」の勝ちです。同じなら全員に返します。</li>
            <li>
              負けた側の賭け金を、勝った側で賭け金に比例して分けます。胴元は取りません。
            </li>
            <li>片側にしか賭けが無い回は、相手がいないので全員に返します。</li>
            <li>値段が 30 分取れなかった回は、全員に返します。</li>
            <li>同じ回で上と下の両方には賭けられません。</li>
        </Rules>
      </Layout>,
      error === undefined ? 200 : 400,
    );
  }

  app.get('/predict', (c) => render(c));

  app.post('/predict/bet', async (c) => {
    const viewer = c.get('viewer');
    if (viewer === undefined) return c.redirect('/login');

    const form = await c.req.formData();
    const symbol = field(form, 'symbol').toUpperCase();
    const result = placeBet(deps.db, {
      memberId: viewer.member.id,
      symbol,
      symbols,
      side: field(form, 'side'),
      amount: field(form, 'amount'),
      startsAt: Number(field(form, 'startsAt')),
    });
    if (!result.ok) return render(c, result.reason, symbol);

    // 再読み込みで同じ賭けをもう一度送らないよう、GET に移す。
    return c.redirect(`/predict?symbol=${encodeURIComponent(symbol)}&done=bet`);
  });

  return app;
}
