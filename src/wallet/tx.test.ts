import { schnorr } from '@noble/curves/secp256k1.js';
import { describe, expect, it } from 'vitest';
import { encodeAddress } from './address.js';
import {
  COINBASE_MATURITY,
  DUST_THRESHOLD,
  MIN_RELAY_FEE_RATE,
  TxError,
  buildPayment,
  decodeTransaction,
  encodeTransaction,
  fromHex,
  sighash,
  signDraft,
  toHex,
  txid,
  verifySigned,
  type Coin,
  type Lock,
  type SighashType,
  type Transaction,
  type TxOutput,
} from './tx.js';

/**
 * Orange 本体 (crates/oag-consensus, oag-primitives) をビルドして出した値。
 * 鍵は blake3("alice") のように種の文字列の BLAKE3 から作ってある。
 * ここと一致しなければ、ノードは取引を断る。
 */
const RUST = {
  aliceSecret: '71b278f3dc434447fc620500e47b6a80b0cb0df76a1051119fe19ed4953242df',
  bobSecret: 'e476f1b379438de7a1acfd567a94a8c53f08b9714042f7f17e5791645afc3176',
  carolSecret: 'aa9d603439c50c73783d66b2725e26ced4311e8d1f18e840dc3c13f360092545',
  alicePubkey: 'c5271b525d8cfc73868af54da697fe4027915940e34b630d12edea8828116995',
  carolAddressRegtest: 'roag1q7naqtv249w8ugkt8us6pwg72x8unymnzzkfrkjczt09nlzpxt6gqvgxnyf',
  unsignedHex:
    '010000000211111111111111111111111111111111111111111111111111111111111111110000ffffffff2222222222222222222222222222222222222222222222222222222222222222ac0200feffffff02808084fea6dee1110020f4fa05b1552b8fc45967e4341723ca31f9326e6215923b4b025bcb3f88265e9080c0cbdbe8b6e1c6200020c5271b525d8cfc73868af54da697fe4027915940e34b630d12edea882811699500',
  unsignedTxid: 'ab105514285d432405f7bce39fd2057dfe406fe4887ec6bd180b18a19a2afdb1',
  sighash: {
    default: [
      '1f5c2772e904b6a084b1094197cf2409ecf83d46e96d1404c7dcc541d20da949',
      'f921106b8e7d3fc541709e73da13719e534e0ffcf6b6f0074900885d590e1b6c',
    ],
    all: [
      'dfdf13a6b09f5d093d686cc4fdec03570786e938427e734c8ab6c7948c7d4584',
      '16cc3514f6687a124a749d913fec2f41961c1d4ebf57e44f8a560977f8443b67',
    ],
    none: [
      'c3bac6bc9cad3af9eb10b8094221d65e3b1ca065a2a72954156790fcac31e320',
      '010808e6ec937809077c9fafe41671b40680f6917ad87e888d3c2aca2a440598',
    ],
    single: [
      'b8c310e99ad17dd2da60ddaef668e98f53ab95737f425e4beb15ce95e60b30f7',
      'df586dc27b65bfe8ec44845cca694c70d91c131b0c35e1216b66effc6a40df50',
    ],
    allAnyoneCanPay: [
      '0745af280a4385a4055dc26ad0f0c42cb061462f3e96885b36a09648f49b8e3f',
      '20d7f5eafa5fa3818b4fa37a742a6737c614aef0bdeed08db5c9bd1beebb4efa',
    ],
  },
  sig0: '638b8b50fd7d9ca4d34c94d49b5aae84009116e7f3607dda4738e927716548081b885ee01956250d00f2b5f7ad3f90f2b4566a1bc8490e57da31e8699a9edfbc',
  sig1: '1401fec6d2e5cefe9c8172a45cb9afffe0249ac6e427efdb5cc3122ccbbb1f71e9fbfc2b4ce973ffb2cbb5f3591650277e43642b253d7b2f62e94f658058d177',
  signedHex:
    '010000000211111111111111111111111111111111111111111111111111111111111111110040638b8b50fd7d9ca4d34c94d49b5aae84009116e7f3607dda4738e927716548081b885ee01956250d00f2b5f7ad3f90f2b4566a1bc8490e57da31e8699a9edfbcffffffff2222222222222222222222222222222222222222222222222222222222222222ac02401401fec6d2e5cefe9c8172a45cb9afffe0249ac6e427efdb5cc3122ccbbb1f71e9fbfc2b4ce973ffb2cbb5f3591650277e43642b253d7b2f62e94f658058d177feffffff02808084fea6dee1110020f4fa05b1552b8fc45967e4341723ca31f9326e6215923b4b025bcb3f88265e9080c0cbdbe8b6e1c6200020c5271b525d8cfc73868af54da697fe4027915940e34b630d12edea882811699500',
  signedTxid: '1a1419d8256445b1a6033d73add5dd8d8f60c0307e0b54c4b344e80339bed4e9',
  signedSize: 297,
};

