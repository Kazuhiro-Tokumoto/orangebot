import { schnorr } from '@noble/curves/secp256k1.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { verifyAuditLog } from '../db/audit.js';
import { openTestDatabase, type Database_ } from '../db/client.js';
import { members } from '../db/schema.js';
import { createProposal } from '../domain/proposals.js';
import { decodeAddress, encodeAddress } from './address.js';
import { RpcError, type RpcClient, type ScanResult, type Utxo } from './rpc.js';
import { executeSend, getSendForProposal } from './send.js';
import { CHANGE_INTERNAL } from './seed.js';
import { addressesOf, createWallet, getWallet } from './store.js';
import {
  COINBASE_MATURITY,
  decodeTransaction,
  fromHex,
  toHex,
  txid,
  verifySigned,
  type Transaction,
} from './tx.js';

const T0 = 1_700_000_000_000;
const OAG = 10n ** 16n;
const ME = '1529717434259345489';
const PASSPHRASE = 'kagi-no-aikotoba-123';
const FAST_KDF = { memoryCost: 8192, timeCost: 2, parallelism: 1 };

/** よそ者の宛先。 */
const STRANGER = encodeAddress('regtest', schnorr.getPublicKey(new Uint8Array(32).fill(7)));

let handle: Database_;

function db() {
  return handle.db;
}

/**
 * 小さなノード。
 *
 * UTXO の集合と mempool を持ち、送られた取引を本物のノードと同じ観点で検める。
 * 入力が存在するか、mempool の他の取引と入力がぶつからないか、署名が通るか。
 */
class FakeNode implements RpcClient {
  height = 500;
  readonly utxos = new Map<string, Utxo>();
  readonly mempool = new Map<string, Transaction>();
  truncated = false;
  /** 次の送信を、はっきり断る (reject) か、受け付けたのに応答だけ落とす (lost)。 */
  nextFailure: 'reject' | 'lost' | undefined;

  fund(address: string, amount: bigint, options: Partial<Utxo> = {}): void {
    const n = this.utxos.size + 1;
    const utxo: Utxo = {
      txid: toHex(new Uint8Array(32).fill(n)),
      vout: n,
      address,
      amount,
      height: 10,
      coinbase: false,
      ...options,
    };
    this.utxos.set(`${utxo.txid}:${String(utxo.vout)}`, utxo);
  }

  call<T>(): Promise<T> {
    return Promise.reject(new Error('使いません'));
  }

  getInfo() {
    return Promise.resolve({ network: 'regtest', height: this.height, bestHash: '', difficulty: '' });
  }

  getBlockCount() {
    return Promise.resolve(this.height);
  }

  getMempool() {
    return Promise.resolve([...this.mempool.keys()]);
  }

  scanUtxos(addresses: readonly string[]): Promise<ScanResult> {
    const wanted = new Set(addresses);
    const utxos = [...this.utxos.values()].filter((utxo) => wanted.has(utxo.address));
    return Promise.resolve({
      utxos,
      total: utxos.reduce((sum, utxo) => sum + utxo.amount, 0n),
      truncated: this.truncated,
    });
  }

  sendRawTransaction(hex: string): Promise<string> {
    const failure = this.nextFailure;
    this.nextFailure = undefined;
    if (failure === 'reject') return Promise.reject(new RpcError('手数料が足りない', -26));

    const tx = decodeTransaction(fromHex(hex, 'tx'));
    const id = txid(tx);
    if (this.mempool.has(id)) return Promise.reject(new RpcError('既に mempool にある', -27));

    const spentByMempool = new Set(
      [...this.mempool.values()].flatMap((other) =>
        other.inputs.map((input) => `${toHex(input.prevOut.txid)}:${String(input.prevOut.index)}`),
      ),
    );

    const spent = tx.inputs.map((input) => {
      const key = `${toHex(input.prevOut.txid)}:${String(input.prevOut.index)}`;
      const utxo = this.utxos.get(key);
      if (utxo === undefined) throw new RpcError(`無い出力を使っている: ${key}`, -25);
      if (spentByMempool.has(key)) throw new RpcError(`mempool の取引と入力がぶつかる: ${key}`, -26);
      if (utxo.coinbase && this.height + 1 < (utxo.height ?? 0) + Number(COINBASE_MATURITY)) {
        throw new RpcError('成熟していないコインベース', -26);
      }
      return {
        amount: utxo.amount,
        lock: { version: 0, payload: decodeAddress('regtest', utxo.address).payload },
      };
    });
    verifySigned(tx, spent);

    this.mempool.set(id, tx);
    if (failure === 'lost') return Promise.reject(new RpcError('ECONNRESET'));
    return Promise.resolve(id);
  }

