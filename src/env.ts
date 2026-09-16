import { createHash } from 'node:crypto';

export type NodeEnv = 'development' | 'production' | 'test';

export interface DiscordConfig {
  readonly token: string;
  readonly clientId: string;
  /** 所属サーバーの ID。DM を送れる相手かどうかを確かめるときに使う。 */
  readonly guildId: string | undefined;
  readonly proposalChannelId: string | undefined;
}

export interface TlsConfig {
  /** 証明書の鎖。Let's Encrypt なら fullchain.pem。 */
  readonly certPath: string;
  /** 秘密鍵。Let's Encrypt なら privkey.pem。 */
  readonly keyPath: string;
}

export type OagNetwork = 'mainnet' | 'testnet' | 'regtest';

export interface OagConfig {
  readonly network: OagNetwork;
  /** JSON-RPC の口。既定はネットワークごとのループバック。 */
  readonly rpcUrl: string;
  /** 合言葉の置き場所。ノードが起動のたびに書き直す。 */
  readonly cookiePath: string;
}

export interface Env {
  readonly nodeEnv: NodeEnv;
  readonly port: number;
  readonly databasePath: string;
  /** 例: https://orangebot.onrender.com。WebAuthn の origin 検証とクッキーの Secure 判定に使う。 */
  readonly webOrigin: string;
  /** WebAuthn の Relying Party ID。既定では webOrigin のホスト名。 */
  readonly rpId: string;
  readonly rpName: string;
  readonly sessionSecret: string;
  /** AES-256-GCM 用の 32 バイト鍵。TOTP の秘密鍵を保存時に暗号化する。 */
  readonly encryptionKey: Buffer;
  /** 設定すると node 自身が https を終端する。本番では必須。 */
  readonly tls: TlsConfig | undefined;
  /** 未設定ならウォレットは繋がない。残高も送金も出せない。 */
  readonly oag: OagConfig | undefined;
  /** 未設定なら Discord 連携を行わず Web だけで動く。 */
  readonly discord: DiscordConfig | undefined;
}

export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvError';
  }
}

function read(source: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = source[key]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function parseNodeEnv(raw: string | undefined): NodeEnv {
  return raw === 'production' || raw === 'test' ? raw : 'development';
}

function parsePort(raw: string | undefined, hasTls: boolean): number {
  if (raw === undefined) return hasTls ? 443 : 3000;
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new EnvError(`PORT が不正です: ${raw}`);
  }
  return port;
}

/**
 * 本番では必須の秘密値を取得する。開発とテストでは決め打ちの値を導出して警告を出す。
 * 導出値は公開されている文字列から作られるため、本番で使ってはならない。
 */
function requireSecret(
  source: NodeJS.ProcessEnv,
  key: string,
  nodeEnv: NodeEnv,
  warnings: string[],
): string {
  const value = read(source, key);
  if (value !== undefined) return value;
  if (nodeEnv === 'production') {
    throw new EnvError(`${key} は本番環境では必須です（.env.example を参照）`);
  }
  warnings.push(key);
  return createHash('sha256').update(`orangebot-insecure-dev-fallback:${key}`).digest('base64');
}

function parseEncryptionKey(raw: string, warnings: string[]): Buffer {
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    if (warnings.includes('APP_ENCRYPTION_KEY')) {
      return createHash('sha256').update(raw).digest();
    }
    throw new EnvError(
      `APP_ENCRYPTION_KEY は base64 で 32 バイトである必要があります（現在 ${String(key.length)} バイト）`,
    );
  }
  return key;
}

function parseOrigin(
  raw: string | undefined,
  nodeEnv: NodeEnv,
  port: number,
  hasTls: boolean,
): string {
  const fallback = `${hasTls ? 'https' : 'http'}://localhost:${String(port)}`;
  const value = raw ?? (nodeEnv === 'production' ? undefined : fallback);
  if (value === undefined) {
    throw new EnvError('WEB_ORIGIN は本番環境では必須です（例: https://example.onrender.com）');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EnvError(`WEB_ORIGIN が URL として不正です: ${value}`);
  }
  if (nodeEnv === 'production' && url.protocol !== 'https:') {
    throw new EnvError('WEB_ORIGIN は本番環境では https である必要があります（パスキーの要件）');
  }
  return url.origin;
}

/**
 * 証明書の場所。
 *
 * パスキーは https でしか動かず、クッキーの Secure も https でしか意味を持たない。
 * 本番で平文の口を開ける理由が無いので、指定が無ければ起動を止める。
 */
