import type { Db } from '../db/client.js';
import { logger } from '../logger.js';
import type { RpcClient } from './rpc.js';
import { getWallet, watchedAddresses } from './store.js';

/**
 * ノードに当たって今の残高を出す。
 *
 * ここで守ることが 2 つある。
 *   1. scanutxos が打ち切られた応答を残高として出さない。実際より少なく見えるため。
 *   2. ノードが落ちていてもポータルは動き続ける。失敗は値ではなく状態として返す。
 */

export interface WalletStatus {
  /** ウォレットの行があるか。無ければ作るところから。 */
  readonly present: boolean;
  /** ノードに繋がったか。 */
  readonly connected: boolean;
  readonly network: string | undefined;
  readonly height: number | undefined;
  /** 最小単位。打ち切られた場合は undefined にして、数として出させない。 */
  readonly balance: bigint | undefined;
  readonly utxoCount: number | undefined;
  readonly truncated: boolean;
  readonly error: string | undefined;
}

const UNKNOWN: WalletStatus = {
  present: false,
  connected: false,
  network: undefined,
  height: undefined,
  balance: undefined,
  utxoCount: undefined,
  truncated: false,
  error: undefined,
};

export async function readWalletStatus(
  db: Db,
  client: RpcClient | undefined,
): Promise<WalletStatus> {
  const wallet = getWallet(db);
  if (wallet === undefined) return UNKNOWN;
  if (client === undefined) {
    return { ...UNKNOWN, present: true, error: 'OAG ノードの設定がありません' };
  }

  try {
    const info = await client.getInfo();
    const scan = await client.scanUtxos(watchedAddresses(wallet));

    return {
      present: true,
      connected: true,
      network: info.network,
      height: info.height,
      // 打ち切られた合計は下限でしかない。残高として出さない。
      balance: scan.truncated ? undefined : scan.total,
      utxoCount: scan.utxos.length,
      truncated: scan.truncated,
      error: scan.truncated ? 'ノードが数え切れず、途中で打ち切られました' : undefined,
    };
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn(`ウォレットの残高を読めませんでした: ${reason}`);
    return { ...UNKNOWN, present: true, error: reason };
  }
}
