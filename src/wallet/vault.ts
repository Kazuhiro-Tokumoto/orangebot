import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { hashRaw } from '@node-rs/argon2';
import { isValidMnemonic, normalizeMnemonic } from './seed.js';

/**
 * 控えの語をパスフレーズで包んで保管する。
 *
 * Argon2id で鍵を伸ばし、ChaCha20-Poly1305 で包む（SPEC §16.2）。
 * ソルトと nonce は保存のたびに作り直す。同じ鍵と nonce で 2 度暗号化すると
 * 鍵流が再利用され、平文の差分が漏れる。
 *
 * パラメータは暗号文の外に置くが、すべて認証付きデータに入れる。
 * 入れておかないと、書き換えられても復号が通ってしまう。
 */

const MAGIC = Buffer.from('oagvlt', 'ascii');
const FORMAT_VERSION = 1;
const SALT_LENGTH = 16;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

/** Argon2id は ambient const enum なので番号を直に置く。 */
const ARGON2ID = 2;

export interface KdfParams {
  /** KiB 単位。 */
  readonly memoryCost: number;
  readonly timeCost: number;
  readonly parallelism: number;
}

/**
 * 既定のパラメータ。開発機で約 1 秒かかる。
 *
 * メモリを増やすほど専用機に対して強くなるが、ブラウザで動かす余地も狭まる。
 * 128 MiB はブラウザの wasm でも確保できる範囲に収まり、時間側を伸ばして
 * 1 秒に合わせてある。機械が変われば `calibrate` で測り直す。
 */
export const DEFAULT_KDF: KdfParams = {
  memoryCost: 131072, // 128 MiB
  timeCost: 12,
  parallelism: 1,
};

/** これより短いパスフレーズは、暗号化しているのに守られていない状態になる。 */
export const MIN_PASSPHRASE_LENGTH = 8;

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultError';
  }
}

function header(params: KdfParams, salt: Buffer): Buffer {
  const head = Buffer.alloc(6 + 1 + 4 + 4 + 1 + 1);
  MAGIC.copy(head, 0);
  head.writeUInt8(FORMAT_VERSION, 6);
  head.writeUInt32BE(params.memoryCost, 7);
  head.writeUInt32BE(params.timeCost, 11);
  head.writeUInt8(params.parallelism, 15);
  head.writeUInt8(salt.length, 16);
  return Buffer.concat([head, salt]);
}

async function deriveKey(passphrase: string, salt: Buffer, params: KdfParams): Promise<Buffer> {
  return hashRaw(passphrase.normalize('NFKC'), {
    algorithm: ARGON2ID,
    memoryCost: params.memoryCost,
    timeCost: params.timeCost,
    parallelism: params.parallelism,
    salt,
    outputLen: KEY_LENGTH,
  });
}

export interface SealOptions {
  readonly kdf?: KdfParams;
}

/**
 * 控えを封じる。
 *
 * 出来上がりは  ヘッダ ‖ nonce ‖ tag ‖ 暗号文。
 * ヘッダには形式の版数と KDF のパラメータとソルトが入り、そのまま認証付きデータになる。
 */
export async function sealMnemonic(
  mnemonic: string,
  passphrase: string,
  options: SealOptions = {},
): Promise<Buffer> {
  const normalized = normalizeMnemonic(mnemonic);
  if (!isValidMnemonic(normalized)) {
    throw new VaultError('控えの語が正しくありません');
  }
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new VaultError(`パスフレーズは ${String(MIN_PASSPHRASE_LENGTH)} 文字以上にしてください`);
  }

  const params = options.kdf ?? DEFAULT_KDF;
  const salt = randomBytes(SALT_LENGTH);
  const nonce = randomBytes(NONCE_LENGTH);
  const aad = header(params, salt);
  const key = await deriveKey(passphrase, salt, params);

  const plaintext = Buffer.from(normalized, 'utf8');
  const cipher = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAG_LENGTH });
  cipher.setAAD(aad, { plaintextLength: plaintext.length });
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  key.fill(0);
  plaintext.fill(0);

  return Buffer.concat([aad, nonce, cipher.getAuthTag(), body]);
}

