import { schnorr } from '@noble/curves/secp256k1.js';
import { blake3 } from '@noble/hashes/blake3.js';

/**
 * OAG のトランザクション。
 *
 * Orange 本体 (crates/oag-consensus) の符号化と sighash をそのまま移したもの。
 * 1 バイトでも食い違えば、ノードは署名を無効として断る。資金が消えることは
 * 無いが、送金ができない。そのため本体をビルドして出した値と突き合わせる
 * 試験を tx.test.ts に置いてある。ここを変えたら必ずそれを通すこと。
 *
 * 参照: Orange docs/SPEC.md §2, §3, §7, §8, §13
 */

/** 1 OAG = 10^16 atomic。 */
export const ATOMIC_PER_OAG = 10n ** 16n;
/** 総発行量。これを超える金額は存在しない (SPEC §3)。 */
export const MAX_SUPPLY_ATOMIC = 1_000_000_000n * ATOMIC_PER_OAG;
/** 中継される最低の料率 (atomic / バイト)。ノードの既定値 (SPEC §13.2)。 */
export const MIN_RELAY_FEE_RATE = 50_000_000_000n;
/** これ未満の出力を含む取引は中継されない (SPEC §13.3)。 */
export const DUST_THRESHOLD = 15_000_000_000_000n;
/** コインベースはこのブロック数を経るまで使えない。 */
export const COINBASE_MATURITY = 120n;
export const MAX_TX_SIZE = 100_000;
export const CURRENT_TX_VERSION = 1;
export const SEQUENCE_FINAL = 0xffff_ffff;
/** 版数 0 = Schnorr x-only 公開鍵への支払い。 */
export const LOCK_VERSION_PUBKEY = 0;

const MAX_VARINT_LEN = 19;
const MAX_INPUT_SIGNATURE_LEN = 100;
const MIN_PAYLOAD_LEN = 2;
const MAX_PAYLOAD_LEN = 40;

export class TxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TxError';
  }
}

// --- 型 -------------------------------------------------------------------

export interface Lock {
  readonly version: number;
  readonly payload: Uint8Array;
}

export interface TxOutput {
  readonly amount: bigint;
  readonly lock: Lock;
}

export interface OutPoint {
  /** txid のバイト列。16 進表記の左から順に並ぶ (反転しない)。 */
  readonly txid: Uint8Array;
  readonly index: number;
}

export interface TxInput {
  readonly prevOut: OutPoint;
  readonly signature: Uint8Array;
  readonly sequence: number;
}

export interface Transaction {
  readonly version: number;
  readonly inputs: readonly TxInput[];
  readonly outputs: readonly TxOutput[];
  readonly locktime: bigint;
}

// --- 16 進 ----------------------------------------------------------------

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

export function fromHex(text: string, what: string): Uint8Array {
  if (text.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(text)) {
    throw new TxError(`${what} が 16 進表記ではありません`);
  }
  return new Uint8Array(Buffer.from(text, 'hex'));
}

// --- varint (LEB128、最短形のみ) ------------------------------------------

export function writeVarint(value: bigint | number, out: number[]): void {
  let v = BigInt(value);
  if (v < 0n) throw new TxError('varint に負の値は書けません');
  for (;;) {
    const byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v === 0n) {
      out.push(byte);
      return;
    }
    out.push(byte | 0x80);
  }
}

export function encodeVarint(value: bigint | number): Uint8Array {
  const out: number[] = [];
  writeVarint(value, out);
  return Uint8Array.from(out);
}

class Reader {
  private pos = 0;

  constructor(private readonly buf: Uint8Array) {}

  remaining(): number {
    return this.buf.length - this.pos;
  }

  take(n: number): Uint8Array {
    if (this.remaining() < n) throw new TxError('バイト列が途中で終わっています');
    const slice = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return slice;
  }

  u8(): number {
    const [byte] = this.take(1);
    if (byte === undefined) throw new TxError('バイト列が途中で終わっています');
    return byte;
  }

  u32(): number {
    return Buffer.from(this.take(4)).readUInt32LE(0);
  }

