import { eq } from 'drizzle-orm';
import { appendAudit } from '../db/audit.js';
import type { Db } from '../db/client.js';
import { wallets, type WalletRow } from '../db/schema.js';
import type { Network } from './address.js';
import {
  CHANGE_INTERNAL,
  CHANGE_RECEIVE,
  GAP_LIMIT,
  addressFromXpub,
  createMnemonic,
  deriveAccountXpub,
  derivePrivateKey,
  mnemonicToSeed,
} from './seed.js';
import { openMnemonic, sealMnemonic, type KdfParams } from './vault.js';

/**
 * 組織のウォレット。ひとつだけ持つ。
 *
 * DB には「口座の拡張公開鍵」と「パスフレーズで封じた控え」を置く。
 * 前者があれば受取住所も残高も、誰にも合言葉を聞かずに出せる。
 * 後者を開ける必要があるのは署名するときだけで、そのときだけパスフレーズを求める。
 */

/** ウォレットは 1 つなので、行の鍵は固定でよい。 */
export const WALLET_ID = 'default';

export type WalletFailure = { readonly ok: false; readonly reason: string };

export function getWallet(db: Db): WalletRow | undefined {
  return db.select().from(wallets).where(eq(wallets.id, WALLET_ID)).get();
}

export function hasWallet(db: Db): boolean {
  return getWallet(db) !== undefined;
}

export interface CreatedWallet {
  readonly ok: true;
  /** 一度だけ見せる 12 語。DB には封じた形しか残らない。 */
  readonly mnemonic: string;
  readonly xpub: string;
}

/**
 * ウォレットを作る。
 *
 * 既にあれば断る。作り直すと前の住所に届いた分に触れなくなるため、
 * 間違って二度押しても壊れないようにしておく。
 */
export async function createWallet(
  db: Db,
  input: {
    readonly network: Network;
    readonly passphrase: string;
    readonly actorMemberId: string;
    readonly account?: number;
    readonly now?: number;
    /** 試験で軽くするための入口。本番では省き、既定の約 1 秒のものを使う。 */
    readonly kdf?: KdfParams;
  },
): Promise<CreatedWallet | WalletFailure> {
  if (hasWallet(db)) {
    return { ok: false, reason: '既にウォレットがあります。作り直すと前の残高に触れなくなります' };
  }

  const now = input.now ?? Date.now();
  const account = input.account ?? 0;
  const mnemonic = createMnemonic();

  let vault: Buffer;
  try {
    vault = await sealMnemonic(
      mnemonic,
      input.passphrase,
      input.kdf === undefined ? {} : { kdf: input.kdf },
    );
  } catch (error: unknown) {
    return { ok: false, reason: error instanceof Error ? error.message : '控えを封じられません' };
  }

  // パスフレーズ付きの種は使わない。パスフレーズは控えを封じる鍵であって、
  // 鍵そのものの導出に混ぜると、控えが手元にあっても復旧できなくなる。
  const xpub = deriveAccountXpub(mnemonicToSeed(mnemonic), input.network, account);

  db.insert(wallets)
    .values({
      id: WALLET_ID,
      network: input.network,
      account,
      xpub,
      vault,
      nextReceive: 0,
      nextChange: 0,
      createdAt: now,
      createdBy: input.actorMemberId,
    })
    .run();

  appendAudit(db, {
    at: now,
    actorMemberId: input.actorMemberId,
    action: 'wallet.created',
    detail: { network: input.network, account },
  });

  return { ok: true, mnemonic, xpub };
}

export interface WalletAddress {
  readonly index: number;
  readonly change: number;
  readonly address: string;
}

