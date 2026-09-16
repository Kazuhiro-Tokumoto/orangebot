/**
 * OAG の金額。
 *
 * 台帳の中では u128 の最小単位（atomic）で、小数は 16 桁（SPEC §6）。
 * JavaScript の数値では 16 桁を保てないので、内部では常に BigInt を使い、
 * 画面に出すときだけ文字列に直す。
 */

export const OAG_DECIMALS = 16;
const SCALE = 10n ** BigInt(OAG_DECIMALS);

export class AmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmountError';
  }
}

/**
 * 最小単位を人が読む形にする。
 * 末尾の 0 は落とす。整数部は 3 桁で区切る。
 */
export function formatOag(atomic: bigint): string {
  const negative = atomic < 0n;
  const value = negative ? -atomic : atomic;

  const whole = (value / SCALE).toLocaleString('en-US');
  const fraction = (value % SCALE).toString().padStart(OAG_DECIMALS, '0').replace(/0+$/, '');

  const text = fraction === '' ? whole : `${whole}.${fraction}`;
  return negative ? `-${text}` : text;
}

/** 入力欄の文字列を最小単位にする。桁が多すぎるものは切り捨てずに断る。 */
export function parseOag(raw: string): bigint {
  const text = raw.trim().replace(/[,_\s]/g, '');
  if (!/^\d+(\.\d+)?$/.test(text)) throw new AmountError('金額は 0 以上の数で入れてください');

  const [whole = '0', fraction = ''] = text.split('.');
  if (fraction.length > OAG_DECIMALS) {
    throw new AmountError(`小数は ${String(OAG_DECIMALS)} 桁までです`);
  }

  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(OAG_DECIMALS, '0') || '0');
}
