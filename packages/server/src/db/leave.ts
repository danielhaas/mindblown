/**
 * user_leave (#664): a person's days off, both ends inclusive. Entered by
 * the person (REST /api/me/leave, MCP add_leave), applied by the scheduler
 * on every map whose work that person does.
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { LeaveRange, MindMap, Node as CoreNode, PersonLeave } from '@mindblown/core';
import { db } from './connection.js';
import { userLeave, users } from './schema.js';

type Row = typeof userLeave.$inferSelect;

function toCore(r: Row): LeaveRange {
  return {
    id: r.id,
    userId: r.userId,
    startDate: String(r.startDate).slice(0, 10),
    endDate: String(r.endDate).slice(0, 10),
    note: r.note ?? null,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
  };
}

/** A person's leave, earliest first. */
export async function listLeave(userId: string): Promise<LeaveRange[]> {
  const rows = await db.select().from(userLeave).where(eq(userLeave.userId, userId)).orderBy(asc(userLeave.startDate));
  return rows.map(toCore);
}

export async function addLeave(userId: string, input: { startDate: string; endDate: string; note?: string | null }): Promise<LeaveRange> {
  const [row] = await db
    .insert(userLeave)
    .values({ userId, startDate: input.startDate, endDate: input.endDate, note: input.note?.trim() || null })
    .returning();
  return toCore(row);
}

/** Remove one of the person's own ranges; false when it is not theirs or gone. */
export async function removeLeave(userId: string, leaveId: string): Promise<boolean> {
  const rows = await db
    .delete(userLeave)
    .where(and(eq(userLeave.id, leaveId), eq(userLeave.userId, userId)))
    .returning({ id: userLeave.id });
  return rows.length > 0;
}

/** Leave of these people, with their names; people without leave are left out. */
export async function leaveOf(userIds: string[]): Promise<PersonLeave[]> {
  const ids = [...new Set(userIds)].filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  if (ids.length === 0) return [];
  const rows = await db
    .select({ leave: userLeave, name: users.name })
    .from(userLeave)
    .innerJoin(users, eq(users.id, userLeave.userId))
    .where(inArray(userLeave.userId, ids))
    .orderBy(asc(userLeave.startDate));
  const byUser = new Map<string, PersonLeave>();
  for (const { leave, name } of rows) {
    const r = toCore(leave);
    let p = byUser.get(r.userId);
    if (!p) byUser.set(r.userId, (p = { userId: r.userId, name, ranges: [] }));
    p.ranges.push({ startDate: r.startDate, endDate: r.endDate, note: r.note });
  }
  return [...byUser.values()];
}

/**
 * The leave a map's schedule needs: its workers' and its assignees'.
 * Returns the data with `leave` attached — what computeMapSchedule reads.
 */
export async function withMapLeave<T extends { map: MindMap; nodes: CoreNode[] }>(data: T): Promise<T & { leave: PersonLeave[] }> {
  const people = [...(data.map.workers ?? []), ...data.nodes.flatMap((n) => n.assigneeIds ?? [])];
  return { ...data, leave: await leaveOf(people) };
}
