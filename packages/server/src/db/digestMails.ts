/**
 * digest_mails (#597): per person, the local day of the last daily-mail
 * round and the opt-out. No row = mail on, never sent.
 */
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { db } from './connection.js';
import { digestMails, users } from './schema.js';

export interface DigestRecipient {
  id: string;
  email: string;
  name: string;
  lastSentOn: string | null;
}

/** People (not fleet service users) who have not switched the mail off. */
export async function listDigestRecipients(): Promise<DigestRecipient[]> {
  return db
    .select({ id: users.id, email: users.email, name: users.name, lastSentOn: digestMails.lastSentOn })
    .from(users)
    .leftJoin(digestMails, eq(digestMails.userId, users.id))
    .where(and(eq(users.kind, 'person'), or(isNull(digestMails.enabled), eq(digestMails.enabled, true))));
}

/**
 * Take `day` for this user: true once per day, false for every later call
 * that day (a second tick, a second API process) or when the mail is off.
 */
export async function claimDigestDay(userId: string, day: string): Promise<boolean> {
  const rows = await db
    .insert(digestMails)
    .values({ userId, lastSentOn: day })
    .onConflictDoUpdate({
      target: digestMails.userId,
      set: { lastSentOn: day },
      setWhere: sql`${digestMails.enabled} AND ${digestMails.lastSentOn} IS DISTINCT FROM ${day}`,
    })
    .returning({ userId: digestMails.userId });
  return rows.length > 0;
}

/**
 * The day's mail failed to send (#602): count the failure, and unless this
 * was attempt `maxAttempts` give the day back (last_sent_on → `previous`),
 * so the next tick tries again. Returns the attempts made today and whether
 * the day was released.
 */
export async function releaseDigestDay(
  userId: string,
  day: string,
  previous: string | null,
  maxAttempts: number,
): Promise<{ attempts: number; released: boolean }> {
  const attempts = sql`CASE WHEN ${digestMails.failedOn} = ${day} THEN ${digestMails.failures} + 1 ELSE 1 END`;
  const [row] = await db
    .update(digestMails)
    .set({
      failures: attempts,
      failedOn: day,
      lastSentOn: sql`CASE WHEN ${attempts} < ${maxAttempts} THEN ${previous}::date ELSE ${digestMails.lastSentOn} END`,
    })
    .where(eq(digestMails.userId, userId))
    .returning({ attempts: digestMails.failures, lastSentOn: digestMails.lastSentOn });
  if (!row) return { attempts: 0, released: false };
  return { attempts: row.attempts, released: row.lastSentOn !== day };
}

export async function getDigestMailEnabled(userId: string): Promise<boolean> {
  const [row] = await db.select({ enabled: digestMails.enabled }).from(digestMails).where(eq(digestMails.userId, userId));
  return row?.enabled ?? true;
}

export async function setDigestMailEnabled(userId: string, enabled: boolean): Promise<void> {
  await db
    .insert(digestMails)
    .values({ userId, enabled })
    .onConflictDoUpdate({ target: digestMails.userId, set: { enabled } });
}
