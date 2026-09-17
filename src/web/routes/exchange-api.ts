import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getMember } from '../../db/members.js';
import { creditDeposit, getDeposit, type ExchangeErrorCode } from '../../domain/exchange.js';
import { SOAG_PER_PT, toDecimalString } from '../../domain/units.js';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verify } from '../../exchange/signature.js';
import type { RouteDeps } from '../context.js';

/**
 * 外部の bot から呼ばれる API。仕様は docs/EXCHANGE_API.md。
 *
 * 全ての要求に HMAC の署名を求める。画面のセッションは一切見ない。
 * 応答は常に JSON で、誤りは { "error": { "code", "message" } } の形。
 */

/** 相手の bot の API と被らないよう、長い名前にしてある。 */
export const EXCHANGE_API_PREFIX = '/api/orangebot-boag-pt-exchange/v1';
const MAX_BODY_BYTES = 16 * 1024;

type ErrorCode = ExchangeErrorCode | 'unauthorized' | 'not_found' | 'disabled' | 'payload_too_large';

function fail(c: Context, status: 400 | 401 | 404 | 409 | 413 | 422 | 503, code: ErrorCode, message: string) {
  return c.json({ error: { code, message } }, status);
}

const STATUS_FOR: Readonly<Record<ExchangeErrorCode, 400 | 404 | 409 | 422>> = {
  invalid_request: 400,
  member_not_found: 404,
  idempotency_conflict: 409,
  limit_exceeded: 422,
  insufficient_balance: 422,
};

export function exchangeApiRoutes(deps: RouteDeps) {
  const app = new Hono();
  const config = deps.env.exchange;

  app.use(
    `${EXCHANGE_API_PREFIX}/*`,
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => fail(c, 413, 'payload_too_large', `本文は ${String(MAX_BODY_BYTES)} バイトまで`),
    }),
  );

  /** 署名を確かめて、本文の文字列を返す。通らなければ応答を返す。 */
  async function authenticate(c: Context): Promise<{ readonly body: string } | Response> {
    if (config === undefined) return fail(c, 503, 'disabled', '交換は止めてあります');

    const body = await c.req.text();
    const url = new URL(c.req.url);
    const result = verify(config.secret, {
      direction: 'to-orangebot',
      method: c.req.method,
      path: `${url.pathname}${url.search}`,
      timestamp: c.req.header(TIMESTAMP_HEADER),
      signature: c.req.header(SIGNATURE_HEADER),
      body,
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    // どこで落ちたかは返さない。手探りの手掛かりにさせないため。
    if (!result.ok) return fail(c, 401, 'unauthorized', '署名かタイムスタンプが正しくありません');
    return { body };
  }

  function depositJson(deposit: {
    readonly id: string;
    readonly memberId: string;
    readonly pt: string;
    readonly soag: string;
    readonly createdAt: number;
  }) {
    return {
      id: deposit.id,
      discordId: deposit.memberId,
      pt: deposit.pt,
      boag: toDecimalString(BigInt(deposit.soag)),
      soag: deposit.soag,
      creditedAt: deposit.createdAt,
    };
  }

  /** 換算の比。署名つきで取れるので、相手は表示に使ってよい。 */
  app.get(`${EXCHANGE_API_PREFIX}/rate`, async (c) => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    return c.json({ ptPerBoag: '10000000', soagPerPt: SOAG_PER_PT.toString(), decimals: 16 });
  });

  /** 入金の前に、宛先が有効なメンバーかを確かめる。 */
  app.get(`${EXCHANGE_API_PREFIX}/members/:discordId`, async (c) => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;

    const member = getMember(deps.db, c.req.param('discordId'));
    if (member === undefined || member.status !== 'active') {
      return fail(c, 404, 'member_not_found', 'その Discord ID の有効なメンバーはいません');
    }
    return c.json({ discordId: member.id, active: true });
  });

  /**
   * 入金。相手が pt を引いたあとに呼ぶ。
   * 同じ id で同じ内容なら、何度呼んでも 1 回だけ付けて同じ応答を返す。
   */
  app.post(`${EXCHANGE_API_PREFIX}/deposits`, async (c) => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    if (config === undefined) return fail(c, 503, 'disabled', '交換は止めてあります');

    let payload: unknown;
    try {
      payload = JSON.parse(auth.body);
    } catch {
      return fail(c, 400, 'invalid_request', '本文が JSON ではありません');
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return fail(c, 400, 'invalid_request', '本文はオブジェクトにしてください');
    }
    const record = payload as Record<string, unknown>;

    const result = creditDeposit(deps.db, {
      id: record['id'],
      discordId: record['discordId'],
      pt: record['pt'],
      limits: config.limits,
    });
    if (!result.ok) return fail(c, STATUS_FOR[result.code], result.code, result.message);

    return c.json(
      { status: 'credited', replayed: result.replayed, deposit: depositJson(result.deposit) },
      result.replayed ? 200 : 201,
    );
  });

  /** 入金を id で引く。相手が応答を受け取り損ねたときの照合に使う。 */
  app.get(`${EXCHANGE_API_PREFIX}/deposits/:id`, async (c) => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;

    const deposit = getDeposit(deps.db, c.req.param('id'));
    if (deposit === undefined) return fail(c, 404, 'not_found', 'その id の入金はありません');
    return c.json({ status: 'credited', deposit: depositJson(deposit) });
  });

  app.all(`${EXCHANGE_API_PREFIX}/*`, (c) => fail(c, 404, 'not_found', 'そのような API はありません'));

  return app;
}