export interface VaultHeader {
  readonly version: number;
  readonly kdf: KdfParams;
  readonly salt: Buffer;
}

/** パスフレーズ無しでヘッダだけ読む。どのパラメータで包まれているかを見るのに使う。 */
export function readHeader(blob: Buffer): VaultHeader {
  if (blob.length < 18) throw new VaultError('保管形式として読めません');
  if (!timingSafeEqual(blob.subarray(0, 6), MAGIC)) {
    throw new VaultError('保管形式として読めません');
  }

  const version = blob.readUInt8(6);
  if (version !== FORMAT_VERSION) {
    throw new VaultError(`知らない保管形式の版数です: ${String(version)}`);
  }

  const saltLength = blob.readUInt8(16);
  if (blob.length < 17 + saltLength + NONCE_LENGTH + TAG_LENGTH) {
    throw new VaultError('保管形式として読めません');
  }

  return {
    version,
    kdf: {
      memoryCost: blob.readUInt32BE(7),
      timeCost: blob.readUInt32BE(11),
      parallelism: blob.readUInt8(15),
    },
    salt: blob.subarray(17, 17 + saltLength),
  };
}

/**
 * 控えを取り出す。
 *
 * パスフレーズ違いと改竄は区別せずに断る。
 * 区別できると、書き換えたものを投げ込んで反応を見る手掛かりになる（SPEC §16.2）。
 */
export async function openMnemonic(blob: Buffer, passphrase: string): Promise<string> {
  const head = readHeader(blob);
  const offset = 17 + head.salt.length;
  const aad = blob.subarray(0, offset);
  const nonce = blob.subarray(offset, offset + NONCE_LENGTH);
  const tag = blob.subarray(offset + NONCE_LENGTH, offset + NONCE_LENGTH + TAG_LENGTH);
  const body = blob.subarray(offset + NONCE_LENGTH + TAG_LENGTH);

  const key = await deriveKey(passphrase, Buffer.from(head.salt), head.kdf);
  try {
    const decipher = createDecipheriv('chacha20-poly1305', key, nonce, {
      authTagLength: TAG_LENGTH,
    });
    decipher.setAuthTag(tag);
    decipher.setAAD(aad, { plaintextLength: body.length });
    const plaintext = Buffer.concat([decipher.update(body), decipher.final()]);
    const mnemonic = plaintext.toString('utf8');
    plaintext.fill(0);
    return mnemonic;
  } catch {
    throw new VaultError('パスフレーズが違うか、保管されている内容が壊れています');
  } finally {
    key.fill(0);
  }
}

/** パスフレーズだけ付け替える。控えは変えない。 */
export async function changePassphrase(
  blob: Buffer,
  current: string,
  next: string,
  options: SealOptions = {},
): Promise<Buffer> {
  const mnemonic = await openMnemonic(blob, current);
  return sealMnemonic(mnemonic, next, options);
}

export interface Calibration {
  readonly params: KdfParams;
  readonly measuredMs: number;
}

/**
 * この機械で目標の時間になるパラメータを探す。
 *
 * メモリは据え置き、時間側を動かす。メモリを増やす方が専用機には強いが、
 * 確保できない環境では動かなくなるため、上限を決めて時間で合わせる。
 */
export async function calibrate(
  targetMs = 1000,
  memoryCost = DEFAULT_KDF.memoryCost,
): Promise<Calibration> {
  const salt = randomBytes(SALT_LENGTH);
  const probe: KdfParams = { memoryCost, timeCost: 3, parallelism: 1 };

  await deriveKey('calibration', salt, probe); // 初回は割り当てのぶん遅いので捨てる
  const started = process.hrtime.bigint();
  await deriveKey('calibration', salt, probe);
  const perPass = Number(process.hrtime.bigint() - started) / 1e6 / probe.timeCost;

  const timeCost = Math.max(2, Math.min(64, Math.round(targetMs / perPass)));
  const params: KdfParams = { memoryCost, timeCost, parallelism: 1 };

  const check = process.hrtime.bigint();
  await deriveKey('calibration', salt, params);
  return { params, measuredMs: Number(process.hrtime.bigint() - check) / 1e6 };
}
