import type { Context, MiddlewareHandler } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { loadSession, type LoadedSession } from '../auth/session.js';
import type { Notifier } from '../bot/notify.js';
import type { PriceSource } from '../market/price.js';
import type { RpcClient } from '../wallet/rpc.js';
import type { Db } from '../db/client.js';
import type { Env } from '../env.js';

export const SESSION_COOKIE = 'ob_session';

export interface AppVariables {
  viewer: LoadedSession | undefined;
}

export interface AppBindings {
  Variables: AppVariables;
}

export interface AppDeps {
  readonly db: Db;
  readonly env: Env;
  /** 省くと何も通知しない。試験と Discord 未設定のときはこれで足りる。 */
  readonly notify?: Notifier | undefined;
  /** 省くと残高を出さない。OAG ノードが無くてもポータルは動く。 */
  readonly rpc?: RpcClient | undefined;
  /** 省くと予想の画面にいまの値段を出さない。決着は定期処理が行う。 */
  readonly prices?: PriceSource | undefined;
  /** pt への交換を受け付けた直後に呼ぶ。巡回を待たずに送り始めるため。 */
  readonly onWithdrawalRequested?: (() => void) | undefined;
}

/** createApp が通知先を埋めたあとの形。各 route はこちらを受け取る。 */
export interface RouteDeps extends AppDeps {
  readonly notify: Notifier;
}

/**
 * セッションのクッキー。
 *
 * httpOnly なので JavaScript からは読めない。
 * SameSite=Lax にしておくと、他所からの POST にクッキーが付かないので、
 * フォームを踏ませる形の攻撃が成立しない。
 */
export function setSessionCookie(c: Context, env: Env, token: string, expiresAt: number): void {
  setCookie(c, SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    secure: env.webOrigin.startsWith('https://'),
    expires: new Date(expiresAt),
  });
}

export function clearSessionCookie(c: Context, env: Env): void {
  deleteCookie(c, SESSION_COOKIE, {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    secure: env.webOrigin.startsWith('https://'),
  });
}

/** クッキーからセッションを引いて c.var.viewer に載せる。無ければ undefined。 */
export function sessionMiddleware(deps: AppDeps): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    c.set('viewer', token === undefined ? undefined : loadSession(deps.db, token));
    await next();
  };
}

/**
 * 二要素まで通ったセッションだけ通す。投票と設定変更に使う。
 *
 * 画面からの移動には行き先を返し、fetch からの JSON には JSON で断る。
 * 後者に 302 を返すと、ログイン画面の HTML を JSON として読もうとして意味の無い失敗になる。
 */
export function requireFullSession(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const viewer = c.get('viewer');
    if (viewer !== undefined && viewer.aal >= 2) {
      await next();
      return;
    }

    if (c.req.header('content-type')?.startsWith('application/json') === true) {
      return c.json({ ok: false, reason: 'ログインし直してください' }, 401);
    }
    return c.redirect(viewer === undefined ? '/login' : '/login/totp');
  };
}

/** 表示名。ヘッダに出す。 */
export function viewerName(c: Context<AppBindings>): string | undefined {
  const viewer = c.get('viewer');
  return viewer === undefined || viewer.aal < 2 ? undefined : viewer.member.displayName;
}

/**
 * 接続元の IP。
 *
 * node 自身が https を終端していて前にプロキシが無いので、X-Forwarded-For は
 * 誰でも好きに書ける。見出しは信じず、ソケットの相手を使う。
 * app.request() で呼ぶ試験ではソケットが無いので null になる。
 */
export function clientIp(c: Context): string | null {
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    return null;
  }
}

export function userAgent(c: Context): string | null {
  return c.req.header('user-agent')?.slice(0, 300) ?? null;
}

/**
 * フォームから文字列の項目を取り出す。
 * FormData はファイルも返しうるので、文字列でなければ空として扱う。
 */
export function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

/** JSON の本文から文字列の項目を取り出す。形が違えば空として扱う。 */
export function jsonString(body: unknown, key: string): string {
  if (typeof body !== 'object' || body === null) return '';
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

/**
 * JSON の本文から入れ子の object を取り出す。
 * 中身の検証は @simplewebauthn/server の照合に任せる。そこを通らなければ何も起きない。
 */
export function jsonObject<T>(body: unknown, key: string): T | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>)[key];
  if (typeof value !== 'object' || value === null) return undefined;
  return value as T;
}
