import { randomUUID } from 'node:crypto';
import { asc, desc, eq } from 'drizzle-orm';
import { appendAudit } from '../db/audit.js';
import type { Db } from '../db/client.js';
import { getMember } from '../db/members.js';
import { ledgerEntries, type LedgerRow } from '../db/schema.js';
import { formatUnits, parseUnits } from './units.js';

/**
 * BOAG の内部台帳。
 *
 * 実チェーンの OAG とは別物で、こちらはこのポータルの中だけで動く点である。
 * 実 OAG は掘って手に入れるもので、BOAG は合議で発行する。
 *
 * 複式にしてある。ひとつの動きは同じ tx_id を持つ複数行からなり、その合計は必ず 0。
 * 発行は特別口座から出て誰かに入る形で表す。したがって
 * **全行の合計が 0 でなければ、どこかで無から増えている**ことになり、検査で捕まえられる。
 *
 * 金額は最小単位 SOAG の整数 (1 BOAG = 10^16 SOAG)。JavaScript の数値では桁が
 * 足りないので BigInt で扱い、保存は 10 進文字列にする。画面と入力欄では
 * 小数 16 桁の BOAG として見せる (units.ts)。
 */

/** 発行元の特別口座。Discord ID は数字だけなので衝突しない。 */
export const SUPPLY_ACCOUNT = '@supply';

/** 外部サービスとの交換で使う相手側の口座。 */
export const EXCHANGE_ACCOUNT = '@exchange';

export type LedgerKind = LedgerRow['kind'];

export type LedgerFailure = { readonly ok: false; readonly reason: string };
export type LedgerOk = { readonly ok: true; readonly txId: string };
export type LedgerResult = LedgerOk | LedgerFailure;

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerError';
  }
}

export interface Movement {
  readonly accountId: string;
  readonly amount: bigint;
}

function isSpecial(accountId: string): boolean {
  return accountId.startsWith('@');
}

/** 口座の残高。 */
export function balanceOf(db: Db, accountId: string): bigint {
  return db
    .select()
    .from(ledgerEntries)
    .where(eq(ledgerEntries.accountId, accountId))
    .all()
    .reduce((sum, row) => sum + BigInt(row.amount), 0n);
}

/** 発行済みの総量。特別口座から出た分の合計。 */
export function totalIssued(db: Db): bigint {
  return -balanceOf(db, SUPPLY_ACCOUNT);
}

export interface AccountBalance {
  readonly accountId: string;
  readonly balance: bigint;
}

export function allBalances(db: Db): AccountBalance[] {
  const totals = new Map<string, bigint>();
  for (const row of db.select().from(ledgerEntries).all()) {
    totals.set(row.accountId, (totals.get(row.accountId) ?? 0n) + BigInt(row.amount));
  }
  return [...totals]
    .map(([accountId, balance]) => ({ accountId, balance }))
    .sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0));
}

export interface PostInput {
  readonly kind: LedgerKind;
  readonly movements: readonly Movement[];
  readonly ref?: string | null;
  readonly memo?: string;
  readonly now?: number;
}

/**
 * 台帳に 1 つの動きを書く。
 *
 * 合計が 0 でない動きは受け付けない。ここを通さずに行を足せないようにすることが、
 * 台帳が壊れない唯一の保証になる。
 */
export function post(db: Db, input: PostInput): string {
  const now = input.now ?? Date.now();

  if (input.movements.length < 2) {
    throw new LedgerError('動きは 2 行以上必要です（出どころと行き先）');
  }
  const total = input.movements.reduce((sum, m) => sum + m.amount, 0n);
  if (total !== 0n) {
    throw new LedgerError(`貸借が合いません（差分 ${total.toString()}）`);
  }
  for (const movement of input.movements) {
    if (movement.amount === 0n) throw new LedgerError('金額 0 の行は書けません');
  }

  const txId = randomUUID();
  for (const movement of input.movements) {
    db.insert(ledgerEntries)
      .values({
        id: randomUUID(),
        txId,
        accountId: movement.accountId,
        amount: movement.amount.toString(),
        kind: input.kind,
        ref: input.ref ?? null,
        memo: input.memo ?? '',
        createdAt: now,
      })
      .run();
  }
  return txId;
}

