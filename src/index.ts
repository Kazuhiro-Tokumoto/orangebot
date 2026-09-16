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

  const fetch = createApp({ db: database.db, env, notify, rpc }).fetch;
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
      for (const view of settled) notify.announce(view);
      if (settled.length > 0 || purged > 0) {
        logger.debug(`掃除: 提案 ${String(settled.length)} 件、セッション ${String(purged)} 件`);
      }
    } catch (error: unknown) {
      logger.error('定期処理に失敗しました', error);
    }
  }, SWEEP_INTERVAL_MS);
  sweep.unref();

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    logger.info(`${signal} を受信したので終了します`);
    clearInterval(sweep);
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
