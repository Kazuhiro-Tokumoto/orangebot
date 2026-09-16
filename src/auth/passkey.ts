import { randomUUID } from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { and, eq, lt } from 'drizzle-orm';
import { appendAudit } from '../db/audit.js';
import type { Db } from '../db/client.js';
import { getMember } from '../db/members.js';
import { passkeys, webauthnChallenges, type MemberRow, type PasskeyRow } from '../db/schema.js';

/**
 * パスキー。
 *
 * 登録するときは residentKey と userVerification をどちらも required にする。
 * 端末の中に鍵が住み、使うたびに生体か PIN を求められるので、
 * 「持っているもの」と「知っている / 本人であること」の 2 要素が 1 回の操作で揃う。
 * だからパスキーだけで AAL2 に到達してよい。
 *
 * 遣り取りの途中で使う challenge は DB に置き、その行の ID をブラウザに返す。
 * ブラウザは応答と一緒にその ID を送り返す。使った challenge はその場で消える。
 */

/** challenge の寿命。認証器の操作を待つだけなので短くてよい。 */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export type PasskeyFailure = { readonly ok: false; readonly reason: string };

export function listPasskeys(db: Db, memberId: string): PasskeyRow[] {
  return db
    .select()
    .from(passkeys)
    .where(eq(passkeys.memberId, memberId))
    .all()
    .sort((a, b) => b.createdAt - a.createdAt);
}

function parseTransports(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function purgeChallenges(db: Db, now: number): void {
  db.delete(webauthnChallenges).where(lt(webauthnChallenges.expiresAt, now)).run();
}

function storeChallenge(
  db: Db,
  input: {
    readonly memberId: string | null;
    readonly kind: 'registration' | 'authentication';
    readonly challenge: string;
    readonly now: number;
  },
): string {
  const id = randomUUID();
  db.insert(webauthnChallenges)
    .values({
      id,
      memberId: input.memberId,
      kind: input.kind,
      challenge: input.challenge,
      createdAt: input.now,
      expiresAt: input.now + CHALLENGE_TTL_MS,
    })
    .run();
  return id;
}

/** 一度きり。引いた時点で消すので、同じ challenge は二度使えない。 */
function takeChallenge(
  db: Db,
  input: {
    readonly id: string;
    readonly kind: 'registration' | 'authentication';
    readonly now: number;
  },
): string | undefined {
  const row = db
    .select()
    .from(webauthnChallenges)
    .where(and(eq(webauthnChallenges.id, input.id), eq(webauthnChallenges.kind, input.kind)))
    .get();
  if (row === undefined) return undefined;

  db.delete(webauthnChallenges).where(eq(webauthnChallenges.id, row.id)).run();
  if (input.now >= row.expiresAt) return undefined;
  return row.challenge;
}

export interface StartResult<T> {
  readonly challengeId: string;
  readonly options: T;
}

export async function startRegistration(
  db: Db,
  input: {
    readonly member: MemberRow;
    readonly rpId: string;
    readonly rpName: string;
    readonly now?: number;
  },
): Promise<StartResult<PublicKeyCredentialCreationOptionsJSON>> {
  const now = input.now ?? Date.now();
  purgeChallenges(db, now);

  const options = await generateRegistrationOptions({
    rpID: input.rpId,
    rpName: input.rpName,
    userID: new TextEncoder().encode(input.member.id),
    userName: input.member.username,
    userDisplayName: input.member.displayName,
    attestationType: 'none',
    // 既に登録済みの鍵は除く。同じ端末で二重に作っても片方しか使われない。
    excludeCredentials: listPasskeys(db, input.member.id).map((row) => ({
      id: row.id,
      transports: parseTransports(row.transports),
    })),
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'required',
    },
  });

  const challengeId = storeChallenge(db, {
    memberId: input.member.id,
    kind: 'registration',
    challenge: options.challenge,
    now,
  });

  return { challengeId, options };
}

export type FinishRegistrationResult =
  | { readonly ok: true; readonly passkeyId: string }
  | PasskeyFailure;

export async function finishRegistration(
  db: Db,
  input: {
    readonly memberId: string;
    readonly challengeId: string;
    readonly response: RegistrationResponseJSON;
    readonly nickname: string;
    readonly origin: string;
    readonly rpId: string;
    readonly now?: number;
  },
): Promise<FinishRegistrationResult> {
  const now = input.now ?? Date.now();
  const expected = takeChallenge(db, { id: input.challengeId, kind: 'registration', now });
  if (expected === undefined) return { ok: false, reason: '手続きの期限が切れました。もう一度やり直してください' };

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: expected,
      expectedOrigin: input.origin,
      expectedRPID: input.rpId,
      requireUserVerification: true,
    });
  } catch (error: unknown) {
    return { ok: false, reason: error instanceof Error ? error.message : '登録を確かめられませんでした' };
  }

  if (!verification.verified) return { ok: false, reason: '登録を確かめられませんでした' };

  const info = verification.registrationInfo;
  const nickname = input.nickname.trim().slice(0, 60);

  db.insert(passkeys)
    .values({
      id: info.credential.id,
      memberId: input.memberId,
      publicKey: Buffer.from(info.credential.publicKey),
      counter: info.credential.counter,
      transports: JSON.stringify(info.credential.transports ?? []),
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp ? 1 : 0,
      nickname: nickname === '' ? 'パスキー' : nickname,
      createdAt: now,
      lastUsedAt: null,
    })
    .run();

  appendAudit(db, {
    at: now,
    actorMemberId: input.memberId,
    action: 'passkey.registered',
    detail: { passkeyId: info.credential.id, deviceType: info.credentialDeviceType },
  });

  return { ok: true, passkeyId: info.credential.id };
}

