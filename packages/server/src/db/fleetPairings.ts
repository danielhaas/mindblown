/**
 * Fleet pairings (#506) — plain persistence. The rules (code format,
 * limits, who may confirm) live in services/fleetPairing.ts.
 */
import { and, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from './connection.js';
import { fleetPairings, users } from './schema.js';

export type PairingRow = typeof fleetPairings.$inferSelect;

/** Postgres rejects a malformed uuid with an error; callers get "not found" instead. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function insertPairing(input: {
  codeHash: string;
  secretHash: string;
  hostname: string;
  agent: string | null;
  model: string | null;
  slots: number;
  expiresAt: Date;
}): Promise<PairingRow | null> {
  // A code still in the table (a day at most) collides → the caller draws again.
  const [row] = await db.insert(fleetPairings).values(input).onConflictDoNothing({ target: fleetPairings.codeHash }).returning();
  return row ?? null;
}

/** Unconfirmed codes past their 10 minutes and anything older than a day. */
export async function prunePairings(now: Date): Promise<void> {
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  await db
    .delete(fleetPairings)
    .where(or(and(isNull(fleetPairings.confirmedAt), lt(fleetPairings.expiresAt, now)), lt(fleetPairings.createdAt, dayAgo)));
}

export async function countPendingPairings(now: Date): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(fleetPairings)
    .where(and(isNull(fleetPairings.confirmedAt), gt(fleetPairings.expiresAt, now)));
  return Number(row?.n ?? 0);
}

/** A code that can still be confirmed. */
export async function findOpenPairingByCode(codeHash: string, now: Date): Promise<PairingRow | null> {
  const [row] = await db
    .select()
    .from(fleetPairings)
    .where(and(eq(fleetPairings.codeHash, codeHash), isNull(fleetPairings.confirmedAt), gt(fleetPairings.expiresAt, now)));
  return row ?? null;
}

export async function getPairing(id: string): Promise<PairingRow | null> {
  if (!UUID_RE.test(id)) return null;
  const [row] = await db.select().from(fleetPairings).where(eq(fleetPairings.id, id));
  return row ?? null;
}

/**
 * Take the code: only one confirmation wins, and only while it is open.
 * `fleetId` may follow later (a new fleet is created after the code is taken).
 */
export async function claimPairing(
  codeHash: string,
  userId: string,
  fleetId: string | null,
  replaceKeys: boolean,
  now: Date,
): Promise<PairingRow | null> {
  const [row] = await db
    .update(fleetPairings)
    .set({ confirmedAt: now, confirmedBy: userId, fleetId, replaceKeys })
    .where(and(eq(fleetPairings.codeHash, codeHash), isNull(fleetPairings.confirmedAt), gt(fleetPairings.expiresAt, now)))
    .returning();
  return row ?? null;
}

export async function setPairingFleet(id: string, fleetId: string): Promise<void> {
  await db.update(fleetPairings).set({ fleetId }).where(eq(fleetPairings.id, id));
}

/** Creating the fleet failed after the code was taken: give the code back. */
export async function releasePairing(id: string): Promise<void> {
  await db
    .update(fleetPairings)
    .set({ confirmedAt: null, confirmedBy: null, fleetId: null, replaceKeys: false })
    .where(and(eq(fleetPairings.id, id), isNull(fleetPairings.collectedAt)));
}

/** Shown on the machine after pairing, so whoever runs it sees whose fleet it joined. */
export async function getUserName(userId: string): Promise<string | null> {
  const [row] = await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, userId));
  return row ? row.name || row.email : null;
}

/** The machine takes its key — exactly once. */
export async function markCollected(id: string, now: Date): Promise<boolean> {
  const rows = await db
    .update(fleetPairings)
    .set({ collectedAt: now })
    .where(and(eq(fleetPairings.id, id), isNull(fleetPairings.collectedAt)))
    .returning({ id: fleetPairings.id });
  return rows.length > 0;
}