  varint(): bigint {
    let value = 0n;
    let shift = 0n;
    for (let i = 0; ; i += 1) {
      if (i >= MAX_VARINT_LEN) throw new TxError('varint が長すぎます');
      const byte = this.u8();
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        // 末尾の 0 は値全体が 1 バイトのときだけ正準。
        if (byte === 0 && i !== 0) throw new TxError('varint が最短形ではありません');
        return value;
      }
      shift += 7n;
    }
  }

  varintNumber(max: number, what: string): number {
    const value = this.varint();
    if (value > BigInt(max)) throw new TxError(`${what} が範囲外です`);
    return Number(value);
  }

  /** 個数を読む。その個数を入れるだけのバイトが残っていなければ断る (SPEC §2)。 */
  count(minItemLen: number, what: string): number {
    const value = this.varint();
    if (value * BigInt(minItemLen) > BigInt(this.remaining())) {
      throw new TxError(`${what} の個数が大きすぎます`);
    }
    return Number(value);
  }

  finish(): void {
    if (this.remaining() !== 0) throw new TxError('復号後にバイトが余っています');
  }
}

// --- 符号化 ---------------------------------------------------------------

function u32le(value: number): number[] {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0, 0);
  return [...buf];
}

function u64le(value: bigint): number[] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value, 0);
  return [...buf];
}

function writeBytes(bytes: Uint8Array, out: number[]): void {
  for (const byte of bytes) out.push(byte);
}

function writeLock(lock: Lock, out: number[]): void {
  out.push(lock.version);
  writeVarint(lock.payload.length, out);
  writeBytes(lock.payload, out);
}

function writeOutPoint(outPoint: OutPoint, out: number[]): void {
  writeBytes(outPoint.txid, out);
  writeVarint(outPoint.index, out);
}

function writeOutput(output: TxOutput, out: number[]): void {
  writeVarint(output.amount, out);
  writeLock(output.lock, out);
}

export function encodeTransaction(tx: Transaction): Uint8Array {
  const out: number[] = [];
  out.push(...u32le(tx.version));
  writeVarint(tx.inputs.length, out);
  for (const input of tx.inputs) {
    writeOutPoint(input.prevOut, out);
    writeVarint(input.signature.length, out);
    writeBytes(input.signature, out);
    out.push(...u32le(input.sequence));
  }
  writeVarint(tx.outputs.length, out);
  for (const output of tx.outputs) writeOutput(output, out);
  writeVarint(tx.locktime, out);
  return Uint8Array.from(out);
}

export function decodeTransaction(bytes: Uint8Array): Transaction {
  const reader = new Reader(bytes);
  const version = reader.u32();

  const inputCount = reader.count(38, '入力');
  const inputs: TxInput[] = [];
  for (let i = 0; i < inputCount; i += 1) {
    const txid = Uint8Array.from(reader.take(32));
    const index = reader.varintNumber(0xffff_ffff, 'prev_index');
    const sigLen = reader.varintNumber(MAX_INPUT_SIGNATURE_LEN, '署名の長さ');
    const signature = Uint8Array.from(reader.take(sigLen));
    const sequence = reader.u32();
    inputs.push({ prevOut: { txid, index }, signature, sequence });
  }

  const outputCount = reader.count(3, '出力');
  const outputs: TxOutput[] = [];
  for (let i = 0; i < outputCount; i += 1) {
    const amount = reader.varint();
    if (amount > MAX_SUPPLY_ATOMIC) throw new TxError('金額が総発行量を超えています');
    const lockVersion = reader.u8();
    const payloadLen = reader.varintNumber(MAX_PAYLOAD_LEN, 'payload の長さ');
    if (payloadLen < MIN_PAYLOAD_LEN) throw new TxError('payload が短すぎます');
    const payload = Uint8Array.from(reader.take(payloadLen));
    outputs.push({ amount, lock: { version: lockVersion, payload } });
  }

  const locktime = reader.varint();
  if (locktime > 0xffff_ffff_ffff_ffffn) throw new TxError('locktime が範囲外です');
  reader.finish();

  return { version, inputs, outputs, locktime };
}