/**
 * ログイン用の選択肢。
 *
 * allowCredentials を渡さないので、ブラウザが端末の中から使える鍵を出してくる。
 * 利用者名を先に打たせる必要がなく、存在しない利用者名を探る余地も残らない。
 */
export async function startAuthentication(
  db: Db,
  input: { readonly rpId: string; readonly now?: number },
): Promise<StartResult<PublicKeyCredentialRequestOptionsJSON>> {
  const now = input.now ?? Date.now();
  purgeChallenges(db, now);

  const options = await generateAuthenticationOptions({
    rpID: input.rpId,
    userVerification: 'required',
  });

  const challengeId = storeChallenge(db, {
    memberId: null,
    kind: 'authentication',
    challenge: options.challenge,
    now,
  });

  return { challengeId, options };
}

export type FinishAuthenticationResult =
  | { readonly ok: true; readonly member: MemberRow; readonly passkeyId: string }
  | PasskeyFailure;

export async function finishAuthentication(
  db: Db,
  input: {
    readonly challengeId: string;
    readonly response: AuthenticationResponseJSON;
    readonly origin: string;
    readonly rpId: string;
    readonly now?: number;
  },
): Promise<FinishAuthenticationResult> {
  const now = input.now ?? Date.now();
  const expected = takeChallenge(db, { id: input.challengeId, kind: 'authentication', now });
  if (expected === undefined) return { ok: false, reason: '手続きの期限が切れました。もう一度やり直してください' };

  const stored = db.select().from(passkeys).where(eq(passkeys.id, input.response.id)).get();
  if (stored === undefined) return { ok: false, reason: 'このパスキーは登録されていません' };

  const member = getMember(db, stored.memberId);
  if (member === undefined || member.status !== 'active') {
    return { ok: false, reason: 'このアカウントは利用できません' };
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: expected,
      expectedOrigin: input.origin,
      expectedRPID: input.rpId,
      requireUserVerification: true,
      credential: {
        id: stored.id,
        publicKey: new Uint8Array(stored.publicKey),
        counter: stored.counter,
        transports: parseTransports(stored.transports),
      },
    });
  } catch (error: unknown) {
    return { ok: false, reason: error instanceof Error ? error.message : '照合できませんでした' };
  }

  if (!verification.verified) return { ok: false, reason: '照合できませんでした' };

  // 署名回数が巻き戻っていたら、鍵の複製が疑われる。
  // パスキーは 0 のまま増えない実装が多いので、増えない場合だけを許す。
  const next = verification.authenticationInfo.newCounter;
  if (next !== 0 && next <= stored.counter) {
    appendAudit(db, {
      at: now,
      actorMemberId: member.id,
      action: 'passkey.counter_regressed',
      detail: { passkeyId: stored.id, stored: stored.counter, received: next },
    });
    return { ok: false, reason: 'このパスキーは使えません。メンバーに連絡してください' };
  }

  db.update(passkeys)
    .set({ counter: next, lastUsedAt: now })
    .where(eq(passkeys.id, stored.id))
    .run();

  appendAudit(db, {
    at: now,
    actorMemberId: member.id,
    action: 'passkey.used',
    detail: { passkeyId: stored.id },
  });

  return { ok: true, member, passkeyId: stored.id };
}

export function removePasskey(
  db: Db,
  input: { readonly memberId: string; readonly passkeyId: string; readonly now?: number },
): { readonly ok: true } | PasskeyFailure {
  const now = input.now ?? Date.now();
  const row = db.select().from(passkeys).where(eq(passkeys.id, input.passkeyId)).get();
  if (row === undefined || row.memberId !== input.memberId) {
    return { ok: false, reason: 'そのパスキーはありません' };
  }

  db.delete(passkeys).where(eq(passkeys.id, row.id)).run();
  appendAudit(db, {
    at: now,
    actorMemberId: input.memberId,
    action: 'passkey.removed',
    detail: { passkeyId: row.id, nickname: row.nickname },
  });

  return { ok: true };
}

/** 二要素の代わりになる手段を持っているか。TOTP を外してよいかの判断に使う。 */
export function hasPasskey(db: Db, memberId: string): boolean {
  return db.select().from(passkeys).where(eq(passkeys.memberId, memberId)).get() !== undefined;
}
