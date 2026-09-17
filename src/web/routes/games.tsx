import { Hono, type Context } from 'hono';
import type { GameEntryRow } from '../../db/schema.js';
import {
  GAME_ROUND_MS,
  VOLATILITY_BANDS,
  bandLabel,
  enterClosest,
  enterRanking,
  enterVolatility,
  formatRange,
  gameBettableStart,
  gameRoundId,
  gameRoundView,
  poolsByPick,
  rankingSymbolsOf,
  recentGameRounds,
  resultOf,
  type GameRoundView,
} from '../../domain/games.js';
import { balanceOf, formatAmount } from '../../domain/ledger.js';
import { BET_CUTOFF_MS } from '../../domain/prediction.js';
import { formatChange, type Ticker } from '../../market/price.js';
import { field, requireFullSession, type AppBindings, type RouteDeps } from '../context.js';
import { Notice } from '../views/forms.js';
import { COUNTDOWN_SCRIPT, GameTabs, Rules, clock, multiplier } from '../views/games.js';
import { Layout } from '../views/layout.js';

const TICKER_CACHE_MS = 5_000;

function mine(view: GameRoundView | undefined, memberId: string): GameEntryRow | undefined {
  return view?.entries.find((entry) => entry.memberId === memberId);
}

function Outcome({ entry }: { entry: GameEntryRow | undefined }) {
  if (entry === undefined) return <>-</>;
  const stake = formatAmount(BigInt(entry.stake));
  return <>{entry.payout === null ? stake : `${stake} → ${formatAmount(BigInt(entry.payout))}`}</>;
}

function StakeField() {
  return (
    <label class="field">
      <span class="field-label">賭け金 (BOAG)</span>
      <input class="input" name="amount" inputmode="decimal" required placeholder="1" />
      <span class="field-hint">0.000001 以上。小数は 16 桁まで。1 回に 1 つだけで、後から変えられません。</span>
    </label>
  );
}

function Deadline({ startsAt }: { startsAt: number }) {
  return (
    <p class="field-hint" id="countdown" data-deadline={String(startsAt - BET_CUTOFF_MS)}>
      {clock(startsAt - BET_CUTOFF_MS)} に締め切り
    </p>
  );
}

