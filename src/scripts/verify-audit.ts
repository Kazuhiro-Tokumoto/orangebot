import { readChain, verifyAuditLog } from '../db/audit.js';
import { openDatabase } from '../db/client.js';
import { loadEnv } from '../env.js';
import { logger } from '../logger.js';

/**
 * 監査ログの連鎖を検証する。
 * 過去の行が書き換えられていれば、それ以降の連鎖が切れるので必ず捕まる。
 */
function main(): void {
  const env = loadEnv();
  const handle = openDatabase({ path: env.databasePath });

  try {
    const rows = readChain(handle.db);
    const result = verifyAuditLog(handle.db);

    if (result.ok) {
      logger.info(`監査ログは健全です（${String(result.length)} 行）`);
      const last = rows.at(-1);
      if (last !== undefined) {
        logger.info(`最後の記録: ${last.action}（${new Date(last.at).toLocaleString('ja-JP')}）`);
      }
      return;
    }

    logger.error(`監査ログが壊れています。seq ${String(result.brokenAt)}: ${result.reason}`);
    process.exitCode = 1;
  } finally {
    handle.close();
  }
}

main();
