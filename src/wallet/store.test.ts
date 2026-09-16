import { beforeEach, describe, expect, it } from 'vitest';
import { verifyAuditLog } from '../db/audit.js';
import { openTestDatabase, type Database_ } from '../db/client.js';
import { members, type MemberRow } from '../db/schema.js';
import { AmountError, formatOag, parseOag } from './amount.js';
import { readWalletStatus } from './balance.js';
import { decodeAddress } from './address.js';
import type { RpcClient, ScanResult } from './rpc.js';
import { GAP_LIMIT } from './seed.js';
import {
  addressesOf,
  createWallet,
  getWallet,
  hasWallet,
  issueReceiveAddress,
  unlockWallet,
  watchedAddresses,
} from './store.js';

const T0 = 1_700_000_000_000;
const PASSPHRASE = 'kagi-no-aikotoba-123';

let handle: Database_;

function db() {
  return handle.db;
}

function member(): MemberRow {
  const row: MemberRow = {
    id: '1529717434259345489',
    username: 'kazuhiro-tokumoto',
    displayName: 'トクモト',
    status: 'active',
    createdAt: T0,
    activatedAt: T0,
  };
  db().insert(members).values(row).run();
  return row;
}

async function makeWallet() {
  const actor = member();
  const created = await createWallet(db(), {
    network: 'regtest',
    passphrase: PASSPHRASE,
    actorMemberId: actor.id,
    now: T0,
  });
  if (!created.ok) throw new Error(created.reason);
  return created;
}

/** 決め打ちの応答を返すノード。 */
function fakeNode(scan: Partial<ScanResult> = {}, fail?: string): RpcClient {
  const result: ScanResult = { utxos: [], total: 0n, truncated: false, ...scan };
  return {
    call: () => Promise.reject(new Error('使いません')),
    getInfo: () =>
      fail === undefined
        ? Promise.resolve({ network: 'regtest', height: 42, bestHash: 'aa', difficulty: '1' })
        : Promise.reject(new Error(fail)),
    getBlockCount: () => Promise.resolve(42),
    scanUtxos: () => Promise.resolve(result),
    sendRawTransaction: () => Promise.resolve('txid'),
  };
}

beforeEach(() => {
  handle = openTestDatabase();
});

describe('金額の表し方', () => {
  it('最小単位から小数 16 桁として読む', () => {
    expect(formatOag(10n ** 16n)).toBe('1');
    expect(formatOag(15n * 10n ** 15n)).toBe('1.5');
    expect(formatOag(1n)).toBe('0.0000000000000001');
    expect(formatOag(0n)).toBe('0');
  });

  it('大きな数は 3 桁で区切る', () => {
    expect(formatOag(1234567n * 10n ** 16n)).toBe('1,234,567');
  });

  it('入力を最小単位に直す', () => {
    expect(parseOag('1')).toBe(10n ** 16n);
    expect(parseOag('1.5')).toBe(15n * 10n ** 15n);
    expect(parseOag(' 1,000 ')).toBe(1000n * 10n ** 16n);
  });

  it('表した値を読み直しても変わらない', () => {
    const value = 123_456_789_012_345_678n;
    expect(parseOag(formatOag(value))).toBe(value);
  });

  it('桁が多すぎるものは切り捨てずに断る', () => {
    expect(() => parseOag('0.00000000000000001')).toThrow(AmountError);
    expect(() => parseOag('abc')).toThrow(AmountError);
    expect(() => parseOag('-1')).toThrow(AmountError);
  });
});

describe('ウォレットの作成', () => {
  it('控えは封じた形でしか残らない', async () => {
    const created = await makeWallet();
    const row = getWallet(db());

    expect(created.mnemonic.split(' ')).toHaveLength(12);
    expect(row?.xpub).toBe(created.xpub);
    // 控えの語が平文で混ざっていないことを確かめる。
    const stored = row?.vault.toString('utf8') ?? '';
    for (const word of created.mnemonic.split(' ')) {
      expect(stored).not.toContain(word);
    }
    expect(verifyAuditLog(db()).ok).toBe(true);
  });

  it('二度目は断る', async () => {
    await makeWallet();
    const again = await createWallet(db(), {
      network: 'regtest',
      passphrase: PASSPHRASE,
      actorMemberId: '1529717434259345489',
      now: T0,
    });

    expect(again.ok).toBe(false);
    expect(hasWallet(db())).toBe(true);
  });

  it('短いパスフレーズは受け付けない', async () => {
    member();
    const created = await createWallet(db(), {
      network: 'regtest',
      passphrase: 'みじかい',
      actorMemberId: '1529717434259345489',
      now: T0,
    });

    expect(created.ok).toBe(false);
    expect(hasWallet(db())).toBe(false);
  });
});

