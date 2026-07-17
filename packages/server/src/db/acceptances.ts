import { and, eq, isNull } from 'drizzle-orm';
import { db } from './connection.js';
import { requirementAcceptances, users } from './schema.js';

/**
 * Requirement acceptances (Abnahme) — human sign-off per requirement
 * node per user, orthogonal to the derived plan status.
 *
 * History model: append-only. `accept` inserts a new row; `revoke`
 * stamps `revoked_at` on the active row. A re-acceptance after a revoke
 * is a fresh row, so the full audit trail (who accepted/revoked what,
 * when, at which progress) is preserved forever.
 */

export type AcceptanceDecision = 'accepted' | 'rejected';

export interface Acceptance {
  id: string;
  mapId: string;
  nodeId: string;
  userId: string;
  userName: string;
  acceptedAt: string;
  progressAtAcceptance: number;
  nodeRevisionAtAcceptance: number;
  /** Verdict of this sign-off row. Pre-decision rows default to 'accepted'. */
  decision: AcceptanceDecision;
  /** Reviewer comment — always present on rejections (route-enforced). */
  comment: string | null;
}

function toIso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

/** All ACTIVE acceptances of a map, with the acceptor's display name. */
export async function listActiveAcceptances(mapId: string): Promise<Acceptance[]> {
  const rows = await db
    .select({
      id: requirementAcceptances.id,
      mapId: requirementAcceptances.mapId,
      nodeId: requirementAcceptances.nodeId,
      userId: requirementAcceptances.userId,
      userName: users.name,
      acceptedAt: requirementAcceptances.acceptedAt,
      progressAtAcceptance: requirementAcceptances.progressAtAcceptance,
      nodeRevisionAtAcceptance: requirementAcceptances.nodeRevisionAtAcceptance,
      decision: requirementAcceptances.decision,
      comment: requirementAcceptances.comment,
    })
    .from(requirementAcceptances)
    .innerJoin(users, eq(users.id, requirementAcceptances.userId))
    .where(and(eq(requirementAcceptances.mapId, mapId), isNull(requirementAcceptances.revokedAt)));
  return rows.map((r) => ({
    ...r,
    acceptedAt: toIso(r.acceptedAt),
    decision: (r.decision as AcceptanceDecision) ?? 'accepted',
  }));
}

/**
 * Record a verdict (accept or reject) on a requirement node. Snapshots
 * the derived progress and node revision the reviewer saw. Returns the
 * new row, or null when this user already has an ACTIVE verdict on the
 * node (idempotent — the 23505 on the partial unique index is mapped to
 * null so a double click never errors). Switching verdict = revoke the
 * old row first, then record the new one.
 */
export async function accept(
  mapId: string,
  nodeId: string,
  userId: string,
  progressAtAcceptance: number,
  nodeRevisionAtAcceptance: number,
  decision: AcceptanceDecision = 'accepted',
  comment: string | null = null,
): Promise<Acceptance | null> {
  try {
    const [row] = await db
      .insert(requirementAcceptances)
      .values({ mapId, nodeId, userId, progressAtAcceptance, nodeRevisionAtAcceptance, decision, comment })
      .returning();
    const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId));
    return {
      id: row.id,
      mapId: row.mapId,
      nodeId: row.nodeId,
      userId: row.userId,
      userName: u?.name ?? userId,
      acceptedAt: toIso(row.acceptedAt),
      progressAtAcceptance: row.progressAtAcceptance,
      nodeRevisionAtAcceptance: row.nodeRevisionAtAcceptance,
      decision: (row.decision as AcceptanceDecision) ?? 'accepted',
      comment: row.comment ?? null,
    };
  } catch (err) {
    const e = err as { code?: string; constraint?: string };
    if (e?.code === '23505' && e?.constraint === 'requirement_acceptances_active_unique') {
      return null;
    }
    throw err;
  }
}

/**
 * Revoke the caller's active acceptance on a node. Returns true when a
 * row was revoked, false when there was none (idempotent).
 */
export async function revoke(nodeId: string, userId: string): Promise<boolean> {
  const rows = await db
    .update(requirementAcceptances)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(requirementAcceptances.nodeId, nodeId),
        eq(requirementAcceptances.userId, userId),
        isNull(requirementAcceptances.revokedAt),
      ),
    )
    .returning({ id: requirementAcceptances.id });
  return rows.length > 0;
}
