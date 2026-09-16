import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:https';
import type { TlsConfig } from './env.js';
import { logger } from './logger.js';

/**
 * 証明書の読み込みと入れ替え。
 *
 * Let's Encrypt の証明書は 90 日で切れ、certbot が定期的に置き換える。
 * 置き換わったことに気付かないと、古い証明書のまま期限切れを迎えてしまうので、
 * 中身のハッシュを見張って、変わっていたら接続を切らずに差し替える。
 */

/** 見張る間隔。certbot は 1 日 2 回動く程度なので、これで十分細かい。 */
export const RELOAD_INTERVAL_MS = 60 * 60 * 1000;

export interface TlsMaterial {
  readonly key: Buffer;
  readonly cert: Buffer;
}

export class TlsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TlsError';
  }
}

export function readTlsMaterial(tls: TlsConfig): TlsMaterial {
  return { key: readFile(tls.keyPath, '秘密鍵'), cert: readFile(tls.certPath, '証明書') };
}

function readFile(path: string, label: string): Buffer {
  try {
    return readFileSync(path);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new TlsError(
      `${label}を読めません: ${path}\n` +
        '場所が合っているか、読み取りの権限があるかを確かめてください。' +
        `（${reason}）`,
    );
  }
}

function fingerprint(material: TlsMaterial): string {
  return createHash('sha256').update(material.cert).update(material.key).digest('hex');
}

/**
 * 証明書の入れ替えを見張る。変わっていたら server の秘密の材料だけを差し替える。
 * 待ち受けは切らないので、そのとき開いている接続も落ちない。
 */
export function watchTlsMaterial(
  server: Server,
  tls: TlsConfig,
  initial: TlsMaterial,
  intervalMs = RELOAD_INTERVAL_MS,
): () => void {
  let current = fingerprint(initial);

  const timer = setInterval(() => {
    try {
      const next = readTlsMaterial(tls);
      const digest = fingerprint(next);
      if (digest === current) return;

      server.setSecureContext({ key: next.key, cert: next.cert });
      current = digest;
      logger.info('証明書を読み直しました');
    } catch (error: unknown) {
      // 置き換えの途中で読んだ場合もここに来る。次の巡回でやり直せばよい。
      logger.error('証明書を読み直せませんでした', error);
    }
  }, intervalMs);
  timer.unref();

  return () => {
    clearInterval(timer);
  };
}
