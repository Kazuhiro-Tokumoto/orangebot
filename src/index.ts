import type { Client } from 'discord.js';
import { startBot } from './bot.js';
import { loadEnvWithWarnings } from './env.js';
import { logger } from './logger.js';

async function main(): Promise<void> {
  const { env, insecureDefaults } = loadEnvWithWarnings();

  if (insecureDefaults.length > 0) {
    logger.warn(
      `開発用の導出値で埋めた設定があります。本番では必ず指定してください: ${insecureDefaults.join(', ')}`,
    );
  }

  let client: Client | undefined;
  if (env.discord === undefined) {
    logger.info('Discord の設定が無いため、bot は起動しません');
  } else {
    client = await startBot(env.discord);
  }

  const shutdown = (signal: string): void => {
    logger.info(`${signal} を受信したので終了します`);
    const done = client === undefined ? Promise.resolve() : client.destroy();
    void done.finally(() => {
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
