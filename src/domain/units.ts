/**
 * 金額の単位。
 *
 * BOAG も OAG も小数 16 桁で、内部では常に最小単位の整数 (BigInt) を使う。
 *
 *   1 BOAG = 10^16 SOAG   (SOAG = small BOAG。BOAG の最小単位)
 *   1 OAG  = 10^16 atomic (OAG の最小単位。Orange SPEC 3)
 *
 * 外部サービスの pt との換算は次の比で固定する。
 *
 *   10,000,000 pt = 1 BOAG
 *   したがって 1 pt = 10^9 SOAG
 *
 * BOAG と OAG は桁数をそろえてあるだけで、互いに交換する仕組みは無い。
 *
 * pt は整数で、1 pt 未満の SOAG は pt に換算できない。
 */

export const DECIMALS = 16;
export const SOAG_PER_BOAG = 10n ** BigInt(DECIMALS);
export const PT_PER_BOAG = 10_000_000n;
export const SOAG_PER_PT = SOAG_PER_BOAG / PT_PER_BOAG;

/** 最小単位の整数を、小数 16 桁の 10 進表記にする。末尾の 0 は落とし、整数部は 3 桁で区切る。 */
export function formatUnits(value: bigint): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;

  const whole = (magnitude / SOAG_PER_BOAG).toLocaleString('en-US');
  const fraction = (magnitude % SOAG_PER_BOAG)
    .toString()
    .padStart(DECIMALS, '0')
    .replace(/0+$/, '');

  const text = fraction === '' ? whole : `${whole}.${fraction}`;
  return negative ? `-${text}` : text;
}

/** 区切りを入れない正準形。API で返すときに使う。 */
export function toDecimalString(value: bigint): string {
  return formatUnits(value).replace(/,/g, '');
}

/**
 * 10 進表記を最小単位の整数にする。
 * 0 以上で、小数は 16 桁まで。桁を切り捨てて丸めることはしない。形が違えば undefined。
 */
export function parseUnits(raw: string): bigint | undefined {
  const text = raw.trim().replace(/[,_\s]/g, '');
  if (!/^\d{1,26}(\.\d{1,16})?$/.test(text)) return undefined;

  const [whole = '0', fraction = ''] = text.split('.');
  return BigInt(whole) * SOAG_PER_BOAG + BigInt(fraction.padEnd(DECIMALS, '0'));
}
