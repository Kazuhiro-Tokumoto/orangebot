import { describe, expect, it, vi } from 'vitest';
import { createPartnerClient } from './partner.js';
import { MAX_CLOCK_SKEW_SECONDS, bodyHash, sign, verify } from './signature.js';

/** docs/EXCHANGE_API.md に載せている例と同じ値。相手の実装の答え合わせに使う。 */
const SECRET = 'orangebot-example-secret-0123456789abcdef';
const INBOUND_BODY =
  '{"id":"oogiri-20260917-0001","discordId":"1529717434259345489","pt":"10000000"}';
const OUTBOUND_BODY =
  '{"id":"0b6c9f3e-2d7a-4c1e-9a55-7f0d2b8e4c11","discordId":"1529717434259345489","pt":"25000000","requestedAt":1789999990000}';
const TS = '1789999999';

describe('署名の例', () => {
  it('相手からこちらへの入金', () => {
    expect(bodyHash(INBOUND_BODY)).toBe(
      '359ea0e091ab809cc240e8829a0ccc65bb0e8b519c317337b39c8f7dc1886b7b',
    );
    expect(
      sign(SECRET, {
        direction: 'to-orangebot',
        method: 'POST',
        path: '/api/orangebot-boag-pt-exchange/v1/deposits',
        timestamp: TS,
        body: INBOUND_BODY,
      }),
    ).toBe('v1=08d2d28d8d2225a32da40dbefa27b19a2d4f18ad38d6dfd6eaf75959ede3dc70');
  });

  it('こちらから相手への出金', () => {
    expect(bodyHash(OUTBOUND_BODY)).toBe(
      '7628ac20d212ed083c6c7bdb22b3162d93d9ef8d4354b0ec74c88933c682cc25',
    );
    expect(
      sign(SECRET, {
        direction: 'from-orangebot',
        method: 'POST',
        path: '/api/orangebot-boag-pt-exchange/v1/pt-deposits',
        timestamp: TS,
        body: OUTBOUND_BODY,
      }),
    ).toBe('v1=cdf3c8484205568766376d9109c3ccf5617573ac39e5771b77114816be87e26a');
  });
});

describe('検証', () => {
  const base = {
    direction: 'to-orangebot' as const,
    method: 'POST',
    path: '/api/orangebot-boag-pt-exchange/v1/deposits',
    timestamp: TS,
    body: INBOUND_BODY,
  };
  const signature = sign(SECRET, base);
  const now = Number(TS);

  it('正しい署名は通る', () => {
    expect(verify(SECRET, { ...base, signature, nowSeconds: now }).ok).toBe(true);
  });

  it('本文、パス、メソッドのどれを変えても通らない', () => {
    expect(verify(SECRET, { ...base, body: INBOUND_BODY.replace('10000000', '99999999'), signature, nowSeconds: now }).ok).toBe(false);
    expect(verify(SECRET, { ...base, path: '/api/orangebot-boag-pt-exchange/v1/deposits?x=1', signature, nowSeconds: now }).ok).toBe(false);
    expect(verify(SECRET, { ...base, method: 'PUT', signature, nowSeconds: now }).ok).toBe(false);
  });

  it('向きの違う署名は通らない。出金の要求を入金の口へ投げ返されても効かない', () => {
    const reflected = sign(SECRET, { ...base, direction: 'from-orangebot' });
    expect(verify(SECRET, { ...base, signature: reflected, nowSeconds: now }).ok).toBe(false);
  });

  it('秘密が違えば通らない', () => {
    expect(verify('another-secret-another-secret-00', { ...base, signature, nowSeconds: now }).ok).toBe(false);
  });

  it('時計のずれは 300 秒まで', () => {
    expect(verify(SECRET, { ...base, signature, nowSeconds: now + MAX_CLOCK_SKEW_SECONDS }).ok).toBe(true);
    expect(verify(SECRET, { ...base, signature, nowSeconds: now + MAX_CLOCK_SKEW_SECONDS + 1 }).ok).toBe(false);
    expect(verify(SECRET, { ...base, signature, nowSeconds: now - MAX_CLOCK_SKEW_SECONDS - 1 }).ok).toBe(false);
  });

  it('見出しが欠けていたり形が違えば通らない', () => {
    expect(verify(SECRET, { ...base, signature: undefined, nowSeconds: now }).ok).toBe(false);
    expect(verify(SECRET, { ...base, timestamp: undefined, signature, nowSeconds: now }).ok).toBe(false);
    expect(verify(SECRET, { ...base, signature: signature.toUpperCase(), nowSeconds: now }).ok).toBe(false);
  });
});

describe('相手への出金の届け方', () => {
  const withdrawal = {
    id: '0b6c9f3e-2d7a-4c1e-9a55-7f0d2b8e4c11',
    discordId: '1529717434259345489',
    pt: '25000000',
    requestedAt: 1789999990000,
  };

  function client(status: number | 'network', body = '{}') {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetch = vi.fn((url: URL, init: RequestInit) => {
      seen.push({ url: url.toString(), init });
      if (status === 'network') return Promise.reject(new Error('ECONNRESET'));
      return Promise.resolve(new Response(body, { status }));
    }) as unknown as typeof globalThis.fetch;
    const partner = createPartnerClient({
      url: 'https://partner.example/api/orangebot-boag-pt-exchange/v1/pt-deposits',
      secret: SECRET,
      fetch,
      now: () => 1789999999_000,
    });
    return { partner, seen };
  }

  it('相手が検証できる署名を付けて送る', async () => {
    const { partner, seen } = client(201);
    await expect(partner.deliver(withdrawal)).resolves.toEqual({ kind: 'delivered' });

    const init = seen[0]?.init;
    const headers = init?.headers as Record<string, string>;
    expect(init?.body).toBe(OUTBOUND_BODY);
    expect(headers['idempotency-key']).toBe(withdrawal.id);
    expect(
      verify(SECRET, {
        direction: 'from-orangebot',
        method: 'POST',
        path: '/api/orangebot-boag-pt-exchange/v1/pt-deposits',
        timestamp: headers['x-exchange-timestamp'],
        signature: headers['x-exchange-signature'],
        body: OUTBOUND_BODY,
        nowSeconds: 1789999999,
      }).ok,
    ).toBe(true);
  });

  it('応答を 4 つに分ける', async () => {
    expect((await client(200).partner.deliver(withdrawal)).kind).toBe('delivered');
    expect((await client(404, '{"error":{"code":"user_not_found","message":"いない"}}').partner.deliver(withdrawal))).toEqual({
      kind: 'rejected',
      status: 404,
      message: 'いない',
    });
    expect((await client(401).partner.deliver(withdrawal)).kind).toBe('rejected');
    expect((await client(409).partner.deliver(withdrawal)).kind).toBe('conflict');
    expect((await client(429).partner.deliver(withdrawal)).kind).toBe('retry');
    expect((await client(503).partner.deliver(withdrawal)).kind).toBe('retry');
    expect((await client('network').partner.deliver(withdrawal)).kind).toBe('retry');
  });
});