describe('住所', () => {
  it('拡張公開鍵だけでその網の住所を作れる', async () => {
    await makeWallet();
    const row = getWallet(db());
    if (row === undefined) throw new Error('ウォレットがありません');

    const [first, second] = addressesOf(row, { count: 2 });
    expect(first?.address).not.toBe(second?.address);
    expect(decodeAddress('regtest', first?.address ?? '').version).toBe(0);
  });

  it('配るたびに次の番号へ進む', async () => {
    await makeWallet();

    const first = issueReceiveAddress(db(), { actorMemberId: '1529717434259345489', now: T0 });
    const second = issueReceiveAddress(db(), { actorMemberId: '1529717434259345489', now: T0 });

    expect('address' in first && 'address' in second).toBe(true);
    if (!('address' in first) || !('address' in second)) return;
    expect(first.index).toBe(0);
    expect(second.index).toBe(1);
    expect(first.address).not.toBe(second.address);
    expect(getWallet(db())?.nextReceive).toBe(2);
  });

  it('見張る範囲は配った先 GAP_LIMIT 個まで、受取とお釣りの両方', async () => {
    await makeWallet();
    issueReceiveAddress(db(), { actorMemberId: '1529717434259345489', now: T0 });

    const row = getWallet(db());
    if (row === undefined) throw new Error('ウォレットがありません');
    const watched = watchedAddresses(row);

    expect(watched).toHaveLength((1 + GAP_LIMIT) * 2);
    expect(new Set(watched).size).toBe(watched.length);
  });
});

describe('控えを開く', () => {
  it('正しいパスフレーズなら秘密鍵を取り出せる', async () => {
    await makeWallet();
    const opened = await unlockWallet(db(), PASSPHRASE);

    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.privateKeyAt({ index: 0 })).toHaveLength(32);
  });

  it('違うパスフレーズでは開かない', async () => {
    await makeWallet();
    const opened = await unlockWallet(db(), 'chigau-aikotoba-999');
    expect(opened.ok).toBe(false);
  });

  it('ウォレットが無ければ開けない', async () => {
    const opened = await unlockWallet(db(), PASSPHRASE);
    expect(opened.ok).toBe(false);
  });
});

describe('残高', () => {
  it('ウォレットが無ければ何も出さない', async () => {
    const status = await readWalletStatus(db(), fakeNode());
    expect(status.present).toBe(false);
    expect(status.balance).toBeUndefined();
  });

  it('ノードの設定が無ければ、その旨を返す', async () => {
    await makeWallet();
    const status = await readWalletStatus(db(), undefined);

    expect(status.present).toBe(true);
    expect(status.connected).toBe(false);
    expect(status.error).toContain('設定');
  });

  it('繋がれば高さと合計を返す', async () => {
    await makeWallet();
    const status = await readWalletStatus(db(), fakeNode({ total: 5n * 10n ** 16n }));

    expect(status.connected).toBe(true);
    expect(status.height).toBe(42);
    expect(status.balance).toBe(5n * 10n ** 16n);
  });

  it('打ち切られた応答は残高として出さない', async () => {
    await makeWallet();
    const status = await readWalletStatus(db(), fakeNode({ total: 1n, truncated: true }));

    expect(status.truncated).toBe(true);
    expect(status.balance).toBeUndefined();
    expect(status.error).toContain('打ち切');
  });

  it('ノードが落ちていても例外にしない', async () => {
    await makeWallet();
    const status = await readWalletStatus(db(), fakeNode({}, 'ECONNREFUSED'));

    expect(status.connected).toBe(false);
    expect(status.error).toContain('ECONNREFUSED');
  });
});