// --- ハッシュ -------------------------------------------------------------

/** txid = BLAKE3(0x00 || 符号化)。署名を含むので、署名が入ると変わる。 */
export function txid(tx: Transaction): string {
  return toHex(blake3(Uint8Array.from([0x00, ...encodeTransaction(tx)])));
}

/** tagged(tag, msg) = BLAKE3(tag || 0x00 || msg) (SPEC §8.0)。 */
export function tagged(tag: string, data: Uint8Array | readonly number[]): Uint8Array {
  const hasher = blake3.create();
  hasher.update(new TextEncoder().encode(tag));
  hasher.update(Uint8Array.of(0x00));
  hasher.update(Uint8Array.from(data));
  return hasher.digest();
}

// --- sighash --------------------------------------------------------------

export type SighashBase = 'all' | 'none' | 'single';

export interface SighashType {
  readonly base: SighashBase;
  readonly anyoneCanPay: boolean;
  /** 0x00 の既定形式。ALL と同じ範囲にコミットし、署名は 64 バイト。 */
  readonly defaultForm: boolean;
}

export const SIGHASH_DEFAULT: SighashType = { base: 'all', anyoneCanPay: false, defaultForm: true };

export function sighashByte(type: SighashType): number {
  if (type.defaultForm) return 0x00;
  const base = type.base === 'all' ? 0x01 : type.base === 'none' ? 0x02 : 0x03;
  return type.anyoneCanPay ? base | 0x80 : base;
}

/**
 * input_index 番目の入力の署名対象。
 * spent は各入力が使う出力を、入力と同じ順に並べたもの。
 */
export function sighash(
  tx: Transaction,
  spent: readonly TxOutput[],
  inputIndex: number,
  type: SighashType = SIGHASH_DEFAULT,
): Uint8Array {
  if (spent.length !== tx.inputs.length) {
    throw new TxError('使う出力の数が入力の数と合いません');
  }
  const input = tx.inputs[inputIndex];
  const own = spent[inputIndex];
  if (input === undefined || own === undefined) throw new TxError('入力番号が範囲外です');

  const msg: number[] = [0x00, sighashByte(type), ...u32le(tx.version), ...u64le(tx.locktime)];

  if (!type.anyoneCanPay) {
    const prevouts: number[] = [];
    const amounts: number[] = [];
    const locks: number[] = [];
    const sequences: number[] = [];
    tx.inputs.forEach((each, index) => {
      const output = spent[index];
      if (output === undefined) throw new TxError('使う出力が足りません');
      writeOutPoint(each.prevOut, prevouts);
      writeVarint(output.amount, amounts);
      writeLock(output.lock, locks);
      sequences.push(...u32le(each.sequence));
    });
    msg.push(...tagged('OAG/sighash/prevouts', prevouts));
    msg.push(...tagged('OAG/sighash/amounts', amounts));
    msg.push(...tagged('OAG/sighash/locks', locks));
    msg.push(...tagged('OAG/sighash/sequences', sequences));
  }

  if (type.base === 'all') {
    const outputs: number[] = [];
    writeVarint(tx.outputs.length, outputs);
    for (const output of tx.outputs) writeOutput(output, outputs);
    msg.push(...tagged('OAG/sighash/outputs', outputs));
  } else if (type.base === 'single') {
    const matching = tx.outputs[inputIndex];
    if (matching === undefined) throw new TxError('SINGLE に対応する出力がありません');
    const buf: number[] = [];
    writeVarint(1, buf);
    writeOutput(matching, buf);
    msg.push(...tagged('OAG/sighash/outputs', buf));
  }

  msg.push(...u32le(inputIndex));

  if (type.anyoneCanPay) {
    writeOutPoint(input.prevOut, msg);
    writeVarint(own.amount, msg);
    writeLock(own.lock, msg);
    msg.push(...u32le(input.sequence));
  }

  return tagged('OAG/sighash', msg);
}

