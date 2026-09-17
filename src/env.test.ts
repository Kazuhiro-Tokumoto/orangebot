import { describe, expect, it } from 'vitest';
import { EnvError, loadEnv, loadEnvWithWarnings } from './env.js';

const KEY = Buffer.alloc(32, 7).toString('base64');

const CERT = '/etc/letsencrypt/live/mail.shudo-physics.com/fullchain.pem';
const PRIVKEY = '/etc/letsencrypt/live/mail.shudo-physics.com/privkey.pem';

const PROD = {
  NODE_ENV: 'production',
  SESSION_SECRET: 'session-secret',
  APP_ENCRYPTION_KEY: KEY,
  WEB_ORIGIN: 'https://orangebot.example.com',
  TLS_CERT_PATH: CERT,
  TLS_KEY_PATH: PRIVKEY,
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
    expect(() => loadEnv({ ...PROD, WEB_ORIGIN: 'http://orangebot.example.com' })).toThrow(/https/);
  });

  it('長さの足りない暗号鍵を拒否する', () => {
    expect(() => loadEnv({ ...PROD, APP_ENCRYPTION_KEY: 'c2hvcnQ=' })).toThrow(/32 バイト/);
  });
});

describe('TLS', () => {
  it('証明書の場所を読み取る', () => {
    expect(loadEnv(PROD).tls).toEqual({ certPath: CERT, keyPath: PRIVKEY });
  });

  it('証明書があれば既定のポートは 443', () => {
    expect(loadEnv(PROD).port).toBe(443);
    expect(loadEnv({ ...PROD, PORT: '8443' }).port).toBe(8443);
  });

  it('本番で証明書の指定が無ければ起動を止める', () => {
    const { TLS_CERT_PATH: _cert, TLS_KEY_PATH: _key, ...rest } = PROD;
    expect(() => loadEnv(rest)).toThrow(/TLS_CERT_PATH/);
  });

  it('片方だけの指定は設定漏れとして弾く', () => {
    const { TLS_KEY_PATH: _key, ...rest } = PROD;
    expect(() => loadEnv(rest)).toThrow(EnvError);
  });

  it('開発では証明書が無くても http のまま動く', () => {
    const env = loadEnv({});
    expect(env.tls).toBeUndefined();
    expect(env.webOrigin).toBe('http://localhost:3000');
  });

  it('開発でも証明書を指定すれば既定の origin が https になる', () => {
    const env = loadEnv({ TLS_CERT_PATH: CERT, TLS_KEY_PATH: PRIVKEY, PORT: '8443' });
    expect(env.webOrigin).toBe('https://localhost:8443');
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

describe('値動きの予想', () => {
  it('既定で BTC と ETH を受け付ける', () => {
    expect(loadEnv({}).prediction).toEqual({
      symbols: ['BTCUSDT', 'ETHUSDT'],
      rankingSymbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'],
      priceBaseUrl: 'https://data-api.binance.vision',
    });
  });

  it('順位予想の銘柄は 2 つ以上のときだけ使う', () => {
    expect(loadEnv({ RANKING_SYMBOLS: 'btcusdt,ethusdt' }).prediction?.rankingSymbols).toEqual([
      'BTCUSDT',
      'ETHUSDT',
    ]);
    expect(loadEnv({ RANKING_SYMBOLS: 'BTCUSDT' }).prediction?.rankingSymbols).toEqual([]);
    expect(loadEnv({ RANKING_SYMBOLS: 'none' }).prediction?.rankingSymbols).toEqual([]);
    expect(() => loadEnv({ RANKING_SYMBOLS: 'BTC-USDT,ETHUSDT' })).toThrow(EnvError);
  });

  it('none で止められる', () => {
    expect(loadEnv({ PREDICTION_SYMBOLS: 'none' }).prediction).toBeUndefined();
  });

  it('銘柄を並べて指定でき、小文字と重複は整える', () => {
    expect(loadEnv({ PREDICTION_SYMBOLS: 'solusdt, BTCUSDT,BTCUSDT' }).prediction?.symbols).toEqual([
      'SOLUSDT',
      'BTCUSDT',
    ]);
  });

  it('不正なシンボルは弾く', () => {
    expect(() => loadEnv({ PREDICTION_SYMBOLS: 'BTC/USDT' })).toThrow(EnvError);
  });
});

describe('pt の交換', () => {
  const SECRET = 'x'.repeat(32);

  it('秘密が無ければ止まっている', () => {
    expect(loadEnv({}).exchange).toBeUndefined();
  });

  it('秘密だけなら入金だけ動き、上限は既定値', () => {
    expect(loadEnv({ EXCHANGE_SECRET: SECRET }).exchange).toEqual({
      secret: SECRET,
      partnerUrl: undefined,
      limits: { maxPtPerRequest: 100_000_000_000n, maxPtPerDay: 1_000_000_000_000n },
    });
  });

  it('短い秘密は弾く', () => {
    expect(() => loadEnv({ EXCHANGE_SECRET: 'short' })).toThrow(/32 文字/);
  });

  it('秘密なしに相手の URL だけ置くのは設定漏れ', () => {
    expect(() => loadEnv({ EXCHANGE_PARTNER_URL: 'https://example.com/in' })).toThrow(EnvError);
  });

  it('本番では相手の URL も https に限る', () => {
    expect(() =>
      loadEnv({ ...PROD, EXCHANGE_SECRET: SECRET, EXCHANGE_PARTNER_URL: 'http://example.com/in' }),
    ).toThrow(/https/);
  });

  it('相手の URL はパスまで要る', () => {
    expect(() =>
      loadEnv({ EXCHANGE_SECRET: SECRET, EXCHANGE_PARTNER_URL: 'https://oogiri-bot-cfy1.onrender.com/' }),
    ).toThrow(/パスまで/);
    expect(
      loadEnv({
        EXCHANGE_SECRET: SECRET,
        EXCHANGE_PARTNER_URL: 'https://oogiri-bot-cfy1.onrender.com/api/orangebot-boag-pt-exchange/v1/pt-deposits',
      }).exchange?.partnerUrl,
    ).toBe('https://oogiri-bot-cfy1.onrender.com/api/orangebot-boag-pt-exchange/v1/pt-deposits');
  });

  it('上限を変えられる', () => {
    const env = loadEnv({
      EXCHANGE_SECRET: SECRET,
      EXCHANGE_MAX_PT_PER_REQUEST: '5',
      EXCHANGE_MAX_PT_PER_DAY: '50',
    });
    expect(env.exchange?.limits).toEqual({ maxPtPerRequest: 5n, maxPtPerDay: 50n });
  });
});
