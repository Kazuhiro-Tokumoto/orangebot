import { DECIMALS, formatUnits, parseUnits } from '../domain/units.js';

/**
 * OAG の金額。
 *
 * 台帳の中では u128 の最小単位 (atomic) で、小数は 16 桁 (Orange SPEC 3)。
 * BOAG と同じ桁なので、表し方は units.ts を共有する。
 */

export const OAG_DECIMALS = DECIMALS;

export class AmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmountError';
  }
}

/** 最小単位を人が読む形にする。末尾の 0 は落とし、整数部は 3 桁で区切る。 */
export function formatOag(atomic: bigint): string {
  return formatUnits(atomic);
}

/** 入力欄の文字列を最小単位にする。桁が多すぎるものは切り捨てずに断る。 */
export function parseOag(raw: string): bigint {
  const value = parseUnits(raw);
  if (value === undefined) {
    throw new AmountError(`金額は 0 以上の数で、小数は ${String(OAG_DECIMALS)} 桁までで入れてください`);
  }
  return value;
}
