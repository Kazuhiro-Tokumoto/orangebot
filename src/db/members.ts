import { asc, eq, inArray } from 'drizzle-orm';
import type { Db } from './client.js';
import { members, type MemberRow } from './schema.js';

export function getMember(db: Db, id: string): MemberRow | undefined {
  return db.select().from(members).where(eq(members.id, id)).get();
}

export function getMemberByUsername(db: Db, username: string): MemberRow | undefined {
  return db.select().from(members).where(eq(members.username, username)).get();
}

/** メンバー ID は Discord のユーザー ID そのものなので、引き方は getMember と同じ。 */
export const getMemberByDiscordId = getMember;

/** Discord の snowflake として妥当な形か。 */
export function isDiscordId(value: string): boolean {
  return /^\d{17,20}$/.test(value);
}

/** 有権者になれるメンバー。加入前・停止中・除名済みは含まない。 */
export function listActiveMembers(db: Db): MemberRow[] {
  return db
    .select()
    .from(members)
    .where(eq(members.status, 'active'))
    .orderBy(asc(members.username))
    .all();
}

export function listMembers(db: Db): MemberRow[] {
  return db
    .select()
    .from(members)
    .where(inArray(members.status, ['pending', 'active', 'suspended']))
    .orderBy(asc(members.username))
    .all();
}

export function listAllMembers(db: Db): MemberRow[] {
  return db.select().from(members).orderBy(asc(members.username)).all();
}

export function countActiveMembers(db: Db): number {
  return listActiveMembers(db).length;
}

export function setMemberStatus(
  db: Db,
  id: string,
  status: MemberRow['status'],
  now: number,
): void {
  const activatedAt = status === 'active' ? now : undefined;
  db.update(members)
    .set(activatedAt === undefined ? { status } : { status, activatedAt })
    .where(eq(members.id, id))
    .run();
}

export function isUsernameTaken(db: Db, username: string): boolean {
  return getMemberByUsername(db, username) !== undefined;
}
