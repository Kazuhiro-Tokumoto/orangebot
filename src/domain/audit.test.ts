import { describe, expect, it } from 'vitest';
import { appendAudit, readChain, verifyAuditLog } from '../db/audit.js';
import { openTestDatabase } from '../db/client.js';
import { auditLog } from '../db/schema.js';
import { GENESIS_HASH, buildEntry, canonicalJson, verifyChain } from './audit.js';

describe('canonicalJson', () => {
  it('キーの順番が違っても同じ表現になる', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it('入れ子でも順番を揃える', () => {
    expect(canonicalJson({ x: { q: 1, p: 2 } })).toBe('{"x":{"p":2,"q":1}}');
  });

  it('配列の順番は保つ', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('undefined の値は落とす', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe('verifyChain', () => {
  const chain = () => {
    const first = buildEntry({
      prevSeq: 0,
      prevHash: GENESIS_HASH,
      at: 1000,
      actorMemberId: 'a',
      action: 'member.create',
      detail: { username: 'kazuhiro-tokumoto' },
    });
    const second = buildEntry({
      prevSeq: first.seq,
      prevHash: first.hash,
      at: 2000,
      actorMemberId: 'a',
      action: 'proposal.open',
      detail: { id: 'p1' },
    });
    return [first, second];
  };

  it('素直な連鎖は通る', () => {
    const result = verifyChain(chain());
    expect(result).toEqual({ ok: true, length: 2 });
  });

  it('空のログも有効', () => {
    expect(verifyChain([])).toEqual({ ok: true, length: 0 });
  });

  it('内容を書き換えると検出する', () => {
    const rows = chain();
    const tampered = [{ ...rows[0]!, action: 'member.delete' }, rows[1]!];
    const result = verifyChain(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.brokenAt).toBe(1);
  });

  it('途中の行を抜くと検出する', () => {
    const rows = chain();
    const result = verifyChain([rows[1]!]);
    expect(result.ok).toBe(false);
  });

  it('順番を入れ替えると検出する', () => {
    const rows = chain();
    const result = verifyChain([rows[1]!, rows[0]!]);
    expect(result.ok).toBe(false);
  });
});

describe('監査ログの保存', () => {
  it('追記した内容を読み戻して検証できる', () => {
    const { db, close } = openTestDatabase();
    try {
      appendAudit(db, { actorMemberId: null, action: 'bootstrap', detail: { n: 1 } });
      appendAudit(db, { actorMemberId: 'm1', action: 'proposal.open', detail: { id: 'p1' } });
      appendAudit(db, { actorMemberId: 'm1', action: 'vote.cast', detail: { choice: 'approve' } });

      const rows = readChain(db);
      expect(rows).toHaveLength(3);
      expect(rows[0]?.prevHash).toBe(GENESIS_HASH);
      expect(rows[1]?.prevHash).toBe(rows[0]?.hash);
      expect(verifyAuditLog(db)).toEqual({ ok: true, length: 3 });
    } finally {
      close();
    }
  });

  it('保存済みの行を書き換えると検証が失敗する', () => {
    const { db, raw, close } = openTestDatabase();
    try {
      appendAudit(db, { actorMemberId: null, action: 'bootstrap', detail: {} });
      appendAudit(db, { actorMemberId: 'm1', action: 'member.remove', detail: { id: 'victim' } });
      expect(verifyAuditLog(db).ok).toBe(true);

      // ログを直接書き換える。ハッシュは古いままなので連鎖が壊れる。
      raw.prepare("UPDATE audit_log SET action = 'member.add' WHERE seq = 2").run();

      const result = verifyAuditLog(db);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.brokenAt).toBe(2);
    } finally {
      close();
    }
  });

  it('行を削除しても検証が失敗する', () => {
    const { db, raw, close } = openTestDatabase();
    try {
      appendAudit(db, { actorMemberId: null, action: 'a' });
      appendAudit(db, { actorMemberId: null, action: 'b' });
      appendAudit(db, { actorMemberId: null, action: 'c' });

      raw.prepare('DELETE FROM audit_log WHERE seq = 2').run();

      expect(verifyAuditLog(db).ok).toBe(false);
    } finally {
      close();
    }
  });

  it('detail のキー順が変わってもハッシュは一致したまま', () => {
    const { db, raw, close } = openTestDatabase();
    try {
      appendAudit(db, { actorMemberId: null, action: 'x', detail: { b: 1, a: 2 } });
      // 意味は同じでキー順だけ違う JSON に差し替える。
      raw.prepare('UPDATE audit_log SET detail = ? WHERE seq = 1').run('{"b":1,"a":2}');
      expect(verifyAuditLog(db).ok).toBe(true);
    } finally {
      close();
    }
  });

  it('seq は 1 から連番で振られる', () => {
    const { db, close } = openTestDatabase();
    try {
      appendAudit(db, { actorMemberId: null, action: 'a' });
      appendAudit(db, { actorMemberId: null, action: 'b' });
      const rows = db.select().from(auditLog).all();
      expect(rows.map((r) => r.seq)).toEqual([1, 2]);
    } finally {
      close();
    }
  });
});
