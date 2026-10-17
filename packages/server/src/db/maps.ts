import { and, eq, inArray, or } from 'drizzle-orm';
import { buildBaseline, capBaselines } from '../lib/mapSchedule.js';
import { db } from './connection.js';
import { maps, mapPermissions, nodes } from './schema.js';
import { dbMapToCore, dbNodeToCore } from './helpers.js';
import { notDeleted } from './nodes.js';
import { recordMapFieldChanges } from './events.js';
import type { MindMap, Node as CoreNode, StatusDef, PhaseDef, CustomFieldDef, LayoutMode, EffortUnit, Baseline, ProfilePolicy, AiPolicy } from '@mindblown/core';
import { clampFleetShare, clampFocusFactor, isAiPolicy } from '@mindblown/core';

// ── Create ─────────────────────────────────────────────────────────

export interface CreateMapInput {
  name: string;
  description?: string;
  workspaceId: string;
  createdBy: string;
  effortUnit?: EffortUnit;
  /** Per-map AI policy (#375), chosen at creation. Invalid → 'any'. */
  aiPolicy?: AiPolicy;
}

export async function createMap(input: CreateMapInput): Promise<{ map: MindMap; rootNode: CoreNode }> {
  const now = new Date();

  // Create the map first (without rootNodeId)
  const [mapRow] = await db.insert(maps).values({
    name: input.name,
    description: input.description ?? null,
    workspaceId: input.workspaceId,
    createdBy: input.createdBy,
    effortUnit: input.effortUnit ?? 'days',
    aiPolicy: isAiPolicy(input.aiPolicy) ? input.aiPolicy : 'any',
    createdAt: now,
    updatedAt: now,
  }).returning();

  // Create the root node
  const [rootRow] = await db.insert(nodes).values({
    mapId: mapRow.id,
    parentId: null,
    childrenOrder: [],
    text: input.name,
    collapsed: false,
    assigneeIds: [],
    tags: [],
    customFields: {},
    dependencies: [],
    externalLinks: [],
    attachments: [],
    createdAt: now,
    updatedAt: now,
    createdBy: input.createdBy,
  }).returning();

  // Update map with rootNodeId
  const [updatedMap] = await db.update(maps)
    .set({ rootNodeId: rootRow.id })
    .where(eq(maps.id, mapRow.id))
    .returning();

  return {
    map: dbMapToCore(updatedMap as unknown as Record<string, unknown>),
    rootNode: dbNodeToCore(rootRow as unknown as Record<string, unknown>),
  };
}

// ── Get (settings only) ────────────────────────────────────────────

/** The map's status workflow without loading its nodes; null = no such map. */
export async function getStatusWorkflow(mapId: string): Promise<StatusDef[] | null> {
  const [row] = await db.select({ statusWorkflow: maps.statusWorkflow }).from(maps).where(eq(maps.id, mapId));
  if (!row) return null;
  return (row.statusWorkflow as StatusDef[]) ?? [];
}

// ── Get (with all nodes) ───────────────────────────────────────────

export async function getMap(mapId: string): Promise<{ map: MindMap; nodes: CoreNode[] } | null> {
  const [mapRow] = await db.select().from(maps).where(eq(maps.id, mapId));
  if (!mapRow) return null;

  const nodeRows = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.mapId, mapId), notDeleted));

  return {
    map: dbMapToCore(mapRow as unknown as Record<string, unknown>),
    nodes: nodeRows.map((r) => dbNodeToCore(r as unknown as Record<string, unknown>)),
  };
}

// ── List ───────────────────────────────────────────────────────────

export async function listMaps(): Promise<MindMap[]> {
  const rows = await db.select().from(maps).orderBy(maps.createdAt);
  return rows.map((r) => dbMapToCore(r as unknown as Record<string, unknown>));
}

/**
 * Lists maps a user can see: ones they created plus ones explicitly shared
 * via mapPermissions. The detail/update/delete routes already enforce ACL
 * per request — this just keeps unshared maps off the home screen.
 */
export async function listMapsForUser(userId: string): Promise<MindMap[]> {
  const sharedMapIds = db
    .select({ mapId: mapPermissions.mapId })
    .from(mapPermissions)
    .where(eq(mapPermissions.userId, userId));

  const rows = await db
    .select()
    .from(maps)
    .where(or(eq(maps.createdBy, userId), inArray(maps.id, sharedMapIds)))
    .orderBy(maps.createdAt);
  return rows.map((r) => dbMapToCore(r as unknown as Record<string, unknown>));
}

