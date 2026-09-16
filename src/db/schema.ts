import { blob, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Drizzle のテーブル定義。実際の DDL は `migrations.ts` が持っており、こちらは型付きクエリ用。
 * 片方だけ変えると食い違うので、列を足すときは必ず両方に入れる。
 */

export const members = sqliteTable('members', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  displayName: text('display_name').notNull(),
  status: text('status', { enum: ['pending', 'active', 'suspended', 'removed'] }).notNull(),
  discordId: text('discord_id').unique(),
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