function lockOf(secretHex: string): Lock {
  return { version: 0, payload: schnorr.getPublicKey(fromHex(secretHex, 'key')) };
}

/** Rust 側で値を出したときと同じ取引。 */
function fixture(): { tx: Transaction; spent: TxOutput[] } {
  const spent: TxOutput[] = [
    { amount: 12_345_678_901_234_567_890n, lock: lockOf(RUST.aliceSecret) },
    { amount: 15_000_000_000_000n, lock: lockOf(RUST.bobSecret) },
  ];
  const tx: Transaction = {
    version: 1,
    inputs: [
      {
        prevOut: { txid: new Uint8Array(32).fill(0x11), index: 0 },
        signature: new Uint8Array(),
        sequence: 0xffff_ffff,
      },
      {
        prevOut: { txid: new Uint8Array(32).fill(0x22), index: 300 },
        signature: new Uint8Array(),
        sequence: 0xffff_fffe,
      },
    ],
    outputs: [
      { amount: 10_000_000_000_000_000n, lock: lockOf(RUST.carolSecret) },
      { amount: 2_345_678_000_000_000_000n, lock: lockOf(RUST.aliceSecret) },
    ],
    locktime: 0n,
  };
  return { tx, spent };
}

const TYPES: Record<keyof typeof RUST.sighash, SighashType> = {
  default: { base: 'all', anyoneCanPay: false, defaultForm: true },
  all: { base: 'all', anyoneCanPay: false, defaultForm: false },
  none: { base: 'none', anyoneCanPay: false, defaultForm: false },
  single: { base: 'single', anyoneCanPay: false, defaultForm: false },
  allAnyoneCanPay: { base: 'all', anyoneCanPay: true, defaultForm: false },
};

function withSignatures(tx: Transaction, signatures: readonly string[]): Transaction {
  return {
    ...tx,
    inputs: tx.inputs.map((input, index) => ({
      ...input,
      signature: fromHex(signatures[index] ?? '', 'sig'),
    })),
  };
}

describe('Orange 本体との一致', () => {
  it('鍵と住所が同じになる', () => {
    expect(toHex(lockOf(RUST.aliceSecret).payload)).toBe(RUST.alicePubkey);
    expect(encodeAddress('regtest', lockOf(RUST.carolSecret).payload)).toBe(
      RUST.carolAddressRegtest,
    );
  });

  it('未署名の取引の符号化と txid', () => {
    const { tx } = fixture();
    expect(toHex(encodeTransaction(tx))).toBe(RUST.unsignedHex);
    expect(txid(tx)).toBe(RUST.unsignedTxid);
  });

  it('すべての種別の sighash', () => {
    const { tx, spent } = fixture();
    for (const name of Object.keys(TYPES) as (keyof typeof RUST.sighash)[]) {
      const type = TYPES[name];
      expect(toHex(sighash(tx, spent, 0, type)), name).toBe(RUST.sighash[name][0]);
      expect(toHex(sighash(tx, spent, 1, type)), name).toBe(RUST.sighash[name][1]);
    }
  });

  it('補助乱数なしの署名がバイト単位で一致する', () => {
    const { tx, spent } = fixture();
    const zero = new Uint8Array(32);
    const s0 = schnorr.sign(sighash(tx, spent, 0), fromHex(RUST.aliceSecret, 'k'), zero);
    const s1 = schnorr.sign(sighash(tx, spent, 1), fromHex(RUST.bobSecret, 'k'), zero);
    expect(toHex(s0)).toBe(RUST.sig0);
    expect(toHex(s1)).toBe(RUST.sig1);
  });

  it('署名済みの取引の符号化、txid、大きさ', () => {
    const { tx, spent } = fixture();
    const signed = withSignatures(tx, [RUST.sig0, RUST.sig1]);

    expect(toHex(encodeTransaction(signed))).toBe(RUST.signedHex);
    expect(txid(signed)).toBe(RUST.signedTxid);
    expect(encodeTransaction(signed).length).toBe(RUST.signedSize);
    expect(() => verifySigned(signed, spent)).not.toThrow();
  });

  it('本体の出した取引を読み戻せる', () => {
    const decoded = decodeTransaction(fromHex(RUST.signedHex, 'tx'));
    expect(toHex(encodeTransaction(decoded))).toBe(RUST.signedHex);
    expect(decoded.inputs[1]?.prevOut.index).toBe(300);
    expect(decoded.outputs[0]?.amount).toBe(10_000_000_000_000_000n);
  });
});

describe('復号の厳しさ', () => {
  it('最短形でない varint を断る', () => {
    // 入力数 0 を 0x80 0x00 と冗長に書く。
    expect(() => decodeTransaction(fromHex('01000000' + '8000' + '00' + '00', 'tx'))).toThrow(
      TxError,
    );
  });

  it('入らない個数の宣言を断る', () => {
    expect(() => decodeTransaction(fromHex('01000000' + '32' + '00'.repeat(100), 'tx'))).toThrow(
      /個数/,
    );
  });

  it('余ったバイトを断る', () => {
    expect(() => decodeTransaction(fromHex(RUST.signedHex + '00', 'tx'))).toThrow(/余って/);
  });
});