/** 受取住所を番号順に作る。秘密鍵は要らない。 */
export function addressesOf(
  wallet: WalletRow,
  options: { readonly change?: number; readonly from?: number; readonly count: number },
): WalletAddress[] {
  const change = options.change ?? CHANGE_RECEIVE;
  const from = options.from ?? 0;
  return Array.from({ length: options.count }, (_, offset) => {
    const index = from + offset;
    return {
      index,
      change,
      address: addressFromXpub(wallet.xpub, wallet.network, { change, index }),
    };
  });
}

/**
 * 残高を見るために当たる住所。
 *
 * 受取とお釣りの両方を、使われていないものが続いても GAP_LIMIT 個先まで作る。
 * BIP44 の言う隙間の限度で、ここまで空なら以降も空だとみなしてよい。
 */
export function watchedAddresses(wallet: WalletRow): string[] {
  return watchedEntries(wallet).map((entry) => entry.address);
}

/** 見張る住所を、導出の番号つきで返す。署名のときに鍵を引くのに使う。 */
export function watchedEntries(wallet: WalletRow): WalletAddress[] {
  return [
    ...addressesOf(wallet, { change: CHANGE_RECEIVE, count: wallet.nextReceive + GAP_LIMIT }),
    ...addressesOf(wallet, { change: CHANGE_INTERNAL, count: wallet.nextChange + GAP_LIMIT }),
  ];
}

/** 次のお釣り住所を配って、番号を 1 つ進める。 */
export function issueChangeAddress(db: Db): WalletAddress | WalletFailure {
  const wallet = getWallet(db);
  if (wallet === undefined) return { ok: false, reason: 'ウォレットがまだありません' };

  const index = wallet.nextChange;
  const address = addressFromXpub(wallet.xpub, wallet.network, {
    change: CHANGE_INTERNAL,
    index,
  });
  db.update(wallets)
    .set({ nextChange: index + 1 })
    .where(eq(wallets.id, WALLET_ID))
    .run();

  return { index, change: CHANGE_INTERNAL, address };
}

/** 次の受取住所を配って、番号を 1 つ進める。 */
export function issueReceiveAddress(
  db: Db,
  input: { readonly actorMemberId: string; readonly now?: number },
): WalletAddress | WalletFailure {
  const wallet = getWallet(db);
  if (wallet === undefined) return { ok: false, reason: 'ウォレットがまだありません' };

  const now = input.now ?? Date.now();
  const index = wallet.nextReceive;
  const address = addressFromXpub(wallet.xpub, wallet.network, {
    change: CHANGE_RECEIVE,
    index,
  });

  db.update(wallets)
    .set({ nextReceive: index + 1 })
    .where(eq(wallets.id, WALLET_ID))
    .run();

  appendAudit(db, {
    at: now,
    actorMemberId: input.actorMemberId,
    action: 'wallet.address_issued',
    detail: { index, address },
  });

  return { index, change: CHANGE_RECEIVE, address };
}

export interface UnlockedWallet {
  readonly ok: true;
  readonly row: WalletRow;
  /** 住所ひとつぶんの秘密鍵を取り出す。使い終わったら捨てる。 */
  privateKeyAt(options: { readonly change?: number; readonly index: number }): Uint8Array;
}

/**
 * 控えを開く。署名するときだけ呼ぶ。
 *
 * 開いた種はこの関数の外に出さない。呼び出し側は必要な秘密鍵だけを受け取る。
 */
export async function unlockWallet(
  db: Db,
  passphrase: string,
): Promise<UnlockedWallet | WalletFailure> {
  const row = getWallet(db);
  if (row === undefined) return { ok: false, reason: 'ウォレットがまだありません' };

  let seed: Uint8Array;
  try {
    seed = mnemonicToSeed(await openMnemonic(Buffer.from(row.vault), passphrase));
  } catch (error: unknown) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'パスフレーズが違います',
    };
  }

  return {
    ok: true,
    row,
    privateKeyAt: (options) =>
      derivePrivateKey(seed, row.network, {
        account: row.account,
        change: options.change ?? CHANGE_RECEIVE,
        index: options.index,
      }),
  };
}
