import { createHash } from 'node:crypto';

/**
 * 追記専用の監査ログ。
 *
 * 各行が直前の行のハッシュを取り込むので、過去の行を書き換えるとそれ以降の連鎖が全部壊れる。
 * 消す・並べ替える・差し込む、のいずれも検出できる。
 */

export const GENESIS_HASH = '0'.repeat(64);

export interface AuditEntry {
  readonly seq: number;
  readonly at: number;
  readonly actorMemberId: string | null;
  readonly action: string;
  readonly detail: unknown;
}

/**
 * キー順に依存しない JSON 表現を作る。
 * オブジェクトのキー順が違うだけでハッシュが変わると、検証が偶然に左右されてしまうため。
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}

export function computeHash(prevHash: string, entry: AuditEntry): string {
  const body = canonicalJson({
    seq: entry.seq,
    at: entry.at,
    actorMemberId: entry.actorMemberId,
    action: entry.action,
    detail: entry.detail,
  });
  return createHash('sha256').update(`${prevHash}:${body}`).digest('hex');
}

export interface StoredAuditRow extends AuditEntry {
  readonly prevHash: string;
  readonly hash: string;
}

export type ChainVerification =
  | { readonly ok: true; readonly length: number }
  | { readonly ok: false; readonly brokenAt: number; readonly reason: string };

/**
 * 連鎖全体を検証する。行は seq の昇順で渡すこと。
 */
export function verifyChain(rows: readonly StoredAuditRow[]): ChainVerification {
  let prevHash = GENESIS_HASH;
  let prevSeq = 0;

  for (const row of rows) {
    if (row.seq <= prevSeq) {
      return { ok: false, brokenAt: row.seq, reason: 'seq が昇順になっていません' };
    }
    if (row.prevHash !== prevHash) {
      return { ok: false, brokenAt: row.seq, reason: '直前の行との連結が切れています' };
    }
    const expected = computeHash(prevHash, row);
    if (expected !== row.hash) {
      return { ok: false, brokenAt: row.seq, reason: '内容がハッシュと一致しません' };
    }
    prevHash = row.hash;
    prevSeq = row.seq;
  }

  return { ok: true, length: rows.length };
}

/** 次に書く 1 行を組み立てる。seq と prevHash は呼び出し側が末尾から引き継ぐ。 */
export function buildEntry(input: {
  readonly prevSeq: number;
  readonly prevHash: string;
  readonly at: number;
  readonly actorMemberId: string | null;
  readonly action: string;
  readonly detail: unknown;
}): StoredAuditRow {
  const entry: AuditEntry = {
    seq: input.prevSeq + 1,
    at: input.at,
    actorMemberId: input.actorMemberId,
    action: input.action,
    detail: input.detail,
  };
  return { ...entry, prevHash: input.prevHash, hash: computeHash(input.prevHash, entry) };
}
