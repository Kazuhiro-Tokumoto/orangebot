import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import { MIGRATIONS } from './migrations.js';
import * as schema from './schema.js';

/**
 * 接続本体とトランザクションの共通の親型。
 * これを使うことで、同じ関数をトランザクションの内でも外でも呼べる。
 */
export type Db = BaseSQLiteDatabase<'sync', Database.RunResult, typeof schema>;

export interface Database_ {
  readonly db: Db;
  readonly raw: Database.Database;
  readonly close: () => void;
}

/**
 * 適用済みのマイグレーション段数を user_version から読み、足りない分だけ流す。
 * 1 段ずつトランザクションで包むので、途中で失敗してもその段は丸ごと巻き戻る。
 */
export function migrate(raw: Database.Database): number {
  const row = raw.pragma('user_version', { simple: true });
  const applied = typeof row === 'number' ? row : 0;

  for (let version = applied; version < MIGRATIONS.length; version += 1) {
    const sql = MIGRATIONS[version];
    if (sql === undefined) continue;
    raw.exec('BEGIN');
    try {
      raw.exec(sql);
      // user_version はパラメータを取れないので、境界の明らかな整数を直接埋める。
      raw.pragma(`user_version = ${String(version + 1)}`);
      raw.exec('COMMIT');
    } catch (error: unknown) {
      raw.exec('ROLLBACK');
      throw error;
    }
  }

  return MIGRATIONS.length - applied;
}

export interface OpenOptions {
  readonly path: string;
  /** テストでは false にしてログを静かにする。 */
  readonly runMigrations?: boolean;
}

export function openDatabase(options: OpenOptions): Database_ {
  const inMemory = options.path === ':memory:';
  if (!inMemory) {
    mkdirSync(dirname(options.path), { recursive: true });
  }

  const raw = new Database(options.path);
  // 外部キーは既定で無効。参照整合性を効かせるために毎接続で入れる必要がある。
  raw.pragma('foreign_keys = ON');
  raw.pragma('busy_timeout = 5000');
  if (!inMemory) {
    raw.pragma('journal_mode = WAL');
    raw.pragma('synchronous = NORMAL');
  }

  if (options.runMigrations !== false) {
    migrate(raw);
  }

  return {
    db: drizzle(raw, { schema }),
    raw,
    close: () => {
      raw.close();
    },
  };
}

/** テスト用。毎回まっさらな in-memory DB を作る。 */
export function openTestDatabase(): Database_ {
  return openDatabase({ path: ':memory:' });
}
