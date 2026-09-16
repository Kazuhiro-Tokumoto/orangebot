import { asc, desc } from 'drizzle-orm';
import {
  GENESIS_HASH,
  buildEntry,
  canonicalJson,
  verifyChain,
  type ChainVerification,
  type StoredAuditRow,
} from '../domain/audit.js';
import type { Db } from './client.js';
import { auditLog } from './schema.js';

export interface AppendInput {
  readonly actorMemberId: string | null;
  readonly action: string;
  readonly detail?: unknown;
  readonly at?: number;
}

/**
 * 監査ログを 1 行追記する。
 *
 * 末尾を読んでから書くので、呼び出し側のトランザクションの中で使うこと。
 * detail は正規化した JSON 文字列で保存し、読み戻したときに同じハッシュが再現できるようにする。
 */
export function appendAudit(db: Db, input: AppendInput): StoredAuditRow {
  const last = db.select().from(auditLog).orderBy(desc(auditLog.seq)).limit(1).get();

  const row = buildEntry({
    prevSeq: last?.seq ?? 0,
    prevHash: last?.hash ?? GENESIS_HASH,
    at: input.at ?? Date.now(),
    actorMemberId: input.actorMemberId,
    action: input.action,
    detail: input.detail ?? {},
  });

  db.insert(auditLog)
    .values({
      seq: row.seq,
      at: row.at,
      actorMemberId: row.actorMemberId,
      action: row.action,
      detail: canonicalJson(row.detail),
      prevHash: row.prevHash,
      hash: row.hash,
    })
    .run();

  return row;
}

export function readChain(db: Db): StoredAuditRow[] {
  return db
    .select()
    .from(auditLog)
    .orderBy(asc(auditLog.seq))
    .all()
    .map((row) => ({
      seq: row.seq,
      at: row.at,
      actorMemberId: row.actorMemberId,
      action: row.action,
      detail: JSON.parse(row.detail) as unknown,
      prevHash: row.prevHash,
      hash: row.hash,
    }));
}

export function verifyAuditLog(db: Db): ChainVerification {
  return verifyChain(readChain(db));
}
