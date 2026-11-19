/**
 * A user's answerer name — the name their asks are filed under on the
 * Questions card (core answererName). Null = their first name.
 */
import { eq } from 'drizzle-orm';
import { answererName, type AnswererSetting } from '@mindblown/core';
import { db } from './connection.js';
import { users } from './schema.js';

const COLS = { name: users.name, email: users.email, answererName: users.answererName };

function setting(row: { name: string; email: string; answererName: string | null } | undefined): AnswererSetting | null {
  return row ? { answererName: row.answererName, effective: answererName(row.name || row.email, row.answererName) } : null;
}

/** The user's answerer name as set and as in effect; null for an unknown user. */
export async function getAnswerer(userId: string): Promise<AnswererSetting | null> {
  const [row] = await db.select(COLS).from(users).where(eq(users.id, userId));
  return setting(row);
}

/** Set (null / "" clears it: back to the first name); null for an unknown user. */
export async function setAnswerer(userId: string, name: string | null): Promise<AnswererSetting | null> {
  const [row] = await db
    .update(users)
    .set({ answererName: name?.trim() || null })
    .where(eq(users.id, userId))
    .returning(COLS);
  return setting(row);
}

/** The name a user's asks go under: their answerer name, else first name, else "Dan". */
export async function userAnswerer(userId: string): Promise<string> {
  return (await getAnswerer(userId))?.effective ?? answererName(null);
}
