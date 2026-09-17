import { blob, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Drizzle のテーブル定義。実際の DDL は `migrations.ts` が持っており、こちらは型付きクエリ用。
 * 片方だけ変えると食い違うので、列を足すときは必ず両方に入れる。
 */

export const members = sqliteTable('members', {
  /** Discord のユーザー ID。snowflake を文字列のまま持つ。 */
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  displayName: text('display_name').notNull(),
  status: text('status', { enum: ['pending', 'active', 'suspended', 'removed'] }).notNull(),
  createdAt: integer('created_at').notNull(),
  activatedAt: integer('activated_at'),
});

export const passwordCredentials = sqliteTable('password_credentials', {
  memberId: text('member_id')
    .primaryKey()
    .references(() => members.id, { onDelete: 'cascade' }),
  hash: text('hash').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const totpCredentials = sqliteTable('totp_credentials', {
  memberId: text('member_id')
    .primaryKey()
    .references(() => members.id, { onDelete: 'cascade' }),
  secretCipher: blob('secret_cipher', { mode: 'buffer' }).notNull(),
  confirmedAt: integer('confirmed_at'),
  createdAt: integer('created_at').notNull(),
});

export const passkeys = sqliteTable('passkeys', {
  id: text('id').primaryKey(),
  memberId: text('member_id')
    .notNull()
    .references(() => members.id, { onDelete: 'cascade' }),
  publicKey: blob('public_key', { mode: 'buffer' }).notNull(),
  counter: integer('counter').notNull().default(0),
  transports: text('transports').notNull().default('[]'),
  deviceType: text('device_type').notNull().default('singleDevice'),
  backedUp: integer('backed_up').notNull().default(0),
  nickname: text('nickname').notNull(),
  createdAt: integer('created_at').notNull(),
  lastUsedAt: integer('last_used_at'),
});

export const recoveryCodes = sqliteTable('recovery_codes', {
  id: text('id').primaryKey(),
  memberId: text('member_id')
    .notNull()
    .references(() => members.id, { onDelete: 'cascade' }),
  codeHash: text('code_hash').notNull().unique(),
  createdAt: integer('created_at').notNull(),
  usedAt: integer('used_at'),
});

export const proposals = sqliteTable('proposals', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  summary: text('summary').notNull().default(''),
  payload: text('payload').notNull().default('{}'),
  proposedBy: text('proposed_by').references(() => members.id),
  subjectMemberId: text('subject_member_id').references(() => members.id),
  status: text('status', {
    enum: ['open', 'approved', 'rejected', 'executed', 'expired', 'cancelled'],
  }).notNull(),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  decidedAt: integer('decided_at'),
  executedAt: integer('executed_at'),
});

export const proposalVoters = sqliteTable(
  'proposal_voters',
  {
    proposalId: text('proposal_id')
      .notNull()
      .references(() => proposals.id, { onDelete: 'cascade' }),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.proposalId, table.memberId] })],
);

export const votes = sqliteTable(
  'votes',
  {
    proposalId: text('proposal_id')
      .notNull()
      .references(() => proposals.id, { onDelete: 'cascade' }),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    choice: text('choice', { enum: ['approve', 'reject'] }).notNull(),
    votedAt: integer('voted_at').notNull(),
    voidedAt: integer('voided_at'),
  },
  (table) => [primaryKey({ columns: [table.proposalId, table.memberId] })],
);

export const tickets = sqliteTable('tickets', {
  id: text('id').primaryKey(),
  kind: text('kind', { enum: ['enroll', 'password_reset'] }).notNull(),
  memberId: text('member_id')
    .notNull()
    .references(() => members.id, { onDelete: 'cascade' }),
  proposalId: text('proposal_id').references(() => proposals.id, { onDelete: 'set null' }),
  status: text('status', { enum: ['pending', 'active', 'used', 'revoked'] }).notNull(),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  usedAt: integer('used_at'),
});

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  memberId: text('member_id')
    .notNull()
    .references(() => members.id, { onDelete: 'cascade' }),
  aal: integer('aal').notNull(),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  lastSeenAt: integer('last_seen_at').notNull(),
  ip: text('ip'),
  userAgent: text('user_agent'),
});

export const webauthnChallenges = sqliteTable('webauthn_challenges', {
  id: text('id').primaryKey(),
  memberId: text('member_id').references(() => members.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['registration', 'authentication'] }).notNull(),
  challenge: text('challenge').notNull(),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
});

