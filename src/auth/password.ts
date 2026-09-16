import { hash, verify, type Algorithm } from '@node-rs/argon2';

/**
 * Argon2id。@node-rs/argon2 の Algorithm は ambient const enum なので、
 * verbatimModuleSyntax が有効だと値として読み出せない。番号を直に置く。
 */
const ARGON2ID = 2 as Algorithm;

/**
 * パスワードのハッシュ化。
 *
 * パラメータは OAG の仕様 §16.2 がウォレットの種に使うものと揃えてある。
 * 同じ組織が扱う秘密なので、強度の基準を 2 つ持つ理由がない。
 */
const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 65536, // 64 MiB
  timeCost: 3,
  parallelism: 1,
} as const;

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 1024;

/** 短くはないが明らかに危ういもの。網羅は目的ではなく、事故を減らすための最低限。 */
const BLOCKED = new Set([
  'password',
  'passw0rd',
  'orangebot',
  'orange',
  'qwertyuiop',
  '123456789012',
  'administrator',
]);

export type PasswordCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export function checkPasswordStrength(
  password: string,
  context: { readonly username?: string; readonly displayName?: string } = {},
): PasswordCheck {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, reason: `パスワードは ${String(MIN_PASSWORD_LENGTH)} 文字以上にしてください` };
  }
  // 極端に長い入力は argon2 の計算量をそのまま攻撃者に握らせることになる。
  if (password.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, reason: 'パスワードが長すぎます' };
  }

  const lowered = password.toLowerCase();
  if (BLOCKED.has(lowered)) {
    return { ok: false, reason: 'よく使われるパスワードです。別のものにしてください' };
  }
  if (context.username !== undefined && context.username !== '') {
    if (lowered.includes(context.username.toLowerCase())) {
      return { ok: false, reason: 'パスワードにユーザー名を含めないでください' };
    }
  }
  if (context.displayName !== undefined && context.displayName.length >= 4) {
    if (lowered.includes(context.displayName.toLowerCase())) {
      return { ok: false, reason: 'パスワードに表示名を含めないでください' };
    }
  }
  if (new Set(password).size < 5) {
    return { ok: false, reason: '同じ文字の繰り返しは避けてください' };
  }

  return { ok: true };
}

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

/**
 * 照合する。ハッシュが壊れている場合も「合わない」として扱う。
 * 例外の有無で保存状態が読み取れないようにするため。
 */
export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}

/** パラメータを上げたあと、次回ログイン時に付け替えるべきか判定する。 */
export function needsRehash(storedHash: string): boolean {
  const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(storedHash);
  if (match === null) return true;
  const [, m, t, p] = match;
  return (
    Number(m) < ARGON2_OPTIONS.memoryCost ||
    Number(t) < ARGON2_OPTIONS.timeCost ||
    Number(p) !== ARGON2_OPTIONS.parallelism
  );
}
