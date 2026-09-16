import { bech32m } from '@scure/base';
import { schnorr } from '@noble/curves/secp256k1.js';

/**
 * OAG のアドレス。
 *
 * bech32m (BIP350) で、全バージョン共通。形は
 *   <HRP> "1" <version> <payload を 5 ビットに変換> <検査符号 6 文字>
 *
 * version 0 の payload は BIP340 の x-only 公開鍵 32 バイトそのもの。
 * ハッシュは挟まない（SPEC §6.4）。
 */

export type Network = 'mainnet' | 'testnet' | 'regtest';

export const HRP: Readonly<Record<Network, string>> = {
  mainnet: 'oag',
  testnet: 'toag',
  regtest: 'roag',
};

/** version 0 = Schnorr x-only 公開鍵。 */
export const ADDRESS_VERSION_SCHNORR = 0;

const MAX_ADDRESS_LENGTH = 128;

export class AddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AddressError';
  }
}

/** 秘密鍵から BIP340 の x-only 公開鍵を作る。 */
export function xOnlyPublicKey(privateKey: Uint8Array): Uint8Array {
  if (privateKey.length !== 32) {
    throw new AddressError('秘密鍵は 32 バイトである必要があります');
  }
  return schnorr.getPublicKey(privateKey);
}

export function encodeAddress(
  network: Network,
  payload: Uint8Array,
  version = ADDRESS_VERSION_SCHNORR,
): string {
  if (version < 0 || version > 31) {
    throw new AddressError(`アドレス版数は 0〜31 です: ${String(version)}`);
  }
  if (version === ADDRESS_VERSION_SCHNORR && payload.length !== 32) {
    throw new AddressError('version 0 の payload は 32 バイトの x-only 公開鍵です');
  }
  // 先頭の 1 文字が版数、そのあとが payload を 5 ビットに詰め直したもの。
  const words = [version, ...bech32m.toWords(payload)];
  return bech32m.encode(HRP[network], words, MAX_ADDRESS_LENGTH);
}

export function addressFromPrivateKey(network: Network, privateKey: Uint8Array): string {
  return encodeAddress(network, xOnlyPublicKey(privateKey));
}

export interface DecodedAddress {
  readonly network: Network;
  readonly version: number;
  readonly payload: Uint8Array;
}

function networkOf(hrp: string): Network | undefined {
  for (const [network, prefix] of Object.entries(HRP)) {
    if (prefix === hrp) return network as Network;
  }
  return undefined;
}

/**
 * アドレスを読む。
 *
 * HRP が期待するネットワークと違えば必ず断る。
 * これでネットワークを跨いだ誤送金が構造的に起きなくなる（SPEC §6.2）。
 */
export function decodeAddress(expected: Network, address: string): DecodedAddress {
  let decoded: { prefix: string; words: number[] };
  try {
    decoded = bech32m.decode(address as `${string}1${string}`, MAX_ADDRESS_LENGTH);
  } catch {
    throw new AddressError('アドレスとして読めません');
  }

  const network = networkOf(decoded.prefix);
  if (network === undefined) {
    throw new AddressError(`知らないネットワーク識別子です: ${decoded.prefix}`);
  }
  if (network !== expected) {
    throw new AddressError(`${expected} のアドレスではありません（${network} のアドレスです）`);
  }

  const version = decoded.words[0];
  if (version === undefined) throw new AddressError('版数がありません');

  const payload = bech32m.fromWords(decoded.words.slice(1));
  if (version === ADDRESS_VERSION_SCHNORR && payload.length !== 32) {
    throw new AddressError('version 0 の payload は 32 バイトである必要があります');
  }

  return { network, version, payload: Uint8Array.from(payload) };
}

/**
 * 送金先として使ってよいか。
 *
 * 未知の版数は「誰でも使える出力」として扱われるため、有効化前に送ると資金を失う。
 * 仕様は警告のうえで許可することを求めているので、断るのではなく警告を返す。
 */
export function inspectDestination(
  expected: Network,
  address: string,
):
  | { readonly ok: true; readonly warning?: string }
  | { readonly ok: false; readonly reason: string } {
  let decoded: DecodedAddress;
  try {
    decoded = decodeAddress(expected, address);
  } catch (error: unknown) {
    return { ok: false, reason: error instanceof Error ? error.message : 'アドレスが不正です' };
  }

  if (decoded.version !== ADDRESS_VERSION_SCHNORR) {
    return {
      ok: true,
      warning: `未対応の版数 ${String(decoded.version)} のアドレスです。この版数が有効化される前に送ると資金を失います`,
    };
  }
  return { ok: true };
}
