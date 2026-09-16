import { describe, expect, it } from 'vitest';
import { EnvError, loadEnv, loadEnvWithWarnings } from './env.js';

const KEY = Buffer.alloc(32, 7).toString('base64');

const PROD = {
  NODE_ENV: 'production',
  SESSION_SECRET: 'session-secret',
  APP_ENCRYPTION_KEY: KEY,
  WEB_ORIGIN: 'https://orangebot.example.com',
} satisfies NodeJS.ProcessEnv;

describe('開発環境', () => {
  it('秘密値が無くても起動でき、導出で埋めた項目を報告する', () => {
    const { env, insecureDefaults } = loadEnvWithWarnings({});
    expect(env.nodeEnv).toBe('development');
    expect(env.port).toBe(3000);
    expect(env.webOrigin).toBe('http://localhost:3000');
    expect(env.rpId).toBe('localhost');
    expect(insecureDefaults).toEqual(['SESSION_SECRET', 'APP_ENCRYPTION_KEY']);
  });

  it('PORT に合わせて既定の origin が動く', () => {
    expect(loadEnv({ PORT: '8080' }).webOrigin).toBe('http://localhost:8080');
  });

  it('未知の NODE_ENV は development に丸める', () => {
    expect(loadEnv({ NODE_ENV: 'staging' }).nodeEnv).toBe('development');
  });
});

describe('本番環境', () => {
  it('必須が揃っていれば読み込める', () => {
    const env = loadEnv(PROD);
    expect(env.nodeEnv).toBe('production');
    expect(env.webOrigin).toBe('https://orangebot.example.com');
    expect(env.encryptionKey).toHaveLength(32);
  });

  it('SESSION_SECRET が無ければ起動を止める', () => {
    const { SESSION_SECRET: _omitted, ...rest } = PROD;
    expect(() => loadEnv(rest)).toThrow(EnvError);
  });

  it('APP_ENCRYPTION_KEY が無ければ起動を止める', () => {
    const { APP_ENCRYPTION_KEY: _omitted, ...rest } = PROD;
    expect(() => loadEnv(rest)).toThrow(EnvError);
  });

  it('WEB_ORIGIN が無ければ起動を止める', () => {
    const { WEB_ORIGIN: _omitted, ...rest } = PROD;
    expect(() => loadEnv(rest)).toThrow(EnvError);
  });

  it('http の origin はパスキーが動かないので拒否する', () => {
    expect(() => loadEnv({ ...PROD, WEB_ORIGIN: 'http://orangebot.example.com' })).toThrow(
      /https/,
    );
  });

  it('長さの足りない暗号鍵を拒否する', () => {
    expect(() => loadEnv({ ...PROD, APP_ENCRYPTION_KEY: 'c2hvcnQ=' })).toThrow(/32 バイト/);
  });
});

describe('WebAuthn の設定', () => {
  it('RP ID は WEB_ORIGIN のホスト名から導出される', () => {
    expect(loadEnv(PROD).rpId).toBe('orangebot.example.com');
  });

  it('RP_ID を明示すればそちらが優先される', () => {
    expect(loadEnv({ ...PROD, RP_ID: 'example.com' }).rpId).toBe('example.com');
  });

  it('origin のパスやクエリは捨てられる', () => {
    expect(loadEnv({ ...PROD, WEB_ORIGIN: 'https://a.example.com/portal?x=1' }).webOrigin).toBe(
      'https://a.example.com',
    );
  });
});

describe('Discord 連携', () => {
  it('未設定なら Web だけで動く', () => {
    expect(loadEnv(PROD).discord).toBeUndefined();
  });

  it('トークンとクライアント ID が揃えば有効になる', () => {
    const env = loadEnv({
      ...PROD,
      DISCORD_TOKEN: 'token',
      DISCORD_CLIENT_ID: '123',
      DISCORD_PROPOSAL_CHANNEL_ID: '456',
    });
    expect(env.discord).toEqual({
      token: 'token',
      clientId: '123',
      guildId: undefined,
      proposalChannelId: '456',
    });
  });

  it('片方だけの設定は設定漏れとして弾く', () => {
    expect(() => loadEnv({ ...PROD, DISCORD_TOKEN: 'token' })).toThrow(EnvError);
    expect(() => loadEnv({ ...PROD, DISCORD_CLIENT_ID: '123' })).toThrow(EnvError);
  });
});

describe('その他', () => {
  it('不正な PORT を弾く', () => {
    expect(() => loadEnv({ PORT: '0' })).toThrow(EnvError);
    expect(() => loadEnv({ PORT: 'abc' })).toThrow(EnvError);
    expect(() => loadEnv({ PORT: '70000' })).toThrow(EnvError);
  });

  it('空文字は未設定として扱う', () => {
    expect(loadEnv({ ...PROD, DISCORD_GUILD_ID: '   ' }).discord).toBeUndefined();
  });

  it('DATABASE_PATH の既定値', () => {
    expect(loadEnv({}).databasePath).toBe('data/orangebot.db');
    expect(loadEnv({ DATABASE_PATH: '/tmp/x.db' }).databasePath).toBe('/tmp/x.db');
  });
});
