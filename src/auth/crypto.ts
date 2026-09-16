import { createDecipheriv, createCipheriv, randomBytes } from 'node:crypto';

/**
 * 保存時の暗号化。AES-256-GCM。
 *
 * 形式は iv(12) ‖ tag(16) ‖ 暗号文。
 * nonce は毎回作り直す。同じ鍵と nonce で 2 度暗号化すると鍵流が再利用され、
 * 平文の差分が漏れる。
 *
 * aad にはメンバー ID など「この暗号文が誰のものか」を入れる。
 * 含めておくと、DB を書き換えて他人の行に付け替えても復号が通らなくなる。
 */

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export function encrypt(key: Buffer, plaintext: string | Buffer, aad?: string): Buffer {
  if (key.length !== 32) throw new Error('鍵は 32 バイトである必要があります');

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (aad !== undefined) cipher.setAAD(Buffer.from(aad, 'utf8'));

  const body = Buffer.concat([
    cipher.update(typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext),
    cipher.final(),
  ]);

  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

/** 復号する。改竄されていれば例外を投げる。 */
export function decrypt(key: Buffer, blob: Buffer, aad?: string): Buffer {
  if (key.length !== 32) throw new Error('鍵は 32 バイトである必要があります');
  if (blob.length < IV_LENGTH + TAG_LENGTH) throw new Error('暗号文が短すぎます');

  const iv = blob.subarray(0, IV_LENGTH);
  const tag = blob.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const body = blob.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  if (aad !== undefined) decipher.setAAD(Buffer.from(aad, 'utf8'));

  return Buffer.concat([decipher.update(body), decipher.final()]);
}

export function decryptToString(key: Buffer, blob: Buffer, aad?: string): string {
  return decrypt(key, blob, aad).toString('utf8');
}

/**
 * Buffer をぴったりの長さの ArrayBuffer に写す。
 * Buffer は内部プールを共有することがあり、.buffer がそのまま使えるとは限らないため。
 */
export function toArrayBuffer(bytes: Buffer): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}