export function gameRoutes(deps: RouteDeps) {
  const app = new Hono<AppBindings>();
  app.use('/predict/closest', requireFullSession());
  app.use('/predict/closest/*', requireFullSession());
  app.use('/predict/ranking', requireFullSession());
  app.use('/predict/ranking/*', requireFullSession());
  app.use('/predict/volatility', requireFullSession());
  app.use('/predict/volatility/*', requireFullSession());

  const symbols = deps.env.prediction?.symbols ?? [];
  const rankingSymbols = deps.env.prediction?.rankingSymbols ?? [];
  const tickerCache = new Map<string, { readonly at: number; readonly ticker: Ticker }>();

  async function priceOf(symbol: string): Promise<string | undefined> {
    if (deps.prices === undefined) return undefined;
    const cached = tickerCache.get(symbol);
    if (cached !== undefined && Date.now() - cached.at < TICKER_CACHE_MS) return cached.ticker.price;
    try {
      const ticker = await deps.prices.ticker(symbol);
      tickerCache.set(symbol, { at: Date.now(), ticker });
      return ticker.price;
    } catch {
      return undefined;
    }
  }

  function disabled(
    c: Context<AppBindings>,
    title: string,
    tab: 'closest' | 'ranking' | 'volatility',
    note: string,
  ) {
    const viewer = c.get('viewer');
    return c.html(
      <Layout title={title} viewer={viewer?.member.displayName}>
        <h1>{title}</h1>
        <GameTabs current={tab} />
        <Notice tone="warn">{note}</Notice>
      </Layout>,
    );
  }

  // --- 終値予想 -----------------------------------------------------------

  async function renderClosest(c: Context<AppBindings>, error?: string, chosen?: string) {
    const viewer = c.get('viewer');
    if (viewer === undefined) return c.redirect('/login');

    const wanted = (chosen ?? c.req.query('symbol') ?? '').toUpperCase();
    const symbol = symbols.includes(wanted) ? wanted : symbols[0];
    if (symbol === undefined) {
      return disabled(c, '終値予想', 'closest', '予想は止めてあります (PREDICTION_SYMBOLS=none)。');
    }

    const now = Date.now();
    const next = gameBettableStart(now);
    const current = next - GAME_ROUND_MS;
    const nextView = gameRoundView(deps.db, gameRoundId('closest', symbol, next));
    const currentView = gameRoundView(deps.db, gameRoundId('closest', symbol, current));
    const history = recentGameRounds(deps.db, 'closest', symbol, 20).filter(
      (view) => view.round.status !== 'open',
    );
    const myNext = mine(nextView, viewer.member.id);
    const price = await priceOf(symbol);

    return c.html(
      <Layout title="終値予想" viewer={viewer.member.displayName} script={COUNTDOWN_SCRIPT}>
        <h1>終値予想</h1>
        <GameTabs current="closest" />
        <p class="lede">
          1 時間後の値段をぴったり当てます。いちばん近かった人が、ほかの人の賭け金を取ります。残高は{' '}
          {formatAmount(balanceOf(deps.db, viewer.member.id))} BOAG です。
        </p>

        <p class="row">
          {symbols.map((item) => (
            <a class={`tag ${item === symbol ? 'accent' : ''}`} href={`/predict/closest?symbol=${item}`}>
              {item}
            </a>
          ))}
        </p>

        {error === undefined ? null : <Notice tone="bad">{error}</Notice>}
        {c.req.query('done') === 'entered' ? <Notice tone="ok">予想を出しました。</Notice> : null}

        <section class="panel">
          <div class="row" style="justify-content:space-between">
            <strong>いまの値段</strong>
            <span class="big mono">{price ?? '取れません'}</span>
          </div>
        </section>

        <h2>
          次の回 {clock(next + GAME_ROUND_MS)} の値段を当てる
        </h2>
        <Deadline startsAt={next} />
        <div class="grid">
          <div class="stat">
            <div class="k">参加</div>
            <div class="big">{nextView?.entries.length ?? 0} 人</div>
          </div>
          <div class="stat">
            <div class="k">賭け金の合計</div>
            <div class="big">{formatAmount(nextView?.total ?? 0n)}</div>
          </div>
        </div>

        <section class="panel" style="margin-top:14px">
          {myNext === undefined ? (
            <form class="stack" method="post" action="/predict/closest/enter">
              <input type="hidden" name="symbol" value={symbol} />
              <input type="hidden" name="startsAt" value={String(next)} />
              <label class="field">
                <span class="field-label">{clock(next + GAME_ROUND_MS)} の値段 (USDT)</span>
                <input class="input mono" name="price" inputmode="decimal" required placeholder={price ?? ''} />
                <span class="field-hint">小数 8 桁まで。締め切りまで、ほかの人の予想は見えません。</span>
              </label>
              <StakeField />
              <button class="btn" type="submit">
                予想を出す
              </button>
            </form>
          ) : (
            <p class="field-hint" style="margin:0">
              この回は <span class="mono">{myNext.pick}</span> と予想して{' '}
              {formatAmount(BigInt(myNext.stake))} BOAG 賭けています。
            </p>
          )}
        </section>

        <h2>
          進行中の回 {clock(current + GAME_ROUND_MS)} の値段
        </h2>
        {currentView === undefined || currentView.entries.length === 0 ? (
          <p class="field-hint">この回に予想はありません。</p>
        ) : (
          <section class="panel">
            <p class="field-hint" style="margin:0 0 8px">締め切ったので、みんなの予想を出します。</p>
            <div class="scroll">
              <table>
                <tr>
                  <th>予想</th>
                  <th>賭け金</th>
                </tr>
                {[...currentView.entries]
                  .sort((a, b) => Number(a.pick) - Number(b.pick))
                  .map((entry) => (
                    <tr>
                      <td class="mono">
                        {entry.pick}
                        {entry.memberId === viewer.member.id ? ' (あなた)' : ''}
                      </td>
                      <td class="mono">{formatAmount(BigInt(entry.stake))}</td>
                    </tr>
                  ))}
              </table>
            </div>
          </section>
        )}

        <h2>これまでの回</h2>
        <section class="panel">
          {history.length === 0 ? (
            <span class="muted">まだ決着した回はありません。</span>
          ) : (
            <div class="scroll">
              <table>
                <tr>
                  <th>時刻</th>
                  <th>答え</th>
                  <th>いちばん近い予想</th>
                  <th>人数 / 合計</th>
                  <th>あなた</th>
                </tr>
                {history.map((view) => {
                  const result = resultOf(view.round);
                  const top = view.entries.filter(
                    (entry) => entry.payout !== null && BigInt(entry.payout) > BigInt(entry.stake),
                  );
                  return (
                    <tr>
                      <td>{clock(view.round.endsAt)}</td>
                      <td class="mono">{view.round.status === 'refunded' ? '返金' : (result.close ?? '-')}</td>
                      <td class="mono">{top.length === 0 ? '-' : top.map((entry) => entry.pick).join(', ')}</td>
                      <td class="mono">
                        {view.entries.length} / {formatAmount(view.total)}
                      </td>
                      <td class="mono">
                        <Outcome entry={mine(view, viewer.member.id)} />
                      </td>
                    </tr>
                  );
                })}
              </table>
            </div>
          )}
        </section>

        <Rules>
          <li>回は取引所 (Binance) の 1 時間足 1 本です。その足の終値を当てます。</li>
          <li>足が始まる 10 秒前に締め切ります。1 回に 1 人 1 つで、後から変えられません。</li>
          <li>
            いちばん近かった人が、ほかの人の賭け金を取ります。ただし 1 人から取れるのは、自分の賭け金と同じ額までです。取りきれなかった分は本人に返します。
          </li>
          <li>いちばん近い人が複数いれば、賭け金に比例して分けます。</li>
          <li>参加が 1 人だけの回と、全員が同じだけ近かった回は、全員に返します。</li>
          <li>値段が 30 分取れなかった回は、全員に返します。胴元は取りません。</li>
        </Rules>
      </Layout>,
      error === undefined ? 200 : 400,
    );
  }

  app.get('/predict/closest', (c) => renderClosest(c));

  app.post('/predict/closest/enter', async (c) => {
    const viewer = c.get('viewer');
    if (viewer === undefined) return c.redirect('/login');

    const form = await c.req.formData();
    const symbol = field(form, 'symbol').toUpperCase();
    const result = enterClosest(deps.db, {
      memberId: viewer.member.id,
      symbol,
      symbols,
      price: field(form, 'price'),
      amount: field(form, 'amount'),
      startsAt: Number(field(form, 'startsAt')),
    });
    if (!result.ok) return renderClosest(c, result.reason, symbol);
    return c.redirect(`/predict/closest?symbol=${encodeURIComponent(symbol)}&done=entered`);
  });

  // --- 順位予想 -----------------------------------------------------------

  async function renderRanking(c: Context<AppBindings>, error?: string) {
    const viewer = c.get('viewer');
    if (viewer === undefined) return c.redirect('/login');
    if (rankingSymbols.length < 2) {
      return disabled(c, '順位予想', 'ranking', '順位予想は止めてあります (RANKING_SYMBOLS)。');
    }

    const now = Date.now();
    const next = gameBettableStart(now);
    const current = next - GAME_ROUND_MS;
    const nextView = gameRoundView(deps.db, gameRoundId('ranking', '', next));
    const currentView = gameRoundView(deps.db, gameRoundId('ranking', '', current));
    const history = recentGameRounds(deps.db, 'ranking', undefined, 20).filter(
      (view) => view.round.status !== 'open',
    );
    // 回がもう作られていれば、その回の銘柄で見せる。設定を途中で変えた場合に食い違わないように。
    const nextSymbols = nextView === undefined ? rankingSymbols : rankingSymbolsOf(nextView.round);
    const pools = poolsByPick(nextView);
    const myNext = mine(nextView, viewer.member.id);
    const myCurrent = mine(currentView, viewer.member.id);
    const prices = await Promise.all(nextSymbols.map((symbol) => priceOf(symbol)));

    return c.html(
      <Layout title="順位予想" viewer={viewer.member.displayName} script={COUNTDOWN_SCRIPT}>
        <h1>順位予想</h1>
        <GameTabs current="ranking" />
        <p class="lede">
          次の 1 時間でいちばん伸びる銘柄を当てます。当てた人で、外した人の賭け金を分けます。残高は{' '}
          {formatAmount(balanceOf(deps.db, viewer.member.id))} BOAG です。
        </p>

        {error === undefined ? null : <Notice tone="bad">{error}</Notice>}
        {c.req.query('done') === 'entered' ? <Notice tone="ok">賭けました。</Notice> : null}

        <h2>
          次の回 {clock(next)} から {clock(next + GAME_ROUND_MS)} まで
        </h2>
        <Deadline startsAt={next} />

        <section class="panel">
          {myNext === undefined ? null : (
            <p class="field-hint" style="margin:0 0 12px">
              この回は {myNext.pick} に {formatAmount(BigInt(myNext.stake))} BOAG 賭けています。
            </p>
          )}
          <form class="stack" method="post" action="/predict/ranking/enter" style="max-width:none">
            <input type="hidden" name="startsAt" value={String(next)} />
            <div class="scroll">
              <table>
                <tr>
                  <th>銘柄</th>
                  <th>いまの値段</th>
                  <th>賭け金の合計</th>
                  <th>当たれば 1 BOAG が</th>
                  <th />
                </tr>
                {nextSymbols.map((symbol, index) => {
                  const pool = pools.get(symbol) ?? 0n;
                  return (
                    <tr>
                      <td>{symbol}</td>
                      <td class="mono">{prices[index] ?? '-'}</td>
                      <td class="mono">{formatAmount(pool)}</td>
                      <td class="mono">{multiplier(pool, nextView?.total ?? 0n) ?? '-'}</td>
                      <td>
                        {myNext === undefined ? (
                          <button class="btn quiet" type="submit" name="pick" value={symbol}>
                            これに賭ける
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </table>
            </div>
            {myNext === undefined ? <StakeField /> : null}
          </form>
        </section>

        <h2>
          進行中の回 {clock(current)} から {clock(next)} まで
        </h2>
        <p class="field-hint">
          {currentView === undefined
            ? 'この回に賭けはありません。'
            : `${String(currentView.entries.length)} 人、合計 ${formatAmount(currentView.total)} BOAG。`}
          {myCurrent === undefined ? '' : ` あなたは ${myCurrent.pick} に賭けています。`}
        </p>

        <h2>これまでの回</h2>
        <section class="panel">
          {history.length === 0 ? (
            <span class="muted">まだ決着した回はありません。</span>
          ) : (
            <div class="scroll">
              <table>
                <tr>
                  <th>回</th>
                  <th>いちばん伸びた</th>
                  <th>各銘柄の伸び</th>
                  <th>人数 / 合計</th>
                  <th>あなた</th>
                </tr>
                {history.map((view) => {
                  const result = resultOf(view.round);
                  const entry = mine(view, viewer.member.id);
                  return (
                    <tr>
                      <td>{clock(view.round.startsAt)}</td>
                      <td>{view.round.status === 'refunded' ? '返金' : (result.winners ?? []).join(', ')}</td>
                      <td class="mono">
                        {(result.candles ?? [])
                          .map((candle) => `${candle.symbol} ${formatChange(candle.open, candle.close)}`)
                          .join(' / ')}
                      </td>
                      <td class="mono">
                        {view.entries.length} / {formatAmount(view.total)}
                      </td>
                      <td class="mono">
                        {entry === undefined ? '-' : `${entry.pick} `}
                        <Outcome entry={entry} />
                      </td>
                    </tr>
                  );
                })}
              </table>
            </div>
          )}
        </section>

        <Rules>
          <li>回は取引所 (Binance) の 1 時間足 1 本です。足が始まる 10 秒前に締め切ります。</li>
          <li>伸びは、その足の終値を始値で割ったものです。下げ相場なら、いちばん下げの小さい銘柄が勝ちです。</li>
          <li>当てた人で、外した人の賭け金を賭け金に比例して分けます。胴元は取りません。</li>
          <li>伸びが同じ銘柄が並んだら、どれに賭けていても当たりです。</li>
          <li>当てた人がいないか、全員が当てた回は、全員に返します。</li>
          <li>1 回に 1 人 1 つです。値段が 30 分取れなかった回は、全員に返します。</li>
        </Rules>
      </Layout>,
      error === undefined ? 200 : 400,
    );
  }

  app.get('/predict/ranking', (c) => renderRanking(c));

  app.post('/predict/ranking/enter', async (c) => {
    const viewer = c.get('viewer');
    if (viewer === undefined) return c.redirect('/login');

    const form = await c.req.formData();
    const result = enterRanking(deps.db, {
      memberId: viewer.member.id,
      symbols: rankingSymbols,
      pick: field(form, 'pick').toUpperCase(),
      amount: field(form, 'amount'),
      startsAt: Number(field(form, 'startsAt')),
    });
    if (!result.ok) return renderRanking(c, result.reason);
    return c.redirect('/predict/ranking?done=entered');
  });

  // --- 値幅予想 -----------------------------------------------------------

  async function renderVolatility(c: Context<AppBindings>, error?: string, chosen?: string) {
    const viewer = c.get('viewer');
    if (viewer === undefined) return c.redirect('/login');

    const wanted = (chosen ?? c.req.query('symbol') ?? '').toUpperCase();
    const symbol = symbols.includes(wanted) ? wanted : symbols[0];
    if (symbol === undefined) {
      return disabled(c, '値幅予想', 'volatility', '予想は止めてあります (PREDICTION_SYMBOLS=none)。');
    }

    const now = Date.now();
    const next = gameBettableStart(now);
    const current = next - GAME_ROUND_MS;
    const nextView = gameRoundView(deps.db, gameRoundId('volatility', symbol, next));
    const currentView = gameRoundView(deps.db, gameRoundId('volatility', symbol, current));
    const history = recentGameRounds(deps.db, 'volatility', symbol, 20).filter(
      (view) => view.round.status !== 'open',
    );
    const pools = poolsByPick(nextView);
    const myNext = mine(nextView, viewer.member.id);
    const myCurrent = mine(currentView, viewer.member.id);
    const price = await priceOf(symbol);

    return c.html(
      <Layout title="値幅予想" viewer={viewer.member.displayName} script={COUNTDOWN_SCRIPT}>
        <h1>値幅予想</h1>
        <GameTabs current="volatility" />
        <p class="lede">
          次の 1 時間でどれだけ荒れるかを当てます。上がるか下がるかは問いません。残高は{' '}
          {formatAmount(balanceOf(deps.db, viewer.member.id))} BOAG です。
        </p>

        <p class="row">
          {symbols.map((item) => (
            <a class={`tag ${item === symbol ? 'accent' : ''}`} href={`/predict/volatility?symbol=${item}`}>
              {item}
            </a>
          ))}
        </p>

        {error === undefined ? null : <Notice tone="bad">{error}</Notice>}
        {c.req.query('done') === 'entered' ? <Notice tone="ok">賭けました。</Notice> : null}

        <section class="panel">
          <div class="row" style="justify-content:space-between">
            <strong>いまの値段</strong>
            <span class="big mono">{price ?? '取れません'}</span>
          </div>
        </section>

        <h2>
          次の回 {clock(next)} から {clock(next + GAME_ROUND_MS)} まで
        </h2>
        <Deadline startsAt={next} />

        <section class="panel">
          {myNext === undefined ? null : (
            <p class="field-hint" style="margin:0 0 12px">
              この回は「{bandLabel(myNext.pick)}」に {formatAmount(BigInt(myNext.stake))} BOAG 賭けています。
            </p>
          )}
          <form class="stack" method="post" action="/predict/volatility/enter" style="max-width:none">
            <input type="hidden" name="symbol" value={symbol} />
            <input type="hidden" name="startsAt" value={String(next)} />
            <div class="scroll">
              <table>
                <tr>
                  <th>値幅 (高値 - 安値) / 始値</th>
                  <th>賭け金の合計</th>
                  <th>当たれば 1 BOAG が</th>
                  <th />
                </tr>
                {VOLATILITY_BANDS.map((band) => {
                  const pool = pools.get(band.key) ?? 0n;
                  return (
                    <tr>
                      <td>{band.label}</td>
                      <td class="mono">{formatAmount(pool)}</td>
                      <td class="mono">{multiplier(pool, nextView?.total ?? 0n) ?? '-'}</td>
                      <td>
                        {myNext === undefined ? (
                          <button class="btn quiet" type="submit" name="band" value={band.key}>
                            これに賭ける
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </table>
            </div>
            {myNext === undefined ? <StakeField /> : null}
          </form>
        </section>

        <h2>
          進行中の回 {clock(current)} から {clock(next)} まで
        </h2>
        <p class="field-hint">
          {currentView === undefined
            ? 'この回に賭けはありません。'
            : `${String(currentView.entries.length)} 人、合計 ${formatAmount(currentView.total)} BOAG。`}
          {myCurrent === undefined ? '' : ` あなたは「${bandLabel(myCurrent.pick)}」に賭けています。`}
        </p>

        <h2>これまでの回</h2>
        <section class="panel">
          {history.length === 0 ? (
            <span class="muted">まだ決着した回はありません。</span>
          ) : (
            <div class="scroll">
              <table>
                <tr>
                  <th>回</th>
                  <th>高値 / 安値</th>
                  <th>値幅</th>
                  <th>当たりの帯</th>
                  <th>人数 / 合計</th>
                  <th>あなた</th>
                </tr>
                {history.map((view) => {
                  const result = resultOf(view.round);
                  const entry = mine(view, viewer.member.id);
                  const candle =
                    result.open === undefined || result.high === undefined || result.low === undefined
                      ? undefined
                      : { open: result.open, high: result.high, low: result.low };
                  return (
                    <tr>
                      <td>{clock(view.round.startsAt)}</td>
                      <td class="mono">{candle === undefined ? '-' : `${candle.high} / ${candle.low}`}</td>
                      <td class="mono">{candle === undefined ? '-' : formatRange(candle)}</td>
                      <td>
                        {view.round.status === 'refunded'
                          ? '返金'
                          : result.band === undefined
                            ? '-'
                            : bandLabel(result.band)}
                      </td>
                      <td class="mono">
                        {view.entries.length} / {formatAmount(view.total)}
                      </td>
                      <td class="mono">
                        {entry === undefined ? '-' : `${bandLabel(entry.pick)} `}
                        <Outcome entry={entry} />
                      </td>
                    </tr>
                  );
                })}
              </table>
            </div>
          )}
        </section>

        <Rules>
          <li>回は取引所 (Binance) の 1 時間足 1 本です。足が始まる 10 秒前に締め切ります。</li>
          <li>値幅は、その足の (高値 - 安値) / 始値 です。境目ちょうどは上の帯に入ります。</li>
          <li>当てた人で、外した人の賭け金を賭け金に比例して分けます。胴元は取りません。</li>
          <li>当てた人がいないか、全員が当てた回は、全員に返します。</li>
          <li>1 回に 1 人 1 つです。値段が 30 分取れなかった回は、全員に返します。</li>
        </Rules>
      </Layout>,
      error === undefined ? 200 : 400,
    );
  }

  app.get('/predict/volatility', (c) => renderVolatility(c));

  app.post('/predict/volatility/enter', async (c) => {
    const viewer = c.get('viewer');
    if (viewer === undefined) return c.redirect('/login');

    const form = await c.req.formData();
    const symbol = field(form, 'symbol').toUpperCase();
    const result = enterVolatility(deps.db, {
      memberId: viewer.member.id,
      symbol,
      symbols,
      band: field(form, 'band'),
      amount: field(form, 'amount'),
      startsAt: Number(field(form, 'startsAt')),
    });
    if (!result.ok) return renderVolatility(c, result.reason, symbol);
    return c.redirect(`/predict/volatility?symbol=${encodeURIComponent(symbol)}&done=entered`);
  });

  return app;
}