// ── Update ─────────────────────────────────────────────────────────

export interface UpdateMapInput {
  name?: string;
  description?: string | null;
  effortUnit?: EffortUnit;
  statusWorkflow?: StatusDef[];
  customFieldDefs?: CustomFieldDef[];
  defaultLayout?: LayoutMode;
  healthThreshold?: number;
  /**
   * Project phase definitions — full replacement array (statusWorkflow
   * idiom). Reorder = new `position` values; rename = same `id`, new
   * `name` (node phaseIds stay valid because ids are stable).
   */
  phases?: PhaseDef[];
  baselines?: Baseline[];
  wipLimit?: number | null;
  projectStartDate?: string | null;
  hoursPerDay?: number;
  workerCount?: number;
  focusFactor?: number;
  /** Pull-queue claim cap (int ≥ 0; 0 = hold). */
  maxActiveClaims?: number;
  /** Pull-queue AND-filter: `version:<id>` / `type:bug`. Empty = open. */
  dispatchGate?: string[];
  /** Pull-queue ranking keys (bugs|priority|size|age, plus at most one
   *  parametric `mix:bugs=<0-100>` weave entry). Empty = default. The
   *  weave PHASE (maps.dispatch_mix_acc) is deliberately NOT updatable
   *  here — services/orchestration owns it, inside the grant tx. */
  dispatchPolicy?: string[];
  /** Profile routing table (#262); null clears = profile-blind queue. */
  profilePolicy?: ProfilePolicy | null;
  /**
   * Connect to a fleet (#477), null disconnects. Who may do it (admin on the
   * map, owner of the fleet) is checked by the callers through
   * services/fleets `authorizeMapFleetChange` — not here.
   */
  fleetId?: string | null;
  /** Weight inside the fleet (#478); clamped to 0.1–100. */
  fleetShare?: number;
  githubInstallationId?: string | null;
  githubRepoOwner?: string | null;
  githubRepoName?: string | null;
  autoImportNewIssues?: boolean;
  githubInboxNodeId?: string | null;
  triageEnabled?: boolean;
  triageLabelWriteback?: boolean;
  /** Per-map AI policy (#375). Invalid values are ignored, not stored. */
  aiPolicy?: AiPolicy;
  /** Draft estimates for committed work (#318). */
  aiEstimateDrafts?: boolean;
  /** #110 — date-holidays code; null clears. Validated by the route / tool. */
  holidayJurisdiction?: string | null;
  /** #110 — full replacement of the map's own days off. */
  holidayOverrides?: { add: string[]; remove: string[] };
  /**
   * Archive switch. `true` stamps `archivedAt` now (idempotent — an
   * already-archived map keeps its original stamp), `false` clears it.
   * An archived map is read-only for every unattended path: no forge
   * ingest, no triage, no dispatch, no housekeeping, no snapshots — see
   * isMapArchived(). Humans can still open, edit and unarchive it.
   */
  archived?: boolean;
}

// The archive check lives in ./archived.ts (kept out of this module's
// import graph on purpose). Re-exported so callers keep the
// `mapDb.isMapArchived(id)` spelling.
export { isMapArchived } from './archived.js';

/**
 * Update map settings. `userId` attributes the change_events rows written
 * for audited fields (dispatch knobs etc., see AUDITED_MAP_FIELDS); null
 * for system writes. The before-row is read first so the diff is against
 * what was persisted, not against what the caller assumed.
 */