/**
 * 発行する。過半数の承認を経た提案からしか呼ばれない。
 *
 * 特別口座がその分だけマイナスになるので、発行総量はいつでも数えられる。
 */
export function mint(
  db: Db,
  input: {
    readonly to: string;
    readonly amount: bigint;
    readonly ref: string;
    readonly memo?: string;
    readonly now?: number;
  },
): LedgerResult {
  if (input.amount <= 0n) return { ok: false, reason: '発行額は 1 以上にしてください' };
  if (isSpecial(input.to)) return { ok: false, reason: '特別口座へは発行できません' };

  const txId = post(db, {
    kind: 'mint',
    ref: input.ref,
    memo: input.memo ?? '',
    now: input.now ?? Date.now(),
    movements: [
      { accountId: SUPPLY_ACCOUNT, amount: -input.amount },
      { accountId: input.to, amount: input.amount },
    ],
  });

  appendAudit(db, {
    at: input.now ?? Date.now(),
    actorMemberId: null,
    action: 'ledger.mint',
    detail: { to: input.to, amount: input.amount.toString(), proposalId: input.ref },
  });

  return { ok: true, txId };
}

/** 送る。残高が足りなければ断る。 */
export function transfer(
  db: Db,
  input: {
    readonly from: string;
    readonly to: string;
    readonly amount: bigint;
    /** 由来。投げ銭なら 'post:<id>'。 */
    readonly ref?: string;
    readonly memo?: string;
    readonly now?: number;
  },
): LedgerResult {
  const now = input.now ?? Date.now();

  return db.transaction((tx) => {
    if (input.amount <= 0n) return { ok: false, reason: '送る額は 1 以上にしてください' };
    if (input.from === input.to) return { ok: false, reason: '自分には送れません' };

    const available = balanceOf(tx, input.from);
    if (available < input.amount) {
      return {
        ok: false,
        reason: `残高が足りません（残高 ${available.toString()}、送ろうとした額 ${input.amount.toString()}）`,
      };
    }

    const txId = post(tx, {
      kind: 'transfer',
      ref: input.ref ?? null,
      memo: input.memo ?? '',
      now,
      movements: [
        { accountId: input.from, amount: -input.amount },
        { accountId: input.to, amount: input.amount },
      ],
    });

    appendAudit(tx, {
      at: now,
      actorMemberId: input.from,
      action: 'ledger.transfer',
      detail: { to: input.to, amount: input.amount.toString(), ref: input.ref ?? null },
    });

    return { ok: true, txId };
  });
}

/**
 * メンバー同士で送る。画面から直接呼ぶ入口。
 *
 * transfer は口座しか見ないので、相手が今どういう状態かの判断はここで行う。
 * 停止・除名された人へ送ると、受け取り手が使えないまま残高だけが動いてしまう。
 * 提案は要らない。自分の残高を動かすだけで、無から増えるわけではないため。
 */
export function sendToMember(
  db: Db,
  input: {
    readonly fromMemberId: string;
    /** 宛先のメンバー ID。画面の一覧から選ぶ。 */
    readonly toMemberId: string;
    /** 入力欄に入った BOAG の 10 進表記。 */
    readonly amount: string;
    readonly memo?: string;
    readonly now?: number;
  },
): LedgerResult {
  const sender = getMember(db, input.fromMemberId);
  if (sender === undefined || sender.status !== 'active') {
    return { ok: false, reason: '有効なメンバーだけが送れます' };
  }

  const recipient = getMember(db, input.toMemberId);
  if (recipient === undefined) return { ok: false, reason: 'その宛先のメンバーはいません' };
  if (recipient.id === sender.id) return { ok: false, reason: '自分には送れません' };
  if (recipient.status !== 'active') {
    return { ok: false, reason: '相手が今は受け取れない状態です' };
  }

  const amount = parseAmount(input.amount);
  if (amount === undefined) {
    return { ok: false, reason: '送る額は 0 より大きく、小数 16 桁までで入れてください' };
  }

  return transfer(db, {
    from: sender.id,
    to: recipient.id,
    amount,
    memo: (input.memo ?? '').trim().slice(0, 200),
    now: input.now ?? Date.now(),
  });
}