describe('組み立て', () => {
  const OAG = 10n ** 16n;
  const payer = RUST.aliceSecret;

  function coin(amount: bigint, n: number, options: Partial<Coin> = {}): Coin {
    return {
      outPoint: { txid: new Uint8Array(32).fill(n), index: n },
      output: { amount, lock: lockOf(payer) },
      height: 1n,
      isCoinbase: false,
      ...options,
    };
  }

  function spend(amount: bigint) {
    return {
      to: lockOf(RUST.carolSecret),
      amount,
      changeTo: lockOf(RUST.bobSecret),
      nextHeight: 1000n,
      feeRate: MIN_RELAY_FEE_RATE,
    };
  }

  it('お釣りを作り、手数料は実物の大きさに料率を掛けた額以上', () => {
    const draft = buildPayment([coin(10n * OAG, 1)], spend(3n * OAG));
    const size = BigInt(encodeTransaction(draft.tx).length);

    expect(draft.tx.outputs).toHaveLength(2);
    expect(draft.fee).toBeGreaterThanOrEqual(size * MIN_RELAY_FEE_RATE);
    expect((draft.tx.outputs[0]?.amount ?? 0n) + draft.change + draft.fee).toBe(10n * OAG);
  });

  it('1 入力 2 出力の基準取引は 193 から 197 バイトに収まる (SPEC 7.2)', () => {
    const draft = buildPayment([coin(10n * OAG, 1)], spend(3n * OAG));
    const size = encodeTransaction(draft.tx).length;
    expect(size).toBeGreaterThanOrEqual(193);
    expect(size).toBeLessThanOrEqual(197);
  });

  it('大きい UTXO から使い、入力を少なく保つ', () => {
    const draft = buildPayment(
      [coin(1n * OAG, 1), coin(50n * OAG, 2), coin(2n * OAG, 3)],
      spend(5n * OAG),
    );
    expect(draft.tx.inputs).toHaveLength(1);
    expect(draft.tx.inputs[0]?.prevOut.index).toBe(2);
  });

  it('お釣りがダストになるなら作らず、手数料に回す', () => {
    const amount = 1n * OAG;
    const draft = buildPayment([coin(amount + DUST_THRESHOLD, 1)], spend(amount));
    expect(draft.tx.outputs).toHaveLength(1);
    expect(draft.change).toBe(0n);
    expect(draft.fee).toBe(DUST_THRESHOLD);
  });

  it('ダスト未満の送金を断る', () => {
    expect(() => buildPayment([coin(10n * OAG, 1)], spend(DUST_THRESHOLD - 1n))).toThrow(/ダスト/);
  });

  it('残高が足りなければ断る', () => {
    expect(() => buildPayment([coin(1n * OAG, 1)], spend(1n * OAG))).toThrow(/残高が足りません/);
  });

  it('成熟していないコインベースは使わない', () => {
    const young = coin(100n * OAG, 1, {
      isCoinbase: true,
      height: 1000n - COINBASE_MATURITY + 1n,
    });
    expect(() => buildPayment([young], spend(1n * OAG))).toThrow(/残高が足りません/);

    const grown = coin(100n * OAG, 1, { isCoinbase: true, height: 1000n - COINBASE_MATURITY });
    expect(buildPayment([grown], spend(1n * OAG)).tx.inputs).toHaveLength(1);
  });

  it('知らない版数の宛先には送らない', () => {
    expect(() =>
      buildPayment([coin(10n * OAG, 1)], {
        ...spend(1n * OAG),
        to: { version: 1, payload: new Uint8Array(32) },
      }),
    ).toThrow(/版数/);
  });

  it('署名を入れると検証に通り、大きさは下書きと変わらない', () => {
    const draft = buildPayment([coin(10n * OAG, 1), coin(1n * OAG, 2)], spend(10n * OAG));
    const signed = signDraft(draft, () => fromHex(payer, 'k'));

    expect(encodeTransaction(signed).length).toBe(encodeTransaction(draft.tx).length);
    expect(() => verifySigned(signed, draft.spent)).not.toThrow();
  });

  it('鍵が支払い条件と合わなければ署名を始めない', () => {
    const draft = buildPayment([coin(10n * OAG, 1)], spend(1n * OAG));
    expect(() => signDraft(draft, () => fromHex(RUST.bobSecret, 'k'))).toThrow(/合いません/);
  });

  it('署名の後で金額を書き換えると検証に通らない', () => {
    const draft = buildPayment([coin(10n * OAG, 1)], spend(1n * OAG));
    const signed = signDraft(draft, () => fromHex(payer, 'k'));
    const tampered: Transaction = {
      ...signed,
      outputs: signed.outputs.map((output, index) =>
        index === 0 ? { ...output, amount: 2n * OAG } : output,
      ),
    };
    expect(() => verifySigned(tampered, draft.spent)).toThrow(/検証/);
  });
});