export const loginAttempts = sqliteTable('login_attempts', {
  key: text('key').primaryKey(),
  count: integer('count').notNull(),
  windowStart: integer('window_start').notNull(),
  lockedUntil: integer('locked_until'),
});

export const auditLog = sqliteTable('audit_log', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  at: integer('at').notNull(),
  actorMemberId: text('actor_member_id'),
  action: text('action').notNull(),
  detail: text('detail').notNull().default('{}'),
  prevHash: text('prev_hash').notNull(),
  hash: text('hash').notNull(),
});

export type MemberRow = typeof members.$inferSelect;
export type ProposalRow = typeof proposals.$inferSelect;
export type VoteRow = typeof votes.$inferSelect;
export type TicketRow = typeof tickets.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type PasskeyRow = typeof passkeys.$inferSelect;
export type AuditRow = typeof auditLog.$inferSelect;

export const ledgerEntries = sqliteTable('ledger_entries', {
  id: text('id').primaryKey(),
  /** 同じ動きに属する行をまとめる識別子。行の合計は必ず 0 になる。 */
  txId: text('tx_id').notNull(),
  /** メンバー ID、または '@supply' のような特別口座。 */
  accountId: text('account_id').notNull(),
  /** 符号付き整数の 10 進文字列。BigInt で扱う。 */
  amount: text('amount').notNull(),
  kind: text('kind', { enum: ['mint', 'transfer', 'burn', 'exchange'] }).notNull(),
  ref: text('ref'),
  memo: text('memo').notNull().default(''),
  createdAt: integer('created_at').notNull(),
});

export type LedgerRow = typeof ledgerEntries.$inferSelect;

export const wallets = sqliteTable('wallets', {
  id: text('id').primaryKey(),
  network: text('network', { enum: ['mainnet', 'testnet', 'regtest'] }).notNull(),
  account: integer('account').notNull().default(0),
  /** 口座の拡張公開鍵。住所を作るのに使う。秘密は含まない。 */
  xpub: text('xpub').notNull(),
  /** パスフレーズで封じた控え。中身は wallet/vault.ts の形式。 */
  vault: blob('vault', { mode: 'buffer' }).notNull(),
  nextReceive: integer('next_receive').notNull().default(0),
  nextChange: integer('next_change').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  createdBy: text('created_by').references(() => members.id, { onDelete: 'set null' }),
});

export type WalletRow = typeof wallets.$inferSelect;

export const posts = sqliteTable('posts', {
  id: text('id').primaryKey(),
  authorId: text('author_id')
    .notNull()
    .references(() => members.id),
  /** 返信先。先頭の投稿なら null。 */
  parentId: text('parent_id'),
  /** スレッドの先頭。先頭の投稿なら null。 */
  rootId: text('root_id'),
  body: text('body').notNull(),
  createdAt: integer('created_at').notNull(),
  deletedAt: integer('deleted_at'),
});

export type PostRow = typeof posts.$inferSelect;

export const oagSends = sqliteTable('oag_sends', {
  id: text('id').primaryKey(),
  proposalId: text('proposal_id').notNull().unique(),
  status: text('status', { enum: ['signed', 'broadcast', 'unknown', 'failed'] }).notNull(),
  txid: text('txid').notNull(),
  rawHex: text('raw_hex').notNull(),
  /** 使った出力 'txid:index' の JSON 配列。 */
  inputs: text('inputs').notNull(),
  toAddress: text('to_address').notNull(),
  /** atomic の 10 進文字列。 */
  amount: text('amount').notNull(),
  fee: text('fee').notNull(),
  change: text('change').notNull(),
  createdBy: text('created_by'),
  createdAt: integer('created_at').notNull(),
  broadcastAt: integer('broadcast_at'),
  error: text('error'),
});

export type OagSendRow = typeof oagSends.$inferSelect;

export const predictionRounds = sqliteTable('prediction_rounds', {
  /** '<シンボル>:<開始時刻>'。 */
  id: text('id').primaryKey(),
  symbol: text('symbol').notNull(),
  startsAt: integer('starts_at').notNull(),
  endsAt: integer('ends_at').notNull(),
  status: text('status', { enum: ['open', 'settled', 'refunded'] }).notNull(),
  openPrice: text('open_price'),
  closePrice: text('close_price'),
  outcome: text('outcome', { enum: ['up', 'down', 'flat'] }),
  settledAt: integer('settled_at'),
});

export type PredictionRoundRow = typeof predictionRounds.$inferSelect;

