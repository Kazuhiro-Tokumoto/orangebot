import { describe, expect, it, vi } from 'vitest';
import type { OagConfig } from '../env.js';
import { RpcError, createRpcClient, parseAtomic, parseScanResult } from './rpc.js';

const CONFIG: OagConfig = {
  network: 'mainnet',
  rpcUrl: 'http://127.0.0.1:9445',
  cookiePath: 'oag-data/.cookie',
};

/** 応答を決め打ちにした fetch。送られた中身も控える。 */
function stub(responses: unknown[], status = 200) {
  const sent: { body: unknown; headers: Record<string, string> }[] = [];
  let turn = 0;

  const fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    const body = typeof init?.body === 'string' ? init.body : '{}';
    sent.push({ body: JSON.parse(body) as unknown, headers: headers ?? {} });
    const payload = responses[Math.min(turn, responses.length - 1)];
    turn += 1;
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });

  return { fetch: fetch as unknown as typeof globalThis.fetch, sent };
}

function client(responses: unknown[], status = 200) {
  const { fetch, sent } = stub(responses, status);
  return {
    sent,
    rpc: createRpcClient(CONFIG, { fetch, readCookie: () => '__cookie__:abc123' }),
  };
}

describe('金額の読み取り', () => {
  it('10 進文字列をそのまま整数にする', () => {
    expect(parseAtomic('340282366920938463463374607431768211455', 'x')).toBe(
      340282366920938463463374607431768211455n,
    );
    expect(parseAtomic(' 42 ', 'x')).toBe(42n);
  });

  it('安全な範囲の数なら受ける', () => {
    expect(parseAtomic(1000, 'x')).toBe(1000n);
  });

  it('丸められた数や、数でないものは断る', () => {
    expect(() => parseAtomic(1.5, 'x')).toThrow(RpcError);
    expect(() => parseAtomic(Number.MAX_SAFE_INTEGER + 2, 'x')).toThrow(RpcError);
    expect(() => parseAtomic(null, 'x')).toThrow(RpcError);
    expect(() => parseAtomic('1e9', 'x')).toThrow(RpcError);
  });
});

describe('scanutxos の応答', () => {
  it('合計と打ち切りの印を読む', () => {
    const result = parseScanResult({
      utxos: [
        { txid: 'aa', vout: 0, address: 'oag1x', amount: '1000', height: 7 },
        { txid: 'bb', vout: 1, address: 'oag1y', amount: '2500' },
      ],
      total: '3500',
      truncated: true,
    });

    expect(result.total).toBe(3500n);
    expect(result.truncated).toBe(true);
    expect(result.utxos[0]?.height).toBe(7);
    expect(result.utxos[1]?.height).toBeUndefined();
  });

  it('合計が無ければ自分で足す', () => {
    const result = parseScanResult({
      utxos: [
        { txid: 'aa', vout: 0, address: 'oag1x', amount: '1' },
        { txid: 'bb', vout: 0, address: 'oag1y', amount: '2' },
      ],
    });

    expect(result.total).toBe(3n);
    expect(result.truncated).toBe(false);
  });

  it('金額が読めない UTXO は黙って 0 にせず断る', () => {
    expect(() =>
      parseScanResult({ utxos: [{ txid: 'aa', vout: 0, address: 'oag1x' }] }),
    ).toThrow(RpcError);
  });

  it('一覧が無ければ断る', () => {
    expect(() => parseScanResult({ total: '10' })).toThrow(RpcError);
  });
});

describe('呼び出し', () => {
  it('合言葉を Basic 認証で送る', async () => {
    const { rpc, sent } = client([{ result: 3 }]);
    await rpc.getBlockCount();

    const expected = Buffer.from('__cookie__:abc123', 'utf8').toString('base64');
    expect(sent[0]?.headers['authorization']).toBe(`Basic ${expected}`);
  });

  it('JSON-RPC の形で送る', async () => {
    const { rpc, sent } = client([{ result: { height: 1 } }]);
    await rpc.call('getinfo');

    expect(sent[0]?.body).toEqual({ jsonrpc: '2.0', id: 1, method: 'getinfo', params: [] });
  });

  it('住所の一覧は配列に包んで渡す', async () => {
    const { rpc, sent } = client([{ result: { utxos: [], total: '0' } }]);
    await rpc.scanUtxos(['oag1x', 'oag1y']);

    expect(sent[0]?.body).toMatchObject({ method: 'scanutxos', params: [['oag1x', 'oag1y']] });
  });

  it('住所が無ければ問い合わせない', async () => {
    const { rpc, sent } = client([{ result: {} }]);
    const result = await rpc.scanUtxos([]);

    expect(sent).toHaveLength(0);
    expect(result.total).toBe(0n);
  });

  it('ノードの誤りをそのまま伝える', async () => {
    const { rpc } = client([{ error: { code: -8, message: '知らない住所' } }]);
    await expect(rpc.getInfo()).rejects.toThrow(/知らない住所/);
  });

  it('合言葉が古ければ、そうと分かる文言で断る', async () => {
    const { rpc } = client([{}], 401);
    await expect(rpc.getBlockCount()).rejects.toThrow(/合言葉/);
  });

  it('繋がらなければノードの場所を添えて断る', async () => {
    const rpc = createRpcClient(CONFIG, {
      fetch: (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof globalThis.fetch,
      readCookie: () => '__cookie__:abc123',
    });
    await expect(rpc.getBlockCount()).rejects.toThrow(/127\.0\.0\.1:9445/);
  });

  it('合言葉は呼び出しのたびに読み直す', async () => {
    const { fetch } = stub([{ result: 1 }]);
    const readCookie = vi.fn(() => '__cookie__:abc');
    const rpc = createRpcClient(CONFIG, { fetch, readCookie });

    await rpc.getBlockCount();
    await rpc.getBlockCount();

    expect(readCookie).toHaveBeenCalledTimes(2);
  });

  it('getinfo は高さが無ければ断る', async () => {
    const { rpc } = client([{ result: { network: 'mainnet' } }]);
    await expect(rpc.getInfo()).rejects.toThrow(/高さ/);
  });
});
