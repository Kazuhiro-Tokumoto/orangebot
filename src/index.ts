import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { serve } from '@hono/node-server';
import type { Client } from 'discord.js';
import { startBot } from './bot.js';
import { createNotifier, discordTransport, nullNotifier } from './bot/notify.js';
import { purgeExpiredSessions } from './auth/session.js';
import { openDatabase } from './db/client.js';
import { settleExpired } from './domain/proposals.js';
import { loadEnvWithWarnings } from './env.js';
import { logger } from './logger.js';
import { readTlsMaterial, watchTlsMaterial } from './tls.js';
import { deliverDueWithdrawals } from './domain/exchange.js';
import { settleDueGames } from './domain/games.js';
import { refundStaleMarkets } from './domain/markets.js';
import { settleDueRounds } from './domain/prediction.js';
import { createPartnerClient } from './exchange/partner.js';
import { createBinanceSource } from './market/price.js';
import { createRpcClient } from './wallet/rpc.js';
import { createApp } from './web/app.js';

/** 期限切れの掃除をまわす間隔。 */
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

async function main(): Promise<void> {
  const { env, insecureDefaults } = loadEnvWithWarnings();

  if (insecureDefaults.length > 0) {
    logger.warn(
      `開発用の導出値で埋めた設定があります。本番では必ず指定してください: ${insecureDefaults.join(', ')}`,
    );
  }

  const database = openDatabase({ path: env.databasePath });
  logger.info(`データベース: ${env.databasePath}`);

  // bot は Web より先に上げる。提案の通知と DM をこの client から出すため。
  let client: Client | undefined;
  let notify = nullNotifier;
  if (env.discord === undefined) {
    logger.info('Discord の設定が無いため、bot は起動しません');
  } else {
    client = await startBot(env.discord);
    notify = createNotifier(discordTransport(client, env.discord.proposalChannelId), env.webOrigin);
    logger.info(
      env.discord.proposalChannelId === undefined
        ? '提案を流すチャンネルが未設定です。DM だけ送ります'
        : `提案を ${env.discord.proposalChannelId} に流します`,
    );
  }

  // ノードは落ちていることもある。繋ぐ口だけ用意して、失敗は画面側で扱う。
  const rpc = env.oag === undefined ? undefined : createRpcClient(env.oag);
  if (env.oag === undefined) {
    logger.info('OAG ノードの設定が無いため、残高は出しません');
  } else {
    logger.info(`OAG ノード: ${env.oag.rpcUrl}（${env.oag.network}）`);
  }

  const prices =
    env.prediction === undefined
      ? undefined
      : createBinanceSource({ baseUrl: env.prediction.priceBaseUrl });
  if (env.prediction === undefined) {
    logger.info('値動きの予想は止めてあります');
  } else {
    logger.info(`値動きの予想: ${env.prediction.symbols.join(', ')}`);
  }

  // pt への交換の出金を相手へ届ける巡回。前の巡回が終わるまで次を始めない。
  const partner =
    env.exchange?.partnerUrl === undefined
      ? undefined
      : createPartnerClient({ url: env.exchange.partnerUrl, secret: env.exchange.secret });
  if (env.exchange === undefined) {
    logger.info('pt の交換は止めてあります');
  } else {
    logger.info(
      partner === undefined
        ? 'pt の交換: 入金だけ受け付けます (EXCHANGE_PARTNER_URL が未設定)'
        : `pt の交換: 入金と出金を受け付けます (相手 ${env.exchange.partnerUrl ?? ''})`,
    );
  }
  let delivering = false;
  const deliver = (): void => {
    if (partner === undefined || delivering) return;
    delivering = true;
    deliverDueWithdrawals(database.db, partner)
      .then((report) => {
        if (report.delivered + report.refunded + report.stuck > 0) {
          logger.info(
            `交換の出金: 届いた ${String(report.delivered)}、返金 ${String(report.refunded)}、止まった ${String(report.stuck)}`,
          );
        }
      })
      .catch((error: unknown) => {
        logger.error('交換の出金に失敗しました', error);
      })
      .finally(() => {
        delivering = false;
      });
  };
  const outbox = setInterval(deliver, 10_000);
  outbox.unref();

  const fetch = createApp({
    db: database.db,
    env,
    notify,
    rpc,
    prices,
    onWithdrawalRequested: deliver,
  }).fetch;
  const announceListening = (port: number): void => {
    logger.info(`Web を ${env.webOrigin} で待ち受ける（ポート ${String(port)}）`);
  };

  // 本番は node 自身が https を終端する。平文で待ち受ける口は開けない。
  let stopWatchingTls: (() => void) | undefined;
  let server;
  if (env.tls === undefined) {
    logger.warn('TLS を設定していないので http で待ち受けます。開発用の設定です');
    server = serve({ fetch, port: env.port }, (info) => {
      announceListening(info.port);
    });
  } else {
    const material = readTlsMaterial(env.tls);
    server = serve(
      {
        fetch,
        port: env.port,
        createServer: createHttpsServer,
        serverOptions: { key: material.key, cert: material.cert },
      },
      (info) => {
        announceListening(info.port);
      },
    );
    logger.info(`証明書: ${env.tls.certPath}`);
    stopWatchingTls = watchTlsMaterial(server as HttpsServer, env.tls, material);
  }

  // 期限切れの提案とセッションを定期的に片付ける。
  const sweep = setInterval(() => {
    try {
      const settled = settleExpired(database.db);
      const purged = purgeExpiredSessions(database.db);
      const staleMarkets = refundStaleMarkets(database.db);
      for (const view of settled) notify.announce(view);
      if (settled.length > 0 || purged > 0 || staleMarkets > 0) {
        logger.debug(
          `掃除: 提案 ${String(settled.length)} 件、セッション ${String(purged)} 件、判定の無い問い ${String(staleMarkets)} 件`,
        );
      }
    } catch (error: unknown) {
      logger.error('定期処理に失敗しました', error);
    }
  }, SWEEP_INTERVAL_MS);
  sweep.unref();

  // 予想の回は 5 分ごと (上下) と 1 時間ごと (終値、順位) に閉じる。
  // 閉じた足を取り寄せて払い戻すのを、短い間隔で回す。
  // 前の回の処理が終わるまで次を始めない。取引所が遅いときに重ならないように。
  let settling = false;
  const settle = setInterval(() => {
    if (prices === undefined || settling) return;
    settling = true;
    Promise.all([settleDueRounds(database.db, prices), settleDueGames(database.db, prices)])
      .then((results) => {
        const settledCount = results.reduce((sum, result) => sum + result.settled, 0);
        const refundedCount = results.reduce((sum, result) => sum + result.refunded, 0);
        if (settledCount > 0 || refundedCount > 0) {
          logger.info(`予想の決着: ${String(settledCount)} 回、返金 ${String(refundedCount)} 回`);
        }
      })
      .catch((error: unknown) => {
        logger.error('予想の決着に失敗しました', error);
      })
      .finally(() => {
        settling = false;
      });
  }, 15_000);
  settle.unref();

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    logger.info(`${signal} を受信したので終了します`);
    clearInterval(sweep);
    clearInterval(settle);
    clearInterval(outbox);
    stopWatchingTls?.();
    server.close();
    const done = client === undefined ? Promise.resolve() : client.destroy();
    void done.finally(() => {
      database.close();
      process.exit(0);
    });
  };

  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
}

main().catch((error: unknown) => {
  logger.error('起動に失敗しました', error);
  process.exitCode = 1;
});