function parseTls(source: NodeJS.ProcessEnv, nodeEnv: NodeEnv): TlsConfig | undefined {
  const certPath = read(source, 'TLS_CERT_PATH');
  const keyPath = read(source, 'TLS_KEY_PATH');

  if (certPath === undefined && keyPath === undefined) {
    if (nodeEnv === 'production') {
      throw new EnvError(
        'TLS_CERT_PATH と TLS_KEY_PATH は本番環境では必須です' +
          '（例: /etc/letsencrypt/live/mail.shudo-physics.com/fullchain.pem）',
      );
    }
    return undefined;
  }

  if (certPath === undefined || keyPath === undefined) {
    throw new EnvError('TLS_CERT_PATH と TLS_KEY_PATH は両方揃えて設定してください');
  }

  return { certPath, keyPath };
}

/** ネットワークごとの RPC の待ち受け口（SPEC §15.1）。どれもループバックのみ。 */
const OAG_RPC_PORTS: Readonly<Record<OagNetwork, number>> = {
  mainnet: 9445,
  testnet: 19445,
  regtest: 29445,
};

function parseOagNetwork(raw: string | undefined): OagNetwork {
  if (raw === undefined) return 'mainnet';
  if (raw === 'mainnet' || raw === 'testnet' || raw === 'regtest') return raw;
  throw new EnvError(`OAG_NETWORK が不正です: ${raw}（mainnet / testnet / regtest）`);
}

/**
 * OAG ノードへの繋ぎ方。
 *
 * 合言葉の置き場所を指定したときだけ有効になる。ノードが動いていない間も
 * ポータルは動き続けてほしいので、未設定を異常として扱わない。
 */
function parseOag(source: NodeJS.ProcessEnv): OagConfig | undefined {
  const cookiePath = read(source, 'OAG_COOKIE_PATH');
  if (cookiePath === undefined) return undefined;

  const network = parseOagNetwork(read(source, 'OAG_NETWORK'));
  const rpcUrl = read(source, 'OAG_RPC_URL') ?? `http://127.0.0.1:${String(OAG_RPC_PORTS[network])}`;

  let url: URL;
  try {
    url = new URL(rpcUrl);
  } catch {
    throw new EnvError(`OAG_RPC_URL が URL として不正です: ${rpcUrl}`);
  }

  return { network, rpcUrl: url.origin, cookiePath };
}

function parseDiscord(source: NodeJS.ProcessEnv): DiscordConfig | undefined {
  const token = read(source, 'DISCORD_TOKEN');
  const clientId = read(source, 'DISCORD_CLIENT_ID');
  if (token === undefined && clientId === undefined) return undefined;
  if (token === undefined || clientId === undefined) {
    throw new EnvError('DISCORD_TOKEN と DISCORD_CLIENT_ID は両方揃えて設定してください');
  }
  return {
    token,
    clientId,
    guildId: read(source, 'DISCORD_GUILD_ID'),
    proposalChannelId: read(source, 'DISCORD_PROPOSAL_CHANNEL_ID'),
  };
}

export interface LoadEnvResult {
  readonly env: Env;
  /** 開発用の導出値で埋めた項目名。呼び出し側が警告を出すために使う。 */
  readonly insecureDefaults: readonly string[];
}

export function loadEnvWithWarnings(source: NodeJS.ProcessEnv = process.env): LoadEnvResult {
  const nodeEnv = parseNodeEnv(read(source, 'NODE_ENV'));
  const tls = parseTls(source, nodeEnv);
  const port = parsePort(read(source, 'PORT'), tls !== undefined);
  const warnings: string[] = [];

  const sessionSecret = requireSecret(source, 'SESSION_SECRET', nodeEnv, warnings);
  const encryptionRaw = requireSecret(source, 'APP_ENCRYPTION_KEY', nodeEnv, warnings);
  const webOrigin = parseOrigin(read(source, 'WEB_ORIGIN'), nodeEnv, port, tls !== undefined);

  return {
    env: {
      nodeEnv,
      port,
      databasePath: read(source, 'DATABASE_PATH') ?? 'data/orangebot.db',
      webOrigin,
      rpId: read(source, 'RP_ID') ?? new URL(webOrigin).hostname,
      rpName: read(source, 'RP_NAME') ?? 'orangebot',
      sessionSecret,
      encryptionKey: parseEncryptionKey(encryptionRaw, warnings),
      tls,
      oag: parseOag(source),
      discord: parseDiscord(source),
    },
    insecureDefaults: warnings,
  };
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return loadEnvWithWarnings(source).env;
}
