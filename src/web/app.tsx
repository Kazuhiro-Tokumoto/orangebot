import { Hono } from 'hono';
import { csrf } from 'hono/csrf';
import { readChain, verifyAuditLog } from '../db/audit.js';
import { listAllMembers } from '../db/members.js';
import { formatAmount, totalIssued, verifyLedger } from '../domain/ledger.js';
import { formatOag } from '../wallet/amount.js';
import { readWalletStatus } from '../wallet/balance.js';
import { listProposals, settleExpired } from '../domain/proposals.js';
import { nullNotifier } from '../bot/notify.js';
import {
  sessionMiddleware,
  viewerName,
  type AppBindings,
  type AppDeps,
  type RouteDeps,
} from './context.js';
import { enrollRoutes } from './routes/enroll.js';
import { loginRoutes } from './routes/login.js';
import { proposalRoutes } from './routes/proposals.js';
import { exchangeApiRoutes } from './routes/exchange-api.js';
import { exchangeRoutes } from './routes/exchange.js';
import { gameRoutes } from './routes/games.js';
import { marketRoutes } from './routes/markets.js';
import { predictRoutes } from './routes/predict.js';
import { settingsRoutes } from './routes/settings.js';
import { socialRoutes } from './routes/social.js';
import { walletRoutes } from './routes/wallet.js';
import { Layout } from './views/layout.js';
import { StatusPage, type WalletSummary } from './views/status.js';

export type { AppDeps };

export function createApp(input: AppDeps) {
  // 通知先を省かれた場合はここで受け皿を差す。route 側は常に notify を持てる。
  const deps: RouteDeps = { ...input, notify: input.notify ?? nullNotifier };
  const app = new Hono<AppBindings>();

  // 外部の bot 向けの API は署名で守る。画面のセッションもクッキーも使わないので、
  // CSRF の検査とセッションの読み込みより前に切り分ける。
  app.route('/', exchangeApiRoutes(deps));

  // 素の HTML フォームなので、他所からの POST を Origin で弾く。
  app.use('*', csrf({ origin: deps.env.webOrigin }));
  app.use('*', sessionMiddleware(deps));

  app.get('/', (c) => c.redirect(viewerName(c) === undefined ? '/status' : '/proposals'));
  app.get('/healthz', (c) => c.text('ok'));

  /**
   * 誰でも見られる読み取り専用の状態画面。
   * 操作の入口は一切置かない。見えるだけで何もできないことが、この画面の要件。
   */
  app.get('/status', async (c) => {
    const now = Date.now();
    settleExpired(deps.db, now);

    const ledger = verifyLedger(deps.db);
    const oag = await readWalletStatus(deps.db, deps.rpc);
    const wallet: WalletSummary = {
      issuedBoag: formatAmount(totalIssued(deps.db)),
      ledgerNote: ledger.ok ? '' : '台帳に不整合',
      connected: oag.connected,
      note: oag.present ? (oag.error ?? '') : 'ウォレット未作成',
      balanceOag: oag.balance === undefined ? undefined : formatOag(oag.balance),
      height: oag.height,
    };

    return c.html(
      <Layout title="状態" viewer={viewerName(c)}>
        <StatusPage
          members={listAllMembers(deps.db)}
          proposals={listProposals(deps.db, {}, now)}
          audit={readChain(deps.db)}
          chain={verifyAuditLog(deps.db)}
          wallet={wallet}
          generatedAt={now}
        />
      </Layout>,
    );
  });

  app.route('/', enrollRoutes(deps));
  app.route('/', loginRoutes(deps));
  app.route('/', proposalRoutes(deps));
  app.route('/', settingsRoutes(deps));
  app.route('/', walletRoutes(deps));
  app.route('/', socialRoutes(deps));
  app.route('/', predictRoutes(deps));
  app.route('/', gameRoutes(deps));
  app.route('/', marketRoutes(deps));
  app.route('/', exchangeRoutes(deps));

  app.notFound((c) =>
    c.html(
      <Layout title="見つかりません" viewer={viewerName(c)}>
        <h1>見つかりません</h1>
        <p class="lede">そのページはありません。</p>
      </Layout>,
      404,
    ),
  );

  return app;
}
