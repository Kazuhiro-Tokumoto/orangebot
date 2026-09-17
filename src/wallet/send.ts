import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { appendAudit } from '../db/audit.js';
import type { Db } from '../db/client.js';
import { oagSends, proposals, type OagSendRow } from '../db/schema.js';
import type { WalletSendPayload } from '../domain/proposals.js';
import { decodeAddress } from './address.js';
import { RpcError, type RpcClient } from './rpc.js';
import { CHANGE_INTERNAL } from './seed.js';
import {
  addressesOf,
  getWallet,
  issueChangeAddress,
  unlockWallet,
  watchedEntries,
} from './store.js';
import {
  MIN_RELAY_FEE_RATE,
  TxError,
  buildPayment,
  encodeTransaction,
  fromHex,
  signDraft,
  toHex,
  txid,
  verifySigned,
  type Coin,
  type Lock,
} from './tx.js';

/**
 * OAG を送る。
 *
 * 送れるのは、過半数で可決した wallet.send の提案だけ。可決は「送ってよい」という
 * 許可で、実際に送るのはパスフレーズを知っているメンバーが画面から押したとき。
 *
 * 守っていること。
 *   1. 提案 1 件につき署名する取引は 1 つ。送り直しは同じバイト列を投げる。
 *      作り直すと入力の選び方が変わり、別の取引として二重に払いうる。
 *   2. 送る前に、署名済みの取引を DB に書く。送った直後に落ちても何を送ったか残る。
 *   3. mempool にまだある自分の取引の入力は、次の送金で使わない。
 *      同じ入力を使うと手数料の高い方が前の取引を追い出し (RBF)、先の支払いが消える。
 *   4. 同時に 2 件組み立てない。このプロセスの中で 1 件ずつ順番に処理する。
 *   5. 送る前に全ての署名と手数料をもう一度検証する。
 */

export type SendFailure = { readonly ok: false; readonly reason: string };
export type SendResult =
  | { readonly ok: true; readonly send: OagSendRow; readonly rebroadcast: boolean }
  | SendFailure;

/** ノードが「受け付けない」と答えたときの JSON-RPC の番号の範囲。届いたか分からない場合と分ける。 */
function isDefinitiveRejection(error: unknown): boolean {
  return error instanceof RpcError && error.code !== undefined;
}

// 1 件ずつ処理するための鎖。直前の送金が終わってから次を始める。
let queue: Promise<unknown> = Promise.resolve();

function serialized<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work);
  queue = run.catch(() => undefined);
  return run;
}

export function getSendForProposal(db: Db, proposalId: string): OagSendRow | undefined {
  return db.select().from(oagSends).where(eq(oagSends.proposalId, proposalId)).get();
}

export function listSends(db: Db, limit = 50): OagSendRow[] {
  return db.select().from(oagSends).orderBy(desc(oagSends.createdAt)).limit(limit).all();
}

function outPointKey(txidHex: string, index: number): string {
  return `${txidHex}:${String(index)}`;
}

