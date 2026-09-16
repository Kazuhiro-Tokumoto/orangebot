import { readFileSync } from 'node:fs';
import type { OagConfig } from '../env.js';

/**
 * oag-node への JSON-RPC。
 *
 * ノードはループバックにしか口を開けず、合言葉は起動のたびに作り直されて
 * `.cookie` に置かれる（SPEC §15.1）。だから TLS も長期の秘密も無い。
 * こちらは毎回そのファイルを読んでから繋ぐ。ノードが再起動しても追随できる。
 *
 * 金額は u128 で、JSON の数値では表しきれないので 10 進文字列で来る。
 * 途中で number にすると静かに丸まるため、この層で BigInt に直す。
 */

/** 待たされ続けないための上限。scanutxos は総なめなので長めに取る。 */
export const DEFAULT_TIMEOUT_MS = 30_000;

export class RpcError extends Error {
  readonly code: number | undefined;

  constructor(message: string, code?: number) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
  }
}

/** `.cookie` の中身。Bitcoin と同じく `利用者:合言葉` の 1 行。 */
export function readCookie(path: string): string {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8').trim();
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new RpcError(
      `合言葉を読めません: ${path}\n` +
        'ノードが動いているか、そのファイルを読む権限があるかを確かめてください。' +
        `（${reason}）`,
    );
  }

  if (raw === '') throw new RpcError(`合言葉が空です: ${path}`);
  // 利用者名が省かれている実装に備えて、区切りが無ければ既定の名前を補う。
  return raw.includes(':') ? raw : `__cookie__:${raw}`;
}

export interface NodeInfo {
  readonly network: string;
  readonly height: number;
  readonly bestHash: string;
  /** 次の難易度。累積仕事量と同じく 10 進文字列で来る。 */
  readonly difficulty: string;
}

export interface Utxo {
  readonly txid: string;
  readonly vout: number;
  readonly address: string;
  readonly amount: bigint;
  readonly height: number | undefined;
}

export interface ScanResult {
  readonly utxos: readonly Utxo[];
  readonly total: bigint;
  /**
   * ノード側で打ち切られたかどうか。
   * true のときの合計は下限でしかないので、残高として出してはいけない（SPEC §15）。
   */
  readonly truncated: boolean;
}

export interface RpcClient {
  call<T>(method: string, params?: readonly unknown[]): Promise<T>;
  getInfo(): Promise<NodeInfo>;
  getBlockCount(): Promise<number>;
  scanUtxos(addresses: readonly string[]): Promise<ScanResult>;
  sendRawTransaction(hex: string): Promise<string>;
}

export interface RpcOptions {
  readonly timeoutMs?: number;
  /** 試験で差し替えるための入口。既定は global の fetch。 */
  readonly fetch?: typeof globalThis.fetch;
  /** 試験で差し替えるための入口。既定はファイルから読む。 */
  readonly readCookie?: (path: string) => string;
}

// --- 応答の読み取り -------------------------------------------------------
//
// ノードの版が上がって項目が増えても壊れないよう、要る所だけを取り出す。
// 無い、または形が違う場合はその場で RpcError にする。黙って 0 として扱うと、
// 残高を実際より少なく見せてしまうため。

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RpcError(`${what} の形が違います`);
  }
  return value as Record<string, unknown>;
}

function pickString(source: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function pickNumber(source: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

/** 10 進文字列を整数にする。number で来た場合も、桁が安全な範囲なら受ける。 */
export function parseAtomic(value: unknown, what: string): bigint {
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return BigInt(value.trim());
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  throw new RpcError(`${what} を金額として読めません`);
}

function parseUtxo(value: unknown): Utxo {
  const row = asRecord(value, 'UTXO');
  const txid = pickString(row, ['txid', 'tx_id', 'hash']);
  const address = pickString(row, ['address', 'addr', 'script_address']);
  const vout = pickNumber(row, ['vout', 'index', 'n', 'output_index']);

  if (txid === undefined || address === undefined || vout === undefined) {
    throw new RpcError('UTXO に txid か address か vout がありません');
  }

  return {
    txid,
    vout,
    address,
    amount: parseAtomic(row['amount'] ?? row['value'], 'UTXO の金額'),
    height: pickNumber(row, ['height', 'block_height']),
  };
}

export function parseScanResult(value: unknown): ScanResult {
  const body = asRecord(value, 'scanutxos の応答');
  const list = body['utxos'] ?? body['unspents'] ?? body['result'];
  if (!Array.isArray(list)) throw new RpcError('scanutxos の応答に UTXO の一覧がありません');

  const utxos = list.map(parseUtxo);
  const stated = body['total'] ?? body['total_amount'] ?? body['amount'];
  const total =
    stated === undefined
      ? utxos.reduce((sum, utxo) => sum + utxo.amount, 0n)
      : parseAtomic(stated, 'scanutxos の合計');

  return { utxos, total, truncated: body['truncated'] === true };
}

function parseInfo(value: unknown): NodeInfo {
  const body = asRecord(value, 'getinfo の応答');
  const height = pickNumber(body, ['height', 'blocks', 'blockcount']);
  if (height === undefined) throw new RpcError('getinfo の応答に高さがありません');

  return {
    network: pickString(body, ['network', 'chain']) ?? 'unknown',
    height,
    bestHash: pickString(body, ['bestblockhash', 'best_hash', 'tip', 'besthash']) ?? '',
    difficulty: pickString(body, ['difficulty', 'next_difficulty']) ?? '',
  };
}

export function createRpcClient(config: OagConfig, options: RpcOptions = {}): RpcClient {
  const doFetch = options.fetch ?? globalThis.fetch;
  const loadCookie = options.readCookie ?? readCookie;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let nextId = 0;

  async function call<T>(method: string, params: readonly unknown[] = []): Promise<T> {
    // 合言葉は起動のたびに変わるので、繋ぐ直前に読む。
    const credential = loadCookie(config.cookiePath);
    nextId += 1;

    let response: Response;
    try {
      response = await doFetch(config.rpcUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Basic ${Buffer.from(credential, 'utf8').toString('base64')}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new RpcError(`ノードに繋がりません（${config.rpcUrl}）: ${reason}`);
    }

    if (response.status === 401 || response.status === 403) {
      throw new RpcError('合言葉が合いません。ノードを再起動した直後かもしれません');
    }
    if (!response.ok) {
      throw new RpcError(`ノードが ${String(response.status)} を返しました`);
    }

    const body: unknown = await response.json().catch(() => undefined);
    const envelope = asRecord(body, 'ノードの応答');

    const failure = envelope['error'];
    if (failure !== null && failure !== undefined) {
      const detail = asRecord(failure, 'ノードの誤り');
      const message = pickString(detail, ['message']) ?? JSON.stringify(failure);
      throw new RpcError(`${method}: ${message}`, pickNumber(detail, ['code']));
    }

    return envelope['result'] as T;
  }

  return {
    call,

    async getInfo() {
      return parseInfo(await call('getinfo'));
    },

    async getBlockCount() {
      const value = await call<unknown>('getblockcount');
      if (typeof value !== 'number') throw new RpcError('getblockcount が数を返しませんでした');
      return value;
    },

    async scanUtxos(addresses) {
      if (addresses.length === 0) return { utxos: [], total: 0n, truncated: false };
      return parseScanResult(await call('scanutxos', [[...addresses]]));
    },

    async sendRawTransaction(hex) {
      const value = await call<unknown>('sendrawtransaction', [hex]);
      if (typeof value !== 'string') throw new RpcError('sendrawtransaction が txid を返しません');
      return value;
    },
  };
}