// --- 組み立て -------------------------------------------------------------

export interface Coin {
  readonly outPoint: OutPoint;
  readonly output: TxOutput;
  readonly height: bigint;
  readonly isCoinbase: boolean;
}

/** このブロックで使えるか。コインベースは成熟するまで使えない。 */
export function isSpendableAt(coin: Coin, height: bigint): boolean {
  return !coin.isCoinbase || height >= coin.height + COINBASE_MATURITY;
}

export interface Spend {
  readonly to: Lock;
  readonly amount: bigint;
  readonly changeTo: Lock;
  /** この取引が入りうる最初のブロックの高さ。コインベースの成熟判定に使う。 */
  readonly nextHeight: bigint;
  readonly feeRate: bigint;
}

export interface Draft {
  /** 署名欄は 0 で埋めてある。大きさを測るための場所取り。 */
  readonly tx: Transaction;
  readonly spent: readonly TxOutput[];
  readonly coins: readonly Coin[];
  readonly fee: bigint;
  readonly change: bigint;
}

const SIGNATURE_PLACEHOLDER = new Uint8Array(64);

function assembled(selected: readonly Coin[], spend: Spend, change: bigint | undefined): Transaction {
  const outputs: TxOutput[] = [{ amount: spend.amount, lock: spend.to }];
  if (change !== undefined) outputs.push({ amount: change, lock: spend.changeTo });
  return {
    version: CURRENT_TX_VERSION,
    inputs: selected.map((coin) => ({
      prevOut: coin.outPoint,
      signature: SIGNATURE_PLACEHOLDER,
      sequence: SEQUENCE_FINAL,
    })),
    outputs,
    locktime: 0n,
  };
}

function checkLock(lock: Lock, what: string): void {
  if (lock.version !== LOCK_VERSION_PUBKEY) {
    // 未知の版数は誰でも使える扱いになる (SPEC §10.4)。送れば資金を失う。
    throw new TxError(`${what}の版数 ${String(lock.version)} は扱えません`);
  }
  if (lock.payload.length !== 32) throw new TxError(`${what}の公開鍵が 32 バイトではありません`);
}

/**
 * 支払いを組み立てる。Orange の oag-wallet/src/build.rs と同じ手順。
 *
 * 使える UTXO を額の大きい順に 1 個ずつ足し、そのたびに実物を組んで大きさを測る。
 * お釣りの額はまだ決まらないので、符号化が最も長くなる額を仮に置いて測る。
 * お釣りがダストになるなら作らず、余りは手数料に回す。
 */
export function buildPayment(coins: readonly Coin[], spend: Spend): Draft {
  if (spend.amount <= 0n) throw new TxError('送る額は 0 より大きくしてください');
  if (spend.amount < DUST_THRESHOLD) {
    throw new TxError('送る額がダスト閾値 (0.0015 OAG) を下回ります。中継されません');
  }
  if (spend.amount > MAX_SUPPLY_ATOMIC) throw new TxError('送る額が総発行量を超えています');
  if (spend.feeRate < MIN_RELAY_FEE_RATE) throw new TxError('料率がノードの最低値を下回ります');
  checkLock(spend.to, '宛先');
  checkLock(spend.changeTo, 'お釣りの宛先');

  const usable = coins
    .filter((coin) => isSpendableAt(coin, spend.nextHeight))
    .sort((a, b) => (a.output.amount === b.output.amount ? 0 : a.output.amount > b.output.amount ? -1 : 1));

  let total = 0n;
  for (let take = 1; take <= usable.length; take += 1) {
    const selected = usable.slice(0, take);
    total += selected[take - 1]?.output.amount ?? 0n;
    if (total < spend.amount) continue;
    const surplus = total - spend.amount;

    const sizeWith = encodeTransaction(assembled(selected, spend, MAX_SUPPLY_ATOMIC)).length;
    const feeWith = spend.feeRate * BigInt(sizeWith);
    if (surplus >= feeWith && surplus - feeWith >= DUST_THRESHOLD) {
      const change = surplus - feeWith;
      return finish(assembled(selected, spend, change), selected, feeWith, change);
    }

    const sizeWithout = encodeTransaction(assembled(selected, spend, undefined)).length;
    const feeWithout = spend.feeRate * BigInt(sizeWithout);
    if (surplus >= feeWithout) {
      return finish(assembled(selected, spend, undefined), selected, surplus, 0n);
    }
  }

  const available = usable.reduce((sum, coin) => sum + coin.output.amount, 0n);
  throw new TxError(
    `残高が足りません (使える額 ${available.toString()} atomic、送る額 ${spend.amount.toString()} atomic と手数料)`,
  );
}

