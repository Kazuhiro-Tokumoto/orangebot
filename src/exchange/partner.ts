import type { DeliveryOutcome, PartnerClient } from '../domain/exchange.js';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, sign } from './signature.js';

/**
 * 相手の bot へ出金を届ける。
 *
 * 相手の受け口に求める約束 (docs/EXCHANGE_API.md) に沿って、応答を 4 つに分ける。
 *
 *   2xx                     受け取った
 *   409                     同じ id で別の内容を受けている。人が見る
 *   408, 425, 429, 5xx      一時的に受けられない。後で送り直す
 *   それ以外の 4xx          はっきり断った。返金する
 *   繋がらない・時間切れ    届いたか分からない。後で送り直す
 *
 * 送り直しは常に同じ id と同じ本文で行う。相手は id で重複を見分ける。
 */

const TIMEOUT_MS = 15_000;
const RETRYABLE_STATUSES = new Set([408, 425, 429]);

export interface PartnerOptions {
  /** 相手の受け口の URL。例: https://oogiri-bot-cfy1.onrender.com/api/orangebot-boag-pt-exchange/v1/pt-deposits */
  readonly url: string;
  readonly secret: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
}

async function readMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  try {
    const body: unknown = JSON.parse(text);
    if (typeof body === 'object' && body !== null) {
      const error = (body as Record<string, unknown>)['error'];
      if (typeof error === 'object' && error !== null) {
        const message = (error as Record<string, unknown>)['message'];
        if (typeof message === 'string') return message.slice(0, 300);
      }
    }
  } catch {
    // 本文が JSON でなければ、そのまま切り詰めて使う。
  }
  return text.slice(0, 300);
}

export function createPartnerClient(options: PartnerOptions): PartnerClient {
  const doFetch = options.fetch ?? globalThis.fetch;
  const clock = options.now ?? Date.now;
  const url = new URL(options.url);
  const path = `${url.pathname}${url.search}`;

  return {
    async deliver(withdrawal) {
      const body = JSON.stringify({
        id: withdrawal.id,
        discordId: withdrawal.discordId,
        pt: withdrawal.pt,
        requestedAt: withdrawal.requestedAt,
      });
      const timestamp = String(Math.floor(clock() / 1000));
      const signature = sign(options.secret, {
        direction: 'from-orangebot',
        method: 'POST',
        path,
        timestamp,
        body,
      });

      let response: Response;
      try {
        response = await doFetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [TIMESTAMP_HEADER]: timestamp,
            [SIGNATURE_HEADER]: signature,
            'idempotency-key': withdrawal.id,
          },
          body,
          redirect: 'error',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : String(error);
        return { kind: 'retry', status: null, message: `繋がりません: ${reason}` };
      }

      const status = response.status;
      if (status >= 200 && status < 300) {
        // 本文は読み捨てる。接続を使い回せるようにするため。
        await response.text().catch(() => '');
        return { kind: 'delivered' };
      }

      const message = await readMessage(response);
      const outcome: DeliveryOutcome =
        status === 409
          ? { kind: 'conflict', status, message }
          : RETRYABLE_STATUSES.has(status) || status >= 500
            ? { kind: 'retry', status, message }
            : status >= 400
              ? { kind: 'rejected', status, message }
              : // 3xx などの想定外。受け取ったとも断ったとも言えないので送り直す。
                { kind: 'retry', status, message };
      return outcome;
    },
  };
}