  /** mempool をブロックに入れる。 */
  mine(): void {
    for (const [id, tx] of this.mempool) {
      for (const input of tx.inputs) {
        this.utxos.delete(`${toHex(input.prevOut.txid)}:${String(input.prevOut.index)}`);
      }
      tx.outputs.forEach((output, index) => {
        const utxo: Utxo = {
          txid: id,
          vout: index,
          address: encodeAddress('regtest', output.lock.payload),
          amount: output.amount,
          height: this.height + 1,
          coinbase: false,
        };
        this.utxos.set(`${id}:${String(index)}`, utxo);
      });
    }
    this.mempool.clear();
    this.height += 1;
  }
}

async function setup(): Promise<string> {
  db()
    .insert(members)
    .values({
      id: ME,
      username: 'kazuhiro-tokumoto',
      displayName: 'トクモト',
      status: 'active',
      createdAt: T0,
      activatedAt: T0,
    })
    .run();
  const created = await createWallet(db(), {
    network: 'regtest',
    passphrase: PASSPHRASE,
    actorMemberId: ME,
    kdf: FAST_KDF,
    now: T0,
  });
  if (!created.ok) throw new Error(created.reason);

  const wallet = getWallet(db());
  if (wallet === undefined) throw new Error('ウォレットがありません');
  const [first] = addressesOf(wallet, { count: 1 });
  if (first === undefined) throw new Error('住所がありません');
  return first.address;
}

function propose(amount: string, to = STRANGER): string {
  const result = createProposal(db(), {
    type: 'wallet.send',
    proposedBy: ME,
    payload: { to, amount, memo: '試験' },
    now: T0,
  });
  if (!result.ok) throw new Error(result.reason);
  return result.view.id;
}

function send(proposalId: string, node: RpcClient, passphrase = PASSPHRASE) {
  return executeSend(db(), node, { proposalId, passphrase, actorMemberId: ME, now: T0 });
}

let node: FakeNode;
let receive: string;

beforeEach(async () => {
  handle = openTestDatabase();
  node = new FakeNode();
  receive = await setup();
});

describe('送金の提案', () => {
  it('1 人なら出した時点で可決し、送金が許可される', () => {
    const result = createProposal(db(), {
      type: 'wallet.send',
      proposedBy: ME,
      payload: { to: STRANGER, amount: '1.5' },
      now: T0,
    });
    expect(result.ok && result.view.status).toBe('executed');
    expect(result.ok && result.view.summary).toContain('1.5 OAG');
  });

  it('別のネットワークの住所には提案できない', () => {
    const mainnet = encodeAddress('mainnet', schnorr.getPublicKey(new Uint8Array(32).fill(7)));
    const result = createProposal(db(), {
      type: 'wallet.send',
      proposedBy: ME,
      payload: { to: mainnet, amount: '1' },
      now: T0,
    });
    expect(result.ok).toBe(false);
  });

  it('ダスト未満の額は提案できない', () => {
    const result = createProposal(db(), {
      type: 'wallet.send',
      proposedBy: ME,
      payload: { to: STRANGER, amount: '0.001' },
      now: T0,
    });
    expect(result.ok).toBe(false);
  });
});

