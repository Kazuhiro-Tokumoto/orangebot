/**
 * 取引所の値段。
 *
 * 予想の答え合わせには 5 分足を使う。足の始値と終値はあとから誰でも同じ値を
 * 取り寄せられるので、こちらが結果を操作していないことを外から確かめられる。
 *
 * 既定は Binance の公開 API (data-api.binance.vision)。認証が要らず、
 * 取引用の api.binance.com と違って地域による締め出しが無い。
 */

export const CANDLE_MS = 5 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;

/** 取り寄せる足の長さ。Binance の interval の表記と同じ。 */
export type CandleInterval = '5m' | '1h';

export const INTERVAL_MS: Readonly<Record<CandleInterval, number>> = {
  '5m': CANDLE_MS,
  '1h': HOUR_MS,
};
export const DEFAULT_PRICE_BASE_URL = 'https://data-api.binance.vision';
const TIMEOUT_MS = 10_000;

export class PriceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PriceError';
  }
}

export interface Candle {
  /** 足の始まり (ミリ秒)。足の長さの倍数。 */
  readonly openTime: number;
  /** 足の終わり (ミリ秒)。この時刻を過ぎていれば値は確定している。 */
  readonly closeTime: number;
  /** 10 進文字列。浮動小数に直さずに比べる。 */
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
}

export interface Ticker {
  readonly symbol: string;
  readonly price: string;
}

export interface PriceSource {
  /** openTime から始まる足。既定は 5 分足。まだ無ければ undefined。 */
  candle(symbol: string, openTime: number, interval?: CandleInterval): Promise<Candle | undefined>;
  /** いまの値段。 */
  ticker(symbol: string): Promise<Ticker>;
}

const SYMBOL_PATTERN = /^[A-Z0-9]{5,20}$/;
const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;

export function isSymbol(value: string): boolean {
  return SYMBOL_PATTERN.test(value);
}

/**
 * 10 進文字列どうしを比べる。
 * 浮動小数に直すと、小さな上げ下げが丸めで消えて「変わらず」に化けうるため。
 */
export function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  const [left = 0n, right = 0n] = scaleDecimals([a, b]).values;
  return left === right ? 0 : left < right ? -1 : 1;
}

export function isDecimal(value: string): boolean {
  return DECIMAL_PATTERN.test(value);
}

/**
 * 10 進文字列を、小数点以下の桁をそろえた整数にする。
 * 返す scale は 10 の何乗倍したか。すべて同じ倍率なので、そのまま足し引きや比較ができる。
 */
export function scaleDecimals(values: readonly string[]): {
  readonly scale: number;
  readonly values: readonly bigint[];
} {
  for (const value of values) {
    if (!DECIMAL_PATTERN.test(value)) throw new PriceError(`値段として読めません: ${value}`);
  }
  const parts = values.map((value) => {
    const [whole = '0', fraction = ''] = value.split('.');
    return { whole, fraction };
  });
  const scale = Math.max(0, ...parts.map((part) => part.fraction.length));
  return {
    scale,
    values: parts.map((part) => BigInt(part.whole + part.fraction.padEnd(scale, '0'))),
  };
}

/** 始値から終値への変化を、小数 2 桁のパーセントの文字列にする。表示用。 */
export function formatChange(open: string, close: string): string {
  const [o = 0n, c = 0n] = scaleDecimals([open, close]).values;
  if (o === 0n) return '-';
  const hundredths = ((c - o) * 10_000n) / o;
  const sign = hundredths < 0n ? '-' : hundredths > 0n ? '+' : '';
  const magnitude = hundredths < 0n ? -hundredths : hundredths;
  return `${sign}${(magnitude / 100n).toString()}.${(magnitude % 100n).toString().padStart(2, '0')}%`;
}

export function createBinanceSource(
  options: { readonly baseUrl?: string; readonly fetch?: typeof globalThis.fetch } = {},
): PriceSource {
  const base = options.baseUrl ?? DEFAULT_PRICE_BASE_URL;
  const doFetch = options.fetch ?? globalThis.fetch;

  async function getJson(path: string): Promise<unknown> {
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new PriceError(`値段を取り寄せられません: ${reason}`);
    }
    if (!response.ok) throw new PriceError(`値段の問い合わせが ${String(response.status)} を返しました`);
    return response.json();
  }

  return {
    async candle(symbol, openTime, interval = '5m') {
      if (!isSymbol(symbol)) throw new PriceError(`シンボルが不正です: ${symbol}`);
      const query = new URLSearchParams({
        symbol,
        interval,
        startTime: String(openTime),
        limit: '1',
      });
      const body = await getJson(`/api/v3/klines?${query.toString()}`);
      if (!Array.isArray(body)) throw new PriceError('足の応答の形が違います');

      const [row] = body as unknown[];
      if (row === undefined) return undefined;
      if (!Array.isArray(row)) throw new PriceError('足の応答の形が違います');

      const [rowOpenTime, open, high, low, close, , closeTime] = row as unknown[];
      const prices = [open, high, low, close];
      if (
        typeof rowOpenTime !== 'number' ||
        typeof closeTime !== 'number' ||
        !prices.every((value) => typeof value === 'string' && DECIMAL_PATTERN.test(value))
      ) {
        throw new PriceError('足の応答の形が違います');
      }
      // 頼んだ足でなければ、まだその足が無い (次の足が返ってきた) ということ。
      if (rowOpenTime !== openTime) return undefined;

      return {
        openTime: rowOpenTime,
        closeTime,
        open: open as string,
        high: high as string,
        low: low as string,
        close: close as string,
      };
    },

    async ticker(symbol) {
      if (!isSymbol(symbol)) throw new PriceError(`シンボルが不正です: ${symbol}`);
      const body = await getJson(`/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`);
      if (typeof body !== 'object' || body === null) throw new PriceError('値段の応答の形が違います');
      const price = (body as Record<string, unknown>)['price'];
      if (typeof price !== 'string' || !DECIMAL_PATTERN.test(price)) {
        throw new PriceError('値段の応答の形が違います');
      }
      return { symbol, price };
    },
  };
}
