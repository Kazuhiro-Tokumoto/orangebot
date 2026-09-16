import { HDKey } from '@scure/bip32';
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { addressFromPrivateKey, encodeAddress, type Network } from './address.js';

/**
 * HD ウォレットの鍵導出。BIP39 + BIP32 + BIP44（SPEC §6.6）。
 *
 *   控えの語 (12) --PBKDF2--> 種 (64 バイト) --BIP32--> m/44'/coin'/account'/change/index
 */

/**
 * SLIP-0044 のコインタイプ。
 *
 * mainnet の 1033 は satoshilabs/slips のプルリクエスト #2061 で申請中であり、
 * **まだ確定していない**。別の番号で受理された場合、同じ控えから導かれる
 * mainnet の鍵はすべて変わる。利用者から見れば資金が消えたのと区別がつかない。
 *
 * したがって番号が確定するまで mainnet のアドレスへ資金を入れてはならない。
 * testnet と regtest は全コイン共通の 1 を使うので、この申請に依存しない。
 */
export const COIN_TYPE: Readonly<Record<Network, number>> = {
  mainnet: 1033,
  testnet: 1,
  regtest: 1,
};

/** mainnet のコインタイプが未確定であることを示す。確定したら false にする。 */
export const MAINNET_COIN_TYPE_PENDING = true;

export const MNEMONIC_WORDS = 12;
const MNEMONIC_STRENGTH_BITS = 128;

/** 受取用と、お釣り用。 */
export const CHANGE_RECEIVE = 0;
export const CHANGE_INTERNAL = 1;

/** 未使用アドレスをいくつ空振りしたら打ち切るか（BIP44）。 */
export const GAP_LIMIT = 20;

export class SeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedError';
  }
}

/** 12 語の控えを作る。128 ビットは secp256k1 の実効強度と一致する。 */
export function createMnemonic(): string {
  return generateMnemonic(wordlist, MNEMONIC_STRENGTH_BITS);
}

export function isValidMnemonic(mnemonic: string): boolean {
  return validateMnemonic(normalizeMnemonic(mnemonic), wordlist);
}

/** 語の区切りを揃える。前後の空白と連続する空白を 1 つにする。 */
export function normalizeMnemonic(mnemonic: string): string {
  return mnemonic.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * 控えから種を作る。
 *
 * 追加パスフレーズは BIP39 の任意項目で、既定は空文字列。
 * **打ち間違えても失敗として現れない。** 別のパスフレーズは単に別の有効な
 * ウォレットを作り、利用者には残高 0 のウォレットが見えるだけになる。
 * 画面ではこの性質を必ず伝えること（SPEC §6.6）。
 */
export function mnemonicToSeed(mnemonic: string, passphrase = ''): Uint8Array {
  const normalized = normalizeMnemonic(mnemonic);
  if (!validateMnemonic(normalized, wordlist)) {
    throw new SeedError('控えの語が正しくありません');
  }
  return mnemonicToSeedSync(normalized, passphrase);
}

export interface DerivationOptions {
  readonly account?: number;
  readonly change?: number;
  readonly index: number;
}

export function derivationPath(network: Network, options: DerivationOptions): string {
  const account = options.account ?? 0;
  const change = options.change ?? CHANGE_RECEIVE;
  return `m/44'/${String(COIN_TYPE[network])}'/${String(account)}'/${String(change)}/${String(options.index)}`;
}

/** 口座までの経路。ここまでを強化導出にするのが BIP44。 */
export function accountPath(network: Network, account = 0): string {
  return `m/44'/${String(COIN_TYPE[network])}'/${String(account)}'`;
}

export function derivePrivateKey(
  seed: Uint8Array,
  network: Network,
  options: DerivationOptions,
): Uint8Array {
  const node = HDKey.fromMasterSeed(seed).derive(derivationPath(network, options));
  if (node.privateKey === null) throw new SeedError('秘密鍵を導出できませんでした');
  return node.privateKey;
}

export interface DerivedAddress {
  readonly index: number;
  readonly change: number;
  readonly account: number;
  readonly path: string;
  readonly address: string;
}

export function deriveAddress(
  seed: Uint8Array,
  network: Network,
  options: DerivationOptions,
): DerivedAddress {
  const account = options.account ?? 0;
  const change = options.change ?? CHANGE_RECEIVE;
  const key = derivePrivateKey(seed, network, { account, change, index: options.index });
  return {
    index: options.index,
    change,
    account,
    path: derivationPath(network, { account, change, index: options.index }),
    address: addressFromPrivateKey(network, key),
  };
}

export function deriveAddresses(
  seed: Uint8Array,
  network: Network,
  options: { readonly account?: number; readonly change?: number; readonly count: number },
): DerivedAddress[] {
  return Array.from({ length: options.count }, (_, index) =>
    deriveAddress(seed, network, {
      account: options.account ?? 0,
      change: options.change ?? CHANGE_RECEIVE,
      index,
    }),
  );
}

/**
 * 口座の拡張公開鍵。
 *
 * secp256k1 なので非強化導出が使え、これだけで子アドレスを無限に作れる。
 * 秘密鍵を一切置かずに受取アドレスを発行したい場合はこれを渡す（SPEC §6.6）。
 */
export function deriveAccountXpub(seed: Uint8Array, network: Network, account = 0): string {
  return HDKey.fromMasterSeed(seed).derive(accountPath(network, account)).publicExtendedKey;
}

/** 拡張公開鍵から受取アドレスを作る。秘密鍵は要らない。 */
export function addressFromXpub(
  xpub: string,
  network: Network,
  options: { readonly change?: number; readonly index: number },
): string {
  const change = options.change ?? CHANGE_RECEIVE;
  const node = HDKey.fromExtendedKey(xpub).deriveChild(change).deriveChild(options.index);
  if (node.publicKey === null) throw new SeedError('公開鍵を導出できませんでした');
  if (node.publicKey.length !== 33) throw new SeedError('圧縮公開鍵は 33 バイトです');
  // BIP32 の公開鍵は 33 バイトの圧縮形式。BIP340 は先頭 1 バイトを落とした x 座標だけを使う。
  return encodeAddress(network, node.publicKey.subarray(1));
}