function finish(tx: Transaction, selected: readonly Coin[], fee: bigint, change: bigint): Draft {
  const size = encodeTransaction(tx).length;
  if (size > MAX_TX_SIZE) {
    throw new TxError(`取引が大きすぎます (${String(size)} バイト、上限 ${String(MAX_TX_SIZE)})`);
  }
  return { tx, spent: selected.map((coin) => coin.output), coins: selected, fee, change };
}

/**
 * 下書きに署名を入れる。
 *
 * 鍵は先に全部引く。1 つでも欠けていれば署名を始めない。中途半端に署名した
 * ものを送ると、資金を動かせないまま手数料だけ失うため。
 * 入れた署名はその場で検証してから返す。
 */
export function signDraft(
  draft: Draft,
  keyFor: (lock: Lock, index: number) => Uint8Array | undefined,
  auxRand?: (index: number) => Uint8Array,
): Transaction {
  const keys = draft.spent.map((output, index) => {
    const key = keyFor(output.lock, index);
    if (key === undefined) throw new TxError(`${String(index)} 番目の入力に対応する鍵がありません`);
    if (toHex(schnorr.getPublicKey(key)) !== toHex(output.lock.payload)) {
      throw new TxError(`${String(index)} 番目の入力の鍵が支払い条件と合いません`);
    }
    return key;
  });

  // sighash は署名欄を含まないので、全入力分を先に計算してよい。
  const messages = draft.tx.inputs.map((_, index) => sighash(draft.tx, draft.spent, index));
  const inputs = draft.tx.inputs.map((input, index) => {
    const key = keys[index];
    const msg = messages[index];
    if (key === undefined || msg === undefined) throw new TxError('署名の準備が揃っていません');
    const signature = schnorr.sign(msg, key, auxRand?.(index));
    if (!schnorr.verify(signature, msg, draft.spent[index]?.lock.payload ?? new Uint8Array())) {
      throw new TxError(`${String(index)} 番目の署名が検証に通りません`);
    }
    return { ...input, signature };
  });

  return { ...draft.tx, inputs };
}

/** 署名済みの取引を、使った出力と照らして検証する。送る直前の最後の確認。 */
export function verifySigned(tx: Transaction, spent: readonly TxOutput[]): void {
  if (spent.length !== tx.inputs.length) throw new TxError('使う出力の数が合いません');
  tx.inputs.forEach((input, index) => {
    const output = spent[index];
    if (output === undefined) throw new TxError('使う出力が足りません');
    if (input.signature.length !== 64) throw new TxError(`${String(index)} 番目の署名の長さが違います`);
    if (!schnorr.verify(input.signature, sighash(tx, spent, index), output.lock.payload)) {
      throw new TxError(`${String(index)} 番目の署名が検証に通りません`);
    }
  });

  const inTotal = spent.reduce((sum, output) => sum + output.amount, 0n);
  const outTotal = tx.outputs.reduce((sum, output) => sum + output.amount, 0n);
  if (outTotal > inTotal) throw new TxError('出力の合計が入力を超えています');
  const size = encodeTransaction(tx).length;
  if (inTotal - outTotal < MIN_RELAY_FEE_RATE * BigInt(size)) {
    throw new TxError('手数料が最低の料率に届いていません');
  }
  for (const output of tx.outputs) {
    if (output.amount < DUST_THRESHOLD) throw new TxError('ダスト未満の出力があります');
  }
}