export const predictionBets = sqliteTable('prediction_bets', {
  id: text('id').primaryKey(),
  roundId: text('round_id').notNull(),
  memberId: text('member_id').notNull(),
  side: text('side', { enum: ['up', 'down'] }).notNull(),
  /** SOAG の 10 進文字列。 */
  stake: text('stake').notNull(),
  /** 決着後に払い戻した額。外れなら '0'。未決着なら null。 */
  payout: text('payout'),
  placedAt: integer('placed_at').notNull(),
});

export type PredictionBetRow = typeof predictionBets.$inferSelect;

export const exchangeDeposits = sqliteTable('exchange_deposits', {
  /** 相手が決めた取引の番号。 */
  id: text('id').primaryKey(),
  memberId: text('member_id').notNull(),
  /** pt の 10 進文字列。 */
  pt: text('pt').notNull(),
  /** 付けた SOAG の 10 進文字列。 */
  soag: text('soag').notNull(),
  bodyHash: text('body_hash').notNull(),
  ledgerTx: text('ledger_tx').notNull(),
  createdAt: integer('created_at').notNull(),
});

export type ExchangeDepositRow = typeof exchangeDeposits.$inferSelect;

export const exchangeWithdrawals = sqliteTable('exchange_withdrawals', {
  id: text('id').primaryKey(),
  memberId: text('member_id').notNull(),
  pt: text('pt').notNull(),
  soag: text('soag').notNull(),
  status: text('status', { enum: ['pending', 'delivered', 'refunded', 'stuck'] }).notNull(),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: integer('next_attempt_at').notNull(),
  lastError: text('last_error'),
  lastStatus: integer('last_status'),
  createdAt: integer('created_at').notNull(),
  settledAt: integer('settled_at'),
});

export type ExchangeWithdrawalRow = typeof exchangeWithdrawals.$inferSelect;

export const gameRounds = sqliteTable('game_rounds', {
  /** '<game>:<開始時刻>' または '<game>:<銘柄>:<開始時刻>'。 */
  id: text('id').primaryKey(),
  game: text('game', { enum: ['closest', 'ranking', 'volatility'] }).notNull(),
  /** closest と volatility は銘柄、ranking は比べる銘柄をカンマで並べたもの。 */
  subject: text('subject').notNull(),
  startsAt: integer('starts_at').notNull(),
  endsAt: integer('ends_at').notNull(),
  status: text('status', { enum: ['open', 'settled', 'refunded'] }).notNull(),
  /** 決着の中身の JSON。 */
  result: text('result'),
  settledAt: integer('settled_at'),
});

export type GameRoundRow = typeof gameRounds.$inferSelect;

export const gameEntries = sqliteTable('game_entries', {
  id: text('id').primaryKey(),
  roundId: text('round_id').notNull(),
  memberId: text('member_id').notNull(),
  /** closest は予想した値段、ranking は銘柄、volatility は値幅の帯。 */
  pick: text('pick').notNull(),
  /** SOAG の 10 進文字列。 */
  stake: text('stake').notNull(),
  payout: text('payout'),
  placedAt: integer('placed_at').notNull(),
});

export type GameEntryRow = typeof gameEntries.$inferSelect;

export const markets = sqliteTable('markets', {
  id: text('id').primaryKey(),
  proposalId: text('proposal_id').notNull().unique(),
  question: text('question').notNull(),
  /** 何をもって「はい」とするか。判定の投票で見る。 */
  criteria: text('criteria').notNull(),
  closesAt: integer('closes_at').notNull(),
  status: text('status', { enum: ['open', 'resolved', 'refunded'] }).notNull(),
  outcome: text('outcome', { enum: ['yes', 'no'] }),
  createdBy: text('created_by'),
  createdAt: integer('created_at').notNull(),
  resolvedAt: integer('resolved_at'),
  resolvedByProposal: text('resolved_by_proposal'),
});

export type MarketRow = typeof markets.$inferSelect;

export const marketBets = sqliteTable('market_bets', {
  id: text('id').primaryKey(),
  marketId: text('market_id').notNull(),
  memberId: text('member_id').notNull(),
  side: text('side', { enum: ['yes', 'no'] }).notNull(),
  /** SOAG の 10 進文字列。 */
  stake: text('stake').notNull(),
  payout: text('payout'),
  placedAt: integer('placed_at').notNull(),
});

export type MarketBetRow = typeof marketBets.$inferSelect;