describe('送金', () => {
  it('組み立てて署名し、ノードが受け付ける', async () => {
    node.fund(receive, 10n * OAG);
    const proposalId = propose('3');

    const result = await send(proposalId, node);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.send.status).toBe('broadcast');
    expect(node.mempool.has(result.send.txid)).toBe(true);

    const tx = node.mempool.get(result.send.txid);
    const wallet = getWallet(db());
    if (tx === undefined || wallet === undefined) throw new Error('取引がありません');
    const [changeAddress] = addressesOf(wallet, { change: CHANGE_INTERNAL, count: 1 });

    expect(encodeAddress('regtest', tx.outputs[0]?.lock.payload ?? new Uint8Array())).toBe(STRANGER);
    expect(tx.outputs[0]?.amount).toBe(3n * OAG);
    expect(encodeAddress('regtest', tx.outputs[1]?.lock.payload ?? new Uint8Array())).toBe(
      changeAddress?.address,
    );
    expect(BigInt(result.send.fee) + BigInt(result.send.change) + 3n * OAG).toBe(10n * OAG);
    expect(wallet.nextChange).toBe(1);
    expect(verifyAuditLog(db()).ok).toBe(true);
  });

  it('パスフレーズが違えば何も記録しない', async () => {
    node.fund(receive, 10n * OAG);
    const proposalId = propose('3');

    const result = await send(proposalId, node, 'chigau-aikotoba-999');
    expect(result.ok).toBe(false);
    expect(getSendForProposal(db(), proposalId)).toBeUndefined();
    expect(node.mempool.size).toBe(0);
  });

  it('可決していない提案では送れない', async () => {
    db()
      .insert(members)
      .values({
        id: '1700000000000000001',
        username: 'bravo',
        displayName: 'ブラボー',
        status: 'active',
        createdAt: T0,
        activatedAt: T0,
      })
      .run();
    node.fund(receive, 10n * OAG);
    const proposalId = propose('3');

    const result = await send(proposalId, node);
    expect(result.ok).toBe(false);
    expect(node.mempool.size).toBe(0);
  });

  it('二度押しても取引は 1 つ', async () => {
    node.fund(receive, 10n * OAG);
    const proposalId = propose('3');

    const first = await send(proposalId, node);
    const second = await send(proposalId, node);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.send.txid).toBe(first.send.txid);
    expect(node.mempool.size).toBe(1);
  });

  it('応答が落ちたら、作り直さずに同じ取引を送り直す', async () => {
    node.fund(receive, 10n * OAG);
    node.fund(receive, 10n * OAG);
    const proposalId = propose('3');

    node.nextFailure = 'lost';
    const lost = await send(proposalId, node);
    expect(lost.ok).toBe(false);
    const recorded = getSendForProposal(db(), proposalId);
    expect(recorded?.status).toBe('unknown');

    const retried = await send(proposalId, node);
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.rebroadcast).toBe(true);
    expect(retried.send.txid).toBe(recorded?.txid);
    expect(retried.send.status).toBe('broadcast');
    expect(node.mempool.size).toBe(1);
  });

  it('ノードがはっきり断ったら、作り直してよい', async () => {
    node.fund(receive, 10n * OAG);
    const proposalId = propose('3');

    node.nextFailure = 'reject';
    const rejected = await send(proposalId, node);
    expect(rejected.ok).toBe(false);
    expect(getSendForProposal(db(), proposalId)?.status).toBe('failed');

    const again = await send(proposalId, node);
    expect(again.ok).toBe(true);
    expect(node.mempool.size).toBe(1);
  });

  it('未確定の送金が使っている入力は、次の送金で使わない', async () => {
    node.fund(receive, 10n * OAG);
    node.fund(receive, 8n * OAG);

    const first = await send(propose('3'), node);
    const second = await send(propose('3'), node);

    expect(first.ok && second.ok).toBe(true);
    // ぶつかる入力があれば、偽のノードが二つ目を断っているはず。
    expect(node.mempool.size).toBe(2);
  });

  it('ブロックに入った後は、お釣りも使える', async () => {
    node.fund(receive, 10n * OAG);

    const first = await send(propose('3'), node);
    expect(first.ok).toBe(true);
    node.mine();

    const second = await send(propose('5'), node);
    expect(second.ok).toBe(true);
    expect(node.mempool.size).toBe(1);
    expect(getWallet(db())?.nextChange).toBe(2);
  });

  it('残高が足りなければ何も記録しない', async () => {
    node.fund(receive, 1n * OAG);
    const proposalId = propose('3');

    const result = await send(proposalId, node);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('残高が足りません');
    expect(getSendForProposal(db(), proposalId)).toBeUndefined();
    expect(getWallet(db())?.nextChange).toBe(0);
  });

  it('成熟していないコインベースは使わない', async () => {
    node.fund(receive, 100n * OAG, { coinbase: true, height: node.height });
    const result = await send(propose('3'), node);
    expect(result.ok).toBe(false);
  });

  it('ノードが数え切れなかったときは組み立てない', async () => {
    node.fund(receive, 10n * OAG);
    node.truncated = true;
    const result = await send(propose('3'), node);
    expect(result.ok).toBe(false);
    expect(node.mempool.size).toBe(0);
  });

  it('ノードの設定が無ければ送れない', async () => {
    const result = await executeSend(db(), undefined, {
      proposalId: propose('3'),
      passphrase: PASSPHRASE,
      actorMemberId: ME,
    });
    expect(result.ok).toBe(false);
  });
});