export async function updateMap(
  mapId: string,
  input: UpdateMapInput,
  userId: string | null = null,
): Promise<MindMap | null> {
  const [beforeRow] = await db.select().from(maps).where(eq(maps.id, mapId));
  if (!beforeRow) return null;
  const before = dbMapToCore(beforeRow as unknown as Record<string, unknown>);

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (input.name !== undefined) updates.name = input.name;
  if (input.description !== undefined) updates.description = input.description;
  if (input.effortUnit !== undefined) updates.effortUnit = input.effortUnit;
  if (input.statusWorkflow !== undefined) updates.statusWorkflow = input.statusWorkflow;
  if (input.customFieldDefs !== undefined) updates.customFieldDefs = input.customFieldDefs;
  if (input.defaultLayout !== undefined) updates.defaultLayout = input.defaultLayout;
  if (input.healthThreshold !== undefined) updates.healthThreshold = input.healthThreshold;
  if (input.phases !== undefined) updates.phases = input.phases;
  if (input.baselines !== undefined) updates.baselines = input.baselines;
  if (input.wipLimit !== undefined) updates.wipLimit = input.wipLimit;
  if (input.projectStartDate !== undefined) updates.projectStartDate = input.projectStartDate;
  if (input.hoursPerDay !== undefined) updates.hoursPerDay = input.hoursPerDay;
  if (input.workerCount !== undefined) updates.workerCount = input.workerCount;
  if (input.focusFactor !== undefined) updates.focusFactor = clampFocusFactor(input.focusFactor);
  if (input.maxActiveClaims !== undefined) updates.maxActiveClaims = Math.max(0, Math.floor(input.maxActiveClaims));
  if (input.dispatchGate !== undefined) updates.dispatchGate = input.dispatchGate;
  if (input.dispatchPolicy !== undefined) updates.dispatchPolicy = input.dispatchPolicy;
  if (input.profilePolicy !== undefined) updates.profilePolicy = input.profilePolicy;
  if (input.fleetId !== undefined) updates.fleetId = input.fleetId;
  if (input.fleetShare !== undefined) updates.fleetShare = clampFleetShare(input.fleetShare);
  if (input.githubInstallationId !== undefined) updates.githubInstallationId = input.githubInstallationId;
  if (input.githubRepoOwner !== undefined) updates.githubRepoOwner = input.githubRepoOwner;
  if (input.githubRepoName !== undefined) updates.githubRepoName = input.githubRepoName;
  if (input.autoImportNewIssues !== undefined) updates.autoImportNewIssues = input.autoImportNewIssues;
  if (input.githubInboxNodeId !== undefined) updates.githubInboxNodeId = input.githubInboxNodeId;
  if (input.triageEnabled !== undefined) updates.triageEnabled = input.triageEnabled;
  if (input.triageLabelWriteback !== undefined) updates.triageLabelWriteback = input.triageLabelWriteback;
  if (input.aiPolicy !== undefined && isAiPolicy(input.aiPolicy)) updates.aiPolicy = input.aiPolicy;
  if (typeof input.aiEstimateDrafts === 'boolean') updates.aiEstimateDrafts = input.aiEstimateDrafts;
  if (input.holidayJurisdiction !== undefined) updates.holidayJurisdiction = input.holidayJurisdiction;
  if (input.holidayOverrides !== undefined) updates.holidayOverrides = input.holidayOverrides;
  // Boolean only: a raw REST caller sending `archived: null` must not
  // unarchive by accident (the tool-kit schema already rejects it).
  if (typeof input.archived === 'boolean') {
    if (!input.archived) updates.archivedAt = null;
    else if (before.archivedAt == null) updates.archivedAt = new Date();
  }

  const [row] = await db.update(maps).set(updates).where(eq(maps.id, mapId)).returning();
  if (!row) return null;
  const updated = dbMapToCore(row as unknown as Record<string, unknown>);
  await recordMapFieldChanges(
    mapId,
    userId,
    before as unknown as Record<string, unknown>,
    updated as unknown as Record<string, unknown>,
  );
  return updated;
}

// ── Delete ─────────────────────────────────────────────────────────

export async function deleteMap(mapId: string): Promise<boolean> {
  // Nodes cascade-delete via FK
  const result = await db.delete(maps).where(eq(maps.id, mapId)).returning();
  return result.length > 0;
}

// ── Baseline ───────────────────────────────────────────────────────

/**
 * Freeze a baseline. Keeps the newest MAX_BASELINES; `dropped` names the
 * oldest ones that made room, so callers can say so.
 */
export async function createBaseline(mapId: string, name: string): Promise<{ map: MindMap; dropped: string[] } | null> {
  const data = await getMap(mapId);
  if (!data) return null;

  const baseline = buildBaseline(data, name);

  const { kept, dropped } = capBaselines([...(data.map.baselines ?? []), baseline]);

  const map = await updateMap(mapId, { baselines: kept });
  return map ? { map, dropped } : null;
}

/** Remove one baseline; null when the map or the baseline does not exist. */
export async function deleteBaseline(mapId: string, baselineId: string): Promise<MindMap | null> {
  const data = await getMap(mapId);
  if (!data) return null;
  const existing = data.map.baselines ?? [];
  if (!existing.some((b) => b.id === baselineId)) return null;
  return updateMap(mapId, { baselines: existing.filter((b) => b.id !== baselineId) });
}