/** 焼却する。特別口座へ戻すので、発行総量が減る。 */
export function burn(
  db: Db,
  input: {
    readonly from: string;
    readonly amount: bigint;
    readonly memo?: string;
    readonly now?: number;
  },
): LedgerResult {
  const now = input.now ?? Date.now();

  return db.transaction((tx) => {
    if (input.amount <= 0n) return { ok: false, reason: '焼却額は 1 以上にしてください' };
    const available = balanceOf(tx, input.from);
    if (available < input.amount) return { ok: false, reason: '残高が足りません' };

    const txId = post(tx, {
      kind: 'burn',
      memo: input.memo ?? '',
      now,
      movements: [
        { accountId: input.from, amount: -input.amount },
        { accountId: SUPPLY_ACCOUNT, amount: input.amount },
      ],
    });

    appendAudit(tx, {
      at: now,
      actorMemberId: input.from,
      action: 'ledger.burn',
      detail: { amount: input.amount.toString() },
    });

    return { ok: true, txId };
  });
}

export type LedgerVerification =
  | { readonly ok: true; readonly entries: number; readonly issued: bigint }
  | { readonly ok: false; readonly reason: string; readonly imbalance: bigint };

/**
 * 台帳が壊れていないか検査する。
 *
 * 全行の合計が 0 であること、動きごとの合計も 0 であること、
 * そして特別口座以外がマイナスになっていないこと。
 */
export function verifyLedger(db: Db): LedgerVerification {
  const rows = db.select().from(ledgerEntries).orderBy(asc(ledgerEntries.createdAt)).all();

  const total = rows.reduce((sum, row) => sum + BigInt(row.amount), 0n);
  if (total !== 0n) {
    return { ok: false, reason: '台帳全体の貸借が合いません', imbalance: total };
  }

  const perTx = new Map<string, bigint>();
  for (const row of rows) {
    perTx.set(row.txId, (perTx.get(row.txId) ?? 0n) + BigInt(row.amount));
  }
  for (const [txId, sum] of perTx) {
    if (sum !== 0n) {
      return { ok: false, reason: `動き ${txId} の貸借が合いません`, imbalance: sum };
    }
  }

  for (const { accountId, balance } of allBalances(db)) {
    if (!isSpecial(accountId) && balance < 0n) {
      return { ok: false, reason: `${accountId} の残高がマイナスです`, imbalance: balance };
    }
  }

  return { ok: true, entries: rows.length, issued: totalIssued(db) };
}

export function historyOf(db: Db, accountId: string, limit = 50): LedgerRow[] {
  return db
    .select()
    .from(ledgerEntries)
    .where(eq(ledgerEntries.accountId, accountId))
    .orderBy(desc(ledgerEntries.createdAt))
    .limit(limit)
    .all();
}

export interface MovementView {
  readonly txId: string;
  readonly kind: LedgerKind;
  /** その口座から見た増減。受け取りなら正、送りなら負。 */
  readonly amount: bigint;
  /** 動きの相手側の口座。'@supply' のような特別口座もそのまま返す。 */
  readonly counterparty: string | null;
  readonly memo: string;
  readonly ref: string | null;
  readonly createdAt: number;
}

/**
 * 口座の動きを、相手の口座つきで新しい順に返す。
 *
 * 台帳は 1 つの動きを複数行に分けて持つので、自分の行だけでは相手が分からない。
 * 同じ tx_id の中から符号が逆の行を引いて相手とする。
 */
export function recentMovements(db: Db, accountId: string, limit = 50): MovementView[] {
  return historyOf(db, accountId, limit).map((row) => {
    const amount = BigInt(row.amount);
    const other = db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.txId, row.txId))
      .all()
      .find((entry) => entry.accountId !== accountId && BigInt(entry.amount) * amount < 0n);

    return {
      txId: row.txId,
      kind: row.kind,
      amount,
      counterparty: other?.accountId ?? null,
      memo: row.memo,
      ref: row.ref,
      createdAt: row.createdAt,
    };
  });
}

/** SOAG の整数を BOAG の 10 進表記にする。単位は付けない。 */
export function formatAmount(amount: bigint): string {
  return formatUnits(amount);
}

/** 入力欄の BOAG を SOAG の整数にする。0 以下や小数 17 桁以上は undefined。 */
export function parseAmount(raw: string): bigint | undefined {
  const value = parseUnits(raw);
  return value !== undefined && value > 0n ? value : undefined;
}