function parseInputs(row: OagSendRow): string[] {
  const value: unknown = JSON.parse(row.inputs);
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * まだ確定していない自分の取引が使っている入力。
 * mempool に残っているものだけを数える。消えたものは、確定したか捨てられたかのどちらかで、
 * どちらにしても scanutxos の結果がそのまま正しい。
 */
function pendingInputs(db: Db, mempool: ReadonlySet<string>): Set<string> {
  const locked = new Set<string>();
  const rows = db.select().from(oagSends).all();
  for (const row of rows) {
    if (row.status === 'failed') continue;
    if (!mempool.has(row.txid)) continue;
    for (const key of parseInputs(row)) locked.add(key);
  }
  return locked;
}

function loadApprovedPayload(db: Db, proposalId: string): WalletSendPayload | SendFailure {
  const row = db.select().from(proposals).where(eq(proposals.id, proposalId)).get();
  if (row === undefined || row.type !== 'wallet.send') {
    return { ok: false, reason: 'その送金の提案はありません' };
  }
  if (row.status !== 'executed') {
    return { ok: false, reason: 'この送金はまだ可決していません' };
  }

  const payload: unknown = JSON.parse(row.payload);
  if (typeof payload !== 'object' || payload === null) {
    return { ok: false, reason: '提案の中身が壊れています' };
  }
  const record = payload as Record<string, unknown>;
  const to = record['to'];
  const amount = record['amount'];
  if (typeof to !== 'string' || typeof amount !== 'string' || !/^\d+$/.test(amount)) {
    return { ok: false, reason: '提案の中身が壊れています' };
  }
  return { to, amount, memo: typeof record['memo'] === 'string' ? record['memo'] : '' };
}

/** 送り直す。署名済みのバイト列をそのまま投げるので、別の取引は生まれない。 */
async function rebroadcast(db: Db, rpc: RpcClient, row: OagSendRow, now: number): Promise<SendResult> {
  try {
    const accepted = await rpc.sendRawTransaction(row.rawHex);
    if (accepted !== row.txid) {
      return { ok: false, reason: `ノードが別の txid を返しました (${accepted})` };
    }
    db.update(oagSends)
      .set({ status: 'broadcast', broadcastAt: now, error: null })
      .where(eq(oagSends.id, row.id))
      .run();
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    // 既に mempool かブロックにあるなら、同じ取引が断られるのは正常。
    const mempool = new Set(await rpc.getMempool().catch(() => []));
    if (mempool.has(row.txid)) {
      db.update(oagSends)
        .set({ status: 'broadcast', broadcastAt: row.broadcastAt ?? now, error: null })
        .where(eq(oagSends.id, row.id))
        .run();
    } else {
      db.update(oagSends).set({ error: reason }).where(eq(oagSends.id, row.id)).run();
      return { ok: false, reason };
    }
  }

  const updated = getSendForProposal(db, row.proposalId);
  return updated === undefined
    ? { ok: false, reason: '送金の記録が消えました' }
    : { ok: true, send: updated, rebroadcast: true };
}

export function executeSend(
  db: Db,
  rpc: RpcClient | undefined,
  input: {
    readonly proposalId: string;
    readonly passphrase: string;
    readonly actorMemberId: string;
    readonly now?: number;
  },
): Promise<SendResult> {
  return serialized(() => executeSendNow(db, rpc, input));
}

async function executeSendNow(
  db: Db,
  rpc: RpcClient | undefined,
  input: {
    readonly proposalId: string;
    readonly passphrase: string;
    readonly actorMemberId: string;
    readonly now?: number;
  },
): Promise<SendResult> {
  const now = input.now ?? Date.now();
  if (rpc === undefined) return { ok: false, reason: 'OAG ノードの設定がありません' };

  const payload = loadApprovedPayload(db, input.proposalId);
  if ('ok' in payload) return payload;

  // 既に署名した取引があれば、組み立て直さずにそれを送る。
  const existing = getSendForProposal(db, input.proposalId);
  if (existing !== undefined && existing.status !== 'failed') {
    if (existing.status === 'broadcast') {
      return { ok: true, send: existing, rebroadcast: false };
    }
    return rebroadcast(db, rpc, existing, now);
  }

  const wallet = getWallet(db);
  if (wallet === undefined) return { ok: false, reason: 'ウォレットがまだありません' };

  // パスフレーズは先に確かめる。ノードへの問い合わせより安く、間違いに早く気付ける。
  const unlocked = await unlockWallet(db, input.passphrase);
  if (!unlocked.ok) return unlocked;

  let destination: Lock;
  try {
    const decoded = decodeAddress(wallet.network, payload.to);
    destination = { version: decoded.version, payload: decoded.payload };
  } catch (error: unknown) {
    return { ok: false, reason: error instanceof Error ? error.message : '宛先が読めません' };
  }

  // ノードから手持ちを引く。
  const entries = watchedEntries(wallet);
  const byAddress = new Map(entries.map((entry) => [entry.address, entry]));

  let height: number;
  let mempool: Set<string>;
  let utxos;
  try {
    height = (await rpc.getInfo()).height;
    mempool = new Set(await rpc.getMempool());
    const scan = await rpc.scanUtxos(entries.map((entry) => entry.address));
    if (scan.truncated) {
      return {
        ok: false,
        reason: 'ノードが手持ちを数え切れませんでした。この状態では安全に組み立てられません',
      };
    }
    utxos = scan.utxos;
  } catch (error: unknown) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }

  const locked = pendingInputs(db, mempool);
  const coins: Coin[] = [];
  const derivationOf = new Map<string, { change: number; index: number }>();
  for (const utxo of utxos) {
    const entry = byAddress.get(utxo.address);
    if (entry === undefined) continue;
    if (locked.has(outPointKey(utxo.txid, utxo.vout))) continue;

    let lockPayload: Uint8Array;
    try {
      lockPayload = decodeAddress(wallet.network, utxo.address).payload;
    } catch {
      continue;
    }
    const lock: Lock = { version: 0, payload: lockPayload };
    derivationOf.set(toHex(lockPayload), { change: entry.change, index: entry.index });
    coins.push({
      outPoint: { txid: fromHex(utxo.txid, 'txid'), index: utxo.vout },
      output: { amount: utxo.amount, lock },
      height: BigInt(utxo.height ?? height),
      isCoinbase: utxo.coinbase,
    });
  }

  // お釣りは新しい住所へ。番号を進めるのは署名まで通ってからにする。
  const [changeEntry] = addressesOf(wallet, {
    change: CHANGE_INTERNAL,
    from: wallet.nextChange,
    count: 1,
  });
  if (changeEntry === undefined) return { ok: false, reason: 'お釣りの住所を作れません' };
  const changeLock: Lock = {
    version: 0,
    payload: decodeAddress(wallet.network, changeEntry.address).payload,
  };

  let signedHex: string;
  let signedTxid: string;
  let draft;
  try {
    draft = buildPayment(coins, {
      to: destination,
      amount: BigInt(payload.amount),
      changeTo: changeLock,
      nextHeight: BigInt(height) + 1n,
      feeRate: MIN_RELAY_FEE_RATE,
    });
    const signed = signDraft(draft, (lock) => {
      const path = derivationOf.get(toHex(lock.payload));
      return path === undefined ? undefined : unlocked.privateKeyAt(path);
    });
    verifySigned(signed, draft.spent);
    signedHex = toHex(encodeTransaction(signed));
    signedTxid = txid(signed);
  } catch (error: unknown) {
    const reason = error instanceof TxError ? error.message : String(error);
    return { ok: false, reason };
  }

  // 送る前に書く。ここから先で落ちても、何を送ろうとしたかが残る。
  const record: OagSendRow = {
    id: existing?.id ?? randomUUID(),
    proposalId: input.proposalId,
    status: 'signed',
    txid: signedTxid,
    rawHex: signedHex,
    inputs: JSON.stringify(
      draft.coins.map((coin) => outPointKey(toHex(coin.outPoint.txid), coin.outPoint.index)),
    ),
    toAddress: payload.to,
    amount: payload.amount,
    fee: draft.fee.toString(),
    change: draft.change.toString(),
    createdBy: input.actorMemberId,
    createdAt: now,
    broadcastAt: null,
    error: null,
  };

  db.transaction((tx) => {
    if (existing === undefined) {
      tx.insert(oagSends).values(record).run();
    } else {
      tx.update(oagSends).set(record).where(eq(oagSends.id, existing.id)).run();
    }
    if (draft.change > 0n) {
      const issued = issueChangeAddress(tx);
      if ('ok' in issued) throw new Error(issued.reason);
    }
    appendAudit(tx, {
      at: now,
      actorMemberId: input.actorMemberId,
      action: 'wallet.send_signed',
      detail: {
        proposalId: input.proposalId,
        txid: signedTxid,
        to: payload.to,
        amount: payload.amount,
        fee: draft.fee.toString(),
      },
    });
  });

  try {
    const accepted = await rpc.sendRawTransaction(signedHex);
    if (accepted !== signedTxid) throw new RpcError(`ノードが別の txid を返しました (${accepted})`);
    db.update(oagSends)
      .set({ status: 'broadcast', broadcastAt: now })
      .where(eq(oagSends.id, record.id))
      .run();
    appendAudit(db, {
      at: now,
      actorMemberId: input.actorMemberId,
      action: 'wallet.send_broadcast',
      detail: { proposalId: input.proposalId, txid: signedTxid },
    });
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    // ノードがはっきり断ったなら、この取引はもう使えない。作り直してよい。
    // 繋がらなかっただけなら届いているかもしれないので、作り直さず送り直しを待つ。
    const status = isDefinitiveRejection(error) ? 'failed' : 'unknown';
    db.update(oagSends).set({ status, error: reason }).where(eq(oagSends.id, record.id)).run();
    return {
      ok: false,
      reason:
        status === 'failed'
          ? `ノードが受け付けませんでした: ${reason}`
          : `送ったかどうか確かめられませんでした。もう一度押すと同じ取引を送り直します: ${reason}`,
    };
  }

  const saved = getSendForProposal(db, input.proposalId);
  return saved === undefined
    ? { ok: false, reason: '送金の記録が消えました' }
    : { ok: true, send: saved, rebroadcast: false };
}
