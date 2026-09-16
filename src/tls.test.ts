import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TlsError, readTlsMaterial, watchTlsMaterial } from './tls.js';

let dir: string;
let certPath: string;
let keyPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orangebot-tls-'));
  certPath = join(dir, 'fullchain.pem');
  keyPath = join(dir, 'privkey.pem');
  writeFileSync(certPath, 'cert-1');
  writeFileSync(keyPath, 'key-1');
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe('証明書の読み込み', () => {
  it('鍵と証明書を読む', () => {
    const material = readTlsMaterial({ certPath, keyPath });
    expect(material.cert.toString()).toBe('cert-1');
    expect(material.key.toString()).toBe('key-1');
  });

  it('場所が違えば、どちらを読めなかったかを言う', () => {
    expect(() => readTlsMaterial({ certPath: join(dir, 'no.pem'), keyPath })).toThrow(TlsError);
    expect(() => readTlsMaterial({ certPath, keyPath: join(dir, 'no.pem') })).toThrow(/秘密鍵/);
  });
});

describe('証明書の入れ替え', () => {
  it('中身が変わったら差し替える', () => {
    vi.useFakeTimers();
    const server = { setSecureContext: vi.fn() };
    const initial = readTlsMaterial({ certPath, keyPath });

    const stop = watchTlsMaterial(
      server as unknown as Parameters<typeof watchTlsMaterial>[0],
      { certPath, keyPath },
      initial,
      1000,
    );

    // 変わっていなければ触らない。
    vi.advanceTimersByTime(1000);
    expect(server.setSecureContext).not.toHaveBeenCalled();

    writeFileSync(certPath, 'cert-2');
    vi.advanceTimersByTime(1000);
    expect(server.setSecureContext).toHaveBeenCalledTimes(1);

    // 同じ中身のままなら二度目は無い。
    vi.advanceTimersByTime(1000);
    expect(server.setSecureContext).toHaveBeenCalledTimes(1);

    stop();
    writeFileSync(certPath, 'cert-3');
    vi.advanceTimersByTime(1000);
    expect(server.setSecureContext).toHaveBeenCalledTimes(1);
  });

  it('読めない瞬間があっても落ちない', () => {
    vi.useFakeTimers();
    const server = { setSecureContext: vi.fn() };
    const initial = readTlsMaterial({ certPath, keyPath });

    watchTlsMaterial(
      server as unknown as Parameters<typeof watchTlsMaterial>[0],
      { certPath: join(dir, 'kieta.pem'), keyPath },
      initial,
      1000,
    );

    expect(() => {
      vi.advanceTimersByTime(1000);
    }).not.toThrow();
    expect(server.setSecureContext).not.toHaveBeenCalled();
  });
});
