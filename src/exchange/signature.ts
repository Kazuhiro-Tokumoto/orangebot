import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * 交換 API の署名。
 *
 * 両側で同じ共有の秘密を持ち、HMAC-SHA256 で要求に署名する。
 * 署名する文字列には向き (どちらからどちらへの要求か) を入れる。
 * 入れないと、こちらが相手に送った「pt を付けてくれ」という要求を
 * そのままこちらの受け口へ投げ返され、BOAG を無から作られてしまう。
 *
 *   署名する文字列 =
 *     "OBX1" 改行
 *     向き ("to-orangebot" または "from-orangebot") 改行
 *     HTTP メソッド (大文字) 改行
 *     パス (クエリを含む) 改行
 *     タイムスタンプ (Unix 秒の 10 進) 改行
 *     本文の SHA-256 (小文字 16 進。本文が空なら空文字列のハッシュ)
 *
 *   X-Exchange-Timestamp: <タイムスタンプ>
 *   X-Exchange-Signature: v1=<HMAC-SHA256(秘密, 署名する文字列) の小文字 16 進>
 *
 * 詳しくは docs/EXCHANGE_API.md。
 */

export const SIGNATURE_VERSION = 'OBX1';
export const TIMESTAMP_HEADER = 'x-exchange-timestamp';
export const SIGNATURE_HEADER = 'x-exchange-signature';
/**
 * 応答に付けるこちらの時計 (Unix 秒)。
 *
 * 署名が通らなかった理由は返さない決まりだが、時計のずれだけは相手が自分で直せる。
 * ずれは秘密の手掛かりにならないので、これだけは常に返す。
 */
export const SERVER_TIME_HEADER = 'x-exchange-server-time';
/** 時計のずれとして許す幅。これより古い、または未来の要求は断る。 */
export const MAX_CLOCK_SKEW_SECONDS = 300;

export type Direction = 'to-orangebot' | 'from-orangebot';

export function bodyHash(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

export function stringToSign(input: {
  readonly direction: Direction;
  readonly method: string;
  readonly path: string;
  readonly timestamp: string;
  readonly body: string;
}): string {
  return [
    SIGNATURE_VERSION,
    input.direction,
    input.method.toUpperCase(),
    input.path,
    input.timestamp,
    bodyHash(input.body),
  ].join('\n');
}

export function sign(
  secret: string,
  input: {
    readonly direction: Direction;
    readonly method: string;
    readonly path: string;
    readonly timestamp: string;
    readonly body: string;
  },
): string {
  return `v1=${createHmac('sha256', secret).update(stringToSign(input), 'utf8').digest('hex')}`;
}

export type VerifyResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export function verify(
  secret: string,
  input: {
    readonly direction: Direction;
    readonly method: string;
    readonly path: string;
    readonly timestamp: string | undefined;
    readonly signature: string | undefined;
    readonly body: string;
    readonly nowSeconds: number;
  },
): VerifyResult {
  if (input.timestamp === undefined || !/^\d{1,12}$/.test(input.timestamp)) {
    return { ok: false, reason: 'タイムスタンプがありません' };
  }
  const skew = Math.abs(input.nowSeconds - Number(input.timestamp));
  if (skew > MAX_CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: 'タイムスタンプが許される幅を外れています' };
  }
  if (input.signature === undefined || !/^v1=[0-9a-f]{64}$/.test(input.signature)) {
    return { ok: false, reason: '署名がありません' };
  }

  const expected = Buffer.from(
    sign(secret, {
      direction: input.direction,
      method: input.method,
      path: input.path,
      timestamp: input.timestamp,
      body: input.body,
    }),
    'utf8',
  );
  const given = Buffer.from(input.signature, 'utf8');
  // 長さは形式の検査で揃っている。比べる時間が中身に依らないようにする。
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: '署名が合いません' };
  }
  return { ok: true };
}
