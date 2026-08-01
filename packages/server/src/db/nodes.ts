import { randomUUID } from 'node:crypto';
import { and, desc, eq, gte, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { db } from './connection.js';
import { nodes, maps, changeEvents } from './schema.js';
import { dbNodeToCore } from './helpers.js';
import { hasCycle, resolveStatusDef } from '@mindblown/core';
import type { Node as CoreNode, Dependency, DependencyType, ExternalLink, LinkedPrState, Priority, CustomFieldValue, NodeMap, StatusDef } from '@mindblown/core';
import { invalidateMapContext } from '../sync/mapContext.js';

// Soft-delete filter shared by every read that returns user-visible nodes.
// Audit / pre-delete-snapshot paths in routes/nodes.ts deliberately bypass
// this and read the row regardless of deleted_at.
export const notDeleted = isNull(nodes.deletedAt);

/**
 * A handle that can issue queries — either the global `db` or a transaction
 * handle (`tx`) from `db.transaction(async (tx) => ...)`. Both expose the
 * same drizzle query-builder surface (`select`, `insert`, `update`, ...);
 * `PgTransaction` extends `PgDatabase`, so a tx is structurally assignable
 * to this type modulo the `$client` field that only `db` carries (and which
 * we don't use here). Callers that want their `createNode`/`updateNode`
 * writes to roll back with an outer transaction pass the `tx` they got
 * from `db.transaction`; callers that don't care (the default) get
 * autocommit on the global `db`.
 *
 * We extract the tx type via `Parameters` to avoid a brittle dependency
 * on drizzle's private export paths.
 */
type DrizzleTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type DbHandle = typeof db | DrizzleTx;

/**
 * Thrown by updateNode when the caller passed an expectedRevision and the
 * row's current revision doesn't match — i.e. someone else wrote first.
 * Carries the current node so the route can return it to the client.
 */
export class RevisionConflictError extends Error {
  constructor(public current: CoreNode) {
    super(`Node ${current.id} was modified by someone else (revision ${current.revision})`);
    this.name = 'RevisionConflictError';
  }
}

/**
 * Thrown when a single updateNode call mixes `tags` (replace) with
 * `tagsAppend`/`tagsRemove` (merge). The two modes are mutually
 * exclusive so the caller can't silently lose tags they thought
 * they were keeping.
 */
export class TagsModeConflictError extends Error {
  constructor() {
    super('Cannot combine `tags` (replace) with `tagsAppend`/`tagsRemove` (merge) in the same update.');
    this.name = 'TagsModeConflictError';
  }
}

/**
 * Thrown when a create/update would give a node a requirementId that
 * another (non-deleted) node in the same map already carries. Requirement
 * IDs are stable business identifiers (e.g. 'MAN-01') — two nodes with
 * the same ID would make the requirements register ambiguous.
 */
export class RequirementIdConflictError extends Error {
  constructor(requirementId: string, existingNodeId?: string) {
    super(
      existingNodeId
        ? `Requirement ID "${requirementId}" is already used by node ${existingNodeId} in this map.`
        : `Requirement ID "${requirementId}" is already used by another node in this map.`,
    );
    this.name = 'RequirementIdConflictError';
  }
}

/**
 * True when a thrown pg error is a unique-violation (23505) on the
 * per-map requirement_id partial index. The app-level precheck catches
 * the sequential case with a friendlier message; this catches the
 * concurrent-create race the precheck can't see.
 */
function isRequirementIdUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string } | null;
  return e?.code === '23505' && e?.constraint === 'nodes_map_requirement_id_unique';
}

/**
 * Per-map uniqueness guard for requirementId. Application-level (no DB
 * constraint) — modeled on the dependency-duplicate guard below. Throws
 * RequirementIdConflictError when another non-deleted node in the map
 * already carries the ID.
 */
async function assertRequirementIdAvailable(
  handle: DbHandle,
  mapId: string,
  requirementId: string,
  excludeNodeId?: string,
): Promise<void> {
  const conditions = [
    eq(nodes.mapId, mapId),
    eq(nodes.requirementId, requirementId),
    notDeleted,
  ];
  if (excludeNodeId) conditions.push(ne(nodes.id, excludeNodeId));
  const [existing] = await handle
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(...conditions))
    .limit(1);
  if (existing) throw new RequirementIdConflictError(requirementId, existing.id as string);
}

// ── Tag merge math (exported for unit tests) ──────────────────────
//
// Used by updateNode to resolve `tagsAppend` / `tagsRemove` into a
// concrete `tags` array given the node's current tag set. Pure function
// so we can test it without a DB connection.
//
//   - tagsRemove is applied first; tags not present are no-ops.
//   - tagsAppend is then unioned in, preserving the existing order and
//     appending new tags after — dedup'd against the post-remove set.
//   - When tagsAppend and tagsRemove both name the same tag, append
//     wins (the final array contains it). This matches the natural
//     "swap one tag for another" use case where the caller asks to
//     re-add the same value as one being removed.
export function mergeTags(
  current: string[],
  append: string[] | undefined,
  remove: string[] | undefined,
): string[] {
  const removeSet = new Set(remove ?? []);
  const kept = current.filter((t) => !removeSet.has(t));
  if (!append || append.length === 0) return kept;
  return [...kept, ...append.filter((t) => !kept.includes(t))];
}

// ── Phase reference validation ────────────────────────────────────
//
// `nodes.phase_id` references a PhaseDef.id in `maps.phases` (jsonb,
// statusWorkflow idiom — no FK possible). Writes with an unknown id are
// rejected with PhaseIdValidationError → 400, so a typo'd/stale id
// can't silently orphan a node. null always passes (clears the phase).

export class PhaseIdValidationError extends Error {
  constructor(phaseId: string) {
    super(
      `Unknown phaseId "${phaseId}" — it does not reference a phase of this map. ` +
        `Add the phase to the map first (update_map phases / PUT /api/maps/:id).`,
    );
    this.name = 'PhaseIdValidationError';
  }
}

/**
 * Assert `phaseId` (when non-null) references a PhaseDef of the map.
 * Exported for unit tests (mergeTags pattern — testable with a stub
 * handle, no Postgres needed).
 */
export async function assertPhaseIdKnown(
  handle: DbHandle,
  mapId: string,
  phaseId: string | null | undefined,
): Promise<void> {
  if (phaseId == null) return;
  const [map] = await handle
    .select({ phases: maps.phases })
    .from(maps)
    .where(eq(maps.id, mapId));
  const defs = ((map?.phases as Array<{ id: string }>) ?? []);
  if (!defs.some((p) => p.id === phaseId)) {
    throw new PhaseIdValidationError(phaseId);
  }
}

// ── Auto-status from progress ─────────────────────────────────────
//
// When percentComplete moves but status is left untouched, we promote
// the status through the workflow's todo / in_progress / done categories:
//
//   0  (or null) → first status with category="todo"
//   1..99        → first status with category="in_progress"
//   100          → first status with category="done"
//
// To avoid clobbering manual choices, we leave the status alone when:
//   - the current status' category is already the target category
//     (so custom workflows like "Coding → Review → QA" all under
//     in_progress don't collapse to a single bucket), OR
//   - the current status uses a custom category outside the trio
//     above (e.g. "blocked"), so blocked/at_risk/etc. survive.

const AUTO_CATEGORIES = new Set(['todo', 'in_progress', 'done']);

async function deriveAutoStatus(
  mapId: string,
  currentStatus: string | null,
  newProgress: number | null | undefined,
  handle: DbHandle = db,
): Promise<string | undefined> {
  const targetCategory: 'todo' | 'in_progress' | 'done' =
    newProgress == null || newProgress <= 0
      ? 'todo'
      : newProgress >= 100
        ? 'done'
        : 'in_progress';

  const [map] = await handle
    .select({ statusWorkflow: maps.statusWorkflow })
    .from(maps)
    .where(eq(maps.id, mapId));
  const workflow = ((map?.statusWorkflow as StatusDef[]) ?? []);
  if (workflow.length === 0) return undefined;

  if (currentStatus != null) {
    const currentDef = workflow.find(
      (s) => s.id === currentStatus || s.name.toLowerCase() === currentStatus.toLowerCase(),
    );
    if (currentDef && !AUTO_CATEGORIES.has(currentDef.category)) return undefined;
    if (currentDef && currentDef.category === targetCategory) return undefined;
  }

  const sorted = [...workflow].sort((a, b) => a.position - b.position);
  const target = sorted.find((s) => s.category === targetCategory);
  return target?.id;
}

// ── Create ─────────────────────────────────────────────────────────

export interface CreateNodeInput {
  mapId: string;
  parentId: string;
  text: string;
  createdBy: string;
  position?: number; // index in parent's children_order; omit = append
  x?: number; // explicit canvas position; omit = auto-layout
  y?: number;
  effortEstimate?: number;
  percentComplete?: number;
  status?: string;
  priority?: Priority;
  startDate?: string;
  dueDate?: string;
  autoProgress?: 'off' | 'children';
  priorityRank?: number | null;
  completedAt?: string | null;
  requirementId?: string | null;
  requirementPriority?: 'must' | 'should' | 'could' | null;
  requirementText?: string | null;
  phaseId?: string | null;
  verificationText?: string | null;
  verificationUrl?: string | null;
  verificationVideoUrl?: string | null;
  assigneeIds?: string[];
}

export async function createNode(
  input: CreateNodeInput,
  /**
   * Optional transaction handle. When provided, the insert + parent
   * children_order update participate in the caller's tx and roll back
   * with it. When omitted (the common case), writes go through the
   * global `db` handle and autocommit individually.
   */
  txHandle?: DbHandle,
): Promise<CoreNode> {
  const handle: DbHandle = txHandle ?? db;
  const now = new Date();

  if (input.requirementId != null) {
    await assertRequirementIdAvailable(handle, input.mapId, input.requirementId);
  }

  // phaseId must reference a PhaseDef of this map (null = no phase).
  if (input.phaseId != null) {
    await assertPhaseIdKnown(handle, input.mapId, input.phaseId);
  }

  // Create the node
  let row;
  try {
    [row] = await handle.insert(nodes).values({
      mapId: input.mapId,
      parentId: input.parentId,
      childrenOrder: [],
      text: input.text,
      collapsed: false,
      x: input.x ?? null,
      y: input.y ?? null,
      effortEstimate: input.effortEstimate ?? null,
      percentComplete: input.percentComplete ?? null,
      status: input.status ?? null,
      priority: input.priority ?? null,
      startDate: input.startDate ?? null,
      dueDate: input.dueDate ?? null,
      autoProgress: input.autoProgress ?? 'off',
      priorityRank: input.priorityRank ?? null,
      completedAt: input.completedAt ? new Date(input.completedAt) : null,
      requirementId: input.requirementId ?? null,
      requirementPriority: input.requirementPriority ?? null,
      requirementText: input.requirementText ?? null,
      phaseId: input.phaseId ?? null,
      verificationText: input.verificationText ?? null,
      verificationUrl: input.verificationUrl ?? null,
      verificationVideoUrl: input.verificationVideoUrl ?? null,
      assigneeIds: input.assigneeIds ?? [],
      tags: [],
      customFields: {},
      dependencies: [],
      externalLinks: [],
      attachments: [],
      createdAt: now,
      updatedAt: now,
      createdBy: input.createdBy,
    }).returning();
  } catch (err) {
    if (isRequirementIdUniqueViolation(err)) {
      throw new RequirementIdConflictError(input.requirementId as string);
    }
    throw err;
  }

  // Add to parent's children_order
  const [parent] = await handle
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, input.parentId), notDeleted));
  if (parent) {
    const order = (parent.childrenOrder as string[]) ?? [];
    const idx = input.position;
    if (idx != null && idx >= 0 && idx < order.length) {
      order.splice(idx, 0, row.id);
    } else {
      order.push(row.id);
    }
    await handle.update(nodes)
      .set({ childrenOrder: order, updatedAt: now })
      .where(eq(nodes.id, input.parentId));
  }

  // Triage map-context cache invalidation (#92, #93). A new node may
  // be a depth-1 epic the next triage call should see. Cheap to call
  // unconditionally — the cache key is mapId, so a wasted invalidation
  // only forces one extra DB round-trip on the next triage.
  invalidateMapContext(input.mapId);

  return dbNodeToCore(row as unknown as Record<string, unknown>);
}

// ── Get ────────────────────────────────────────────────────────────

export async function getNode(nodeId: string): Promise<CoreNode | null> {
  const [row] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, nodeId), notDeleted));
  if (!row) return null;
  return dbNodeToCore(row as unknown as Record<string, unknown>);
}

// ── Update ─────────────────────────────────────────────────────────

export interface UpdateNodeInput {
  text?: string;
  description?: unknown;
  x?: number | null;
  y?: number | null;
  collapsed?: boolean;
  effortEstimate?: number | null;
  actualEffort?: number | null;
  percentComplete?: number | null;
  status?: string | null;
  blockedReason?: string | null;
  assigneeIds?: string[];
  priority?: Priority | null;
  dueDate?: string | null;
  startDate?: string | null;
  tags?: string[];
  /**
   * Add tags without clobbering the existing set. Dedup on merge.
   * Cannot be combined with `tags` (replace) in the same call —
   * the DB layer throws TagsModeConflictError so callers don't
   * silently lose intent.
   */
  tagsAppend?: string[];
  /** Remove tags from the existing set (no-op for tags not present). */
  tagsRemove?: string[];
  customFields?: Record<string, CustomFieldValue>;
  dependencies?: Dependency[];
  versionId?: string | null;
  cycleId?: string | null;
  externalLinks?: ExternalLink[];
  autoProgress?: 'off' | 'children';
  priorityRank?: number | null;
  completedAt?: string | null;
  requirementId?: string | null;
  requirementPriority?: 'must' | 'should' | 'could' | null;
  requirementText?: string | null;
  phaseId?: string | null;
  verificationText?: string | null;
  verificationUrl?: string | null;
  verificationVideoUrl?: string | null;
  // Orchestration substrate (#111)
  claimedBySession?: string | null;
  claimedAt?: string | null;
  scopes?: string[];
  // PR-state mirror written by the GH webhook handlers.
  linkedPr?: LinkedPrState | null;
}

export async function updateNode(
  nodeId: string,
  input: UpdateNodeInput,
  expectedRevision?: number,
  /**
   * Optional transaction handle. When provided, the update (and the
   * status-derivation / dependency-validation precheck reads) participate
   * in the caller's tx and roll back with it. When omitted, writes
   * autocommit on the global `db` handle.
   */
  txHandle?: DbHandle,
): Promise<CoreNode | null> {
  const handle: DbHandle = txHandle ?? db;

  // Validate dependencies if provided
  if (input.dependencies !== undefined) {
    await validateDependencies(nodeId, input.dependencies, handle);
  }

  // Resolve tags merge (append/remove) into a concrete `tags` write.
  // Replace-mode (`tags`) and merge-mode (`tagsAppend`/`tagsRemove`) are
  // mutually exclusive so callers can't accidentally clobber what they
  // also asked to add. When merging we read the current tags inside the
  // same handle (tx-safe) so a concurrent merge in another connection
  // doesn't race us into a lost-update — pair this with expectedRevision
  // for true serializability when the call chain demands it.
  if (input.tagsAppend !== undefined || input.tagsRemove !== undefined) {
    if (input.tags !== undefined) throw new TagsModeConflictError();
    const [row] = await handle
      .select({ tags: nodes.tags })
      .from(nodes)
      .where(and(eq(nodes.id, nodeId), notDeleted));
    if (row) {
      const current = (row.tags as string[]) ?? [];
      input.tags = mergeTags(current, input.tagsAppend, input.tagsRemove);
    }
    delete input.tagsAppend;
    delete input.tagsRemove;
  }

  // Per-map uniqueness of requirementId (application-level guard).
  if (input.requirementId != null) {
    const [row] = await handle
      .select({ mapId: nodes.mapId })
      .from(nodes)
      .where(and(eq(nodes.id, nodeId), notDeleted));
    if (row) {
      await assertRequirementIdAvailable(handle, row.mapId as string, input.requirementId, nodeId);
    }
  }

  // phaseId must reference a PhaseDef of this map (null clears it).
  if (input.phaseId != null) {
    const [row] = await handle
      .select({ mapId: nodes.mapId })
      .from(nodes)
      .where(and(eq(nodes.id, nodeId), notDeleted));
    if (row) {
      await assertPhaseIdKnown(handle, row.mapId as string, input.phaseId);
    }
  }

  // Auto-derive status from percentComplete when status is not explicitly set
  // in this update. See deriveAutoStatus for the exact rules.
  if (input.percentComplete !== undefined && input.status === undefined) {
    const [current] = await handle
      .select({ status: nodes.status, mapId: nodes.mapId })
      .from(nodes)
      .where(and(eq(nodes.id, nodeId), notDeleted));
    if (current) {
      const derived = await deriveAutoStatus(
        current.mapId as string,
        (current.status as string | null) ?? null,
        input.percentComplete,
        handle,
      );
      if (derived !== undefined) input.status = derived;
    }
  }

  const updates: Record<string, unknown> = {
    updatedAt: new Date(),
    revision: sql`${nodes.revision} + 1`,
  };

  if (input.text !== undefined) updates.text = input.text;
  if (input.description !== undefined) updates.description = input.description;
  if (input.x !== undefined) updates.x = input.x;
  if (input.y !== undefined) updates.y = input.y;
  if (input.collapsed !== undefined) updates.collapsed = input.collapsed;
  if (input.effortEstimate !== undefined) updates.effortEstimate = input.effortEstimate;
  if (input.actualEffort !== undefined) updates.actualEffort = input.actualEffort;
  if (input.percentComplete !== undefined) updates.percentComplete = input.percentComplete;
  if (input.status !== undefined) updates.status = input.status;
  if (input.blockedReason !== undefined) updates.blockedReason = input.blockedReason;
  if (input.assigneeIds !== undefined) updates.assigneeIds = input.assigneeIds;
  if (input.priority !== undefined) updates.priority = input.priority;
  if (input.dueDate !== undefined) updates.dueDate = input.dueDate;
  if (input.startDate !== undefined) updates.startDate = input.startDate;
  if (input.tags !== undefined) updates.tags = input.tags;
  if (input.customFields !== undefined) updates.customFields = input.customFields;
  if (input.dependencies !== undefined) updates.dependencies = input.dependencies;
  if (input.versionId !== undefined) updates.versionId = input.versionId;
  if (input.cycleId !== undefined) updates.cycleId = input.cycleId;
  if (input.externalLinks !== undefined) updates.externalLinks = input.externalLinks;
  if (input.autoProgress !== undefined) updates.autoProgress = input.autoProgress;
  if (input.priorityRank !== undefined) updates.priorityRank = input.priorityRank;
  if (input.requirementId !== undefined) updates.requirementId = input.requirementId;
  if (input.requirementPriority !== undefined) updates.requirementPriority = input.requirementPriority;
  if (input.requirementText !== undefined) updates.requirementText = input.requirementText;
  if (input.phaseId !== undefined) updates.phaseId = input.phaseId;
  if (input.verificationText !== undefined) updates.verificationText = input.verificationText;
  if (input.verificationUrl !== undefined) updates.verificationUrl = input.verificationUrl;
  if (input.verificationVideoUrl !== undefined)
    updates.verificationVideoUrl = input.verificationVideoUrl;
  // Orchestration substrate (#111)
  if (input.claimedBySession !== undefined) updates.claimedBySession = input.claimedBySession;
  if (input.claimedAt !== undefined) updates.claimedAt = input.claimedAt ? new Date(input.claimedAt) : null;
  if (input.scopes !== undefined) updates.scopes = input.scopes;
  if (input.linkedPr !== undefined) updates.linkedPr = input.linkedPr;

  // Auto-release claim when status transitions to a 'done' category (#111)
  // + write completedAt timestamp for the Gantt scheduler (v0.17.6).
  // Both behaviors hinge on the same workflow lookup, so we do them
  // together. We only act when the caller doesn't already manipulate
  // those fields explicitly in this same call.
  const statusChanging = input.status !== undefined;
  const pctChanging = input.percentComplete !== undefined;
  const completedAtTouched = input.completedAt !== undefined;
  const claimTouched =
    input.claimedBySession !== undefined || input.claimedAt !== undefined;

  if ((statusChanging || pctChanging) && (!claimTouched || !completedAtTouched)) {
    // #118 issue 3 — single JOIN replaces the previous 2-query path
    // (SELECT node.mapId → SELECT map.statusWorkflow). Cuts the status-
    // update hot path from 3 queries to 2 (the original UPDATE still
    // fires below).
    const [row] = await handle
      .select({ mapId: nodes.mapId, statusWorkflow: maps.statusWorkflow })
      .from(nodes)
      .innerJoin(maps, eq(maps.id, nodes.mapId))
      .where(and(eq(nodes.id, nodeId), notDeleted));
    if (row) {
      const workflow = ((row.statusWorkflow as StatusDef[]) ?? []);

      // Resolve whether the post-update node is "done":
      //   - status (if changing) → check its category in the workflow
      //   - percentComplete >= 100 (if changing) → done
      let movingToDone = false;
      let movingFromDone = false;
      if (statusChanging && input.status !== null) {
        const targetDef = resolveStatusDef(workflow, input.status as string);
        if (targetDef?.category === 'done') movingToDone = true;
        else movingFromDone = true;
      } else if (statusChanging && input.status === null) {
        // Status cleared → no longer done.
        movingFromDone = true;
      }
      if (pctChanging && input.percentComplete !== null && input.percentComplete !== undefined) {
        if (input.percentComplete >= 100) movingToDone = true;
        else movingFromDone = true;
      } else if (pctChanging && input.percentComplete === null) {
        movingFromDone = true;
      }

      if (movingToDone && !claimTouched) {
        updates.claimedBySession = null;
        updates.claimedAt = null;
      }
      if (movingToDone && !completedAtTouched) {
        updates.completedAt = new Date();
      } else if (movingFromDone && !completedAtTouched && !movingToDone) {
        // Transitioning OUT of done with no overriding move-to-done in
        // the same call → clear the timestamp.
        updates.completedAt = null;
      }
    }
  }

  if (input.completedAt !== undefined) {
    updates.completedAt = input.completedAt ? new Date(input.completedAt) : null;
  }

  // Conditional update: when expectedRevision is provided, the WHERE clause
  // also matches on revision so a stale write affects 0 rows. We then look
  // up the current state to distinguish "not found" from "conflict" and
  // raise RevisionConflictError accordingly.
  const where =
    expectedRevision === undefined
      ? and(eq(nodes.id, nodeId), notDeleted)
      : and(eq(nodes.id, nodeId), eq(nodes.revision, expectedRevision), notDeleted);

  let row;
  try {
    [row] = await handle.update(nodes).set(updates).where(where).returning();
  } catch (err) {
    if (isRequirementIdUniqueViolation(err)) {
      throw new RequirementIdConflictError(input.requirementId as string);
    }
    throw err;
  }
  if (row) {
    // Triage cache invalidation (#92, #93). Same rationale as createNode —
    // a depth-1 node's title/description may have just changed, which
    // changes the prompt the next triage call sends to Claude.
    invalidateMapContext(row.mapId as string);
    return dbNodeToCore(row as unknown as Record<string, unknown>);
  }

  // No row affected — either the node doesn't exist, or the revision was stale.
  if (expectedRevision !== undefined) {
    const current = await getNode(nodeId);
    if (current) throw new RevisionConflictError(current);
  }
  return null;
}

/**
 * Refresh the cached open/closed `state` on a single GitHub external link
 * without touching anything else on the node.
 *
 * Deliberately NOT routed through updateNode: that bumps `revision` and
 * `updatedAt` on every call. `state` is a mirror of GitHub, not user
 * content, and the catchup repairs it in bulk — a revision bump there
 * would mark every requirement acceptance on those nodes as stale (the
 * requirements view compares node.revision against the revision captured
 * at sign-off) and would churn updatedAt for thousands of untouched
 * nodes. So this writes the jsonb column alone.
 *
 * Returns false when the node is gone or carries no such link.
 */
export async function setExternalLinkState(
  nodeId: string,
  externalId: string,
  state: 'open' | 'closed',
  isPullRequest?: boolean,
  handle: DbHandle = db,
): Promise<boolean> {
  const [row] = await handle
    .select({ externalLinks: nodes.externalLinks })
    .from(nodes)
    .where(and(eq(nodes.id, nodeId), notDeleted));
  if (!row) return false;

  const links = (row.externalLinks as ExternalLink[]) ?? [];
  let found = false;
  const next = links.map((l) => {
    if (l.provider !== 'github' || l.externalId !== externalId) return l;
    found = true;
    return isPullRequest === undefined ? { ...l, state } : { ...l, state, isPullRequest };
  });
  if (!found) return false;

  await handle
    .update(nodes)
    .set({ externalLinks: next })
    .where(and(eq(nodes.id, nodeId), notDeleted));
  return true;
}

// ── Attachments ──────────────────────────────────────────────────

export class AttachmentValidationError extends Error {}

/** Only `http:`/`https:`, parsed rather than prefix-matched. */
function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

const MAX_ATTACHMENTS_PER_NODE = 50;
const MAX_URL_LENGTH = 2048;
const MAX_TITLE_LENGTH = 200;

export interface NewAttachment {
  kind: "file" | "link";
  url: string;
  title?: string;
  mimeType?: string | null;
  sizeBytes?: number | null;
}

/**
 * Validate one attachment request and turn it into the row we store.
 *
 * Pure, and exported, because every rule worth arguing about lives here —
 * which schemes may become an `<a href>`, how a title is derived when the
 * caller gave none, that a link never carries a file's size. `addAttachment`
 * below is this plus one SQL statement, and a stub-handle test cannot see
 * into SQL. Keeping the rules on this side of the line is what keeps them
 * verifiable.
 */
export function buildAttachment(
  input: NewAttachment,
  addedBy: string | null = null,
  now: Date = new Date(),
): CoreNode["attachments"][number] {
  // `typeof` rather than truthiness: the route only checks that the field
  // is present, so `{"url": 5}` reaches here, and `.trim()` on a number is
  // a TypeError — a 500 for what is plainly a bad request.
  if (typeof input.url !== "string") {
    throw new AttachmentValidationError("url muss Text sein");
  }
  if (input.title !== undefined && typeof input.title !== "string") {
    throw new AttachmentValidationError("title muss Text sein");
  }
  if (input.kind !== "file" && input.kind !== "link") {
    throw new AttachmentValidationError('kind muss "file" oder "link" sein');
  }

  const raw = input.url.trim();
  if (!isHttpUrl(raw)) {
    throw new AttachmentValidationError(
      "URL muss mit http:// oder https:// beginnen",
    );
  }
  if (raw.length > MAX_URL_LENGTH) {
    throw new AttachmentValidationError(
      `URL ist länger als ${MAX_URL_LENGTH} Zeichen`,
    );
  }

  // Store what the parser resolved rather than the raw string. The two
  // differ for inputs a browser would normalise anyway (stray control
  // characters, backslashes), and storing the canonical form means no
  // consumer has to wonder which one it got.
  const parsed = new URL(raw);

  // A title always renders, so derive one rather than showing a raw URL:
  // the filename for something we host, the host for a link elsewhere.
  const last = decodeURIComponent(
    parsed.pathname.split("/").filter(Boolean).pop() ?? "",
  );
  const fallbackTitle = input.kind === "file" && last ? last : parsed.host;

  return {
    id: randomUUID(),
    kind: input.kind,
    url: parsed.href,
    title: ((input.title ?? "").trim() || fallbackTitle).slice(
      0,
      MAX_TITLE_LENGTH,
    ),
    mimeType: input.kind === "file" ? (input.mimeType ?? null) : null,
    sizeBytes: input.kind === "file" ? (input.sizeBytes ?? null) : null,
    addedAt: now.toISOString(),
    addedBy,
  };
}

/**
 * Append one attachment.
 *
 * Its own function rather than a field on `updateNode`, and — the part that
 * actually earns that — the append happens **in Postgres**, as
 * `attachments || '[…]'::jsonb`, with the per-node ceiling as a predicate
 * on the same statement.
 *
 * The first cut read the array, appended in JS, and wrote it back. That
 * narrows the lost-update window from a user's whole editing session to a
 * DB round-trip, which is better but is not "avoided": two fleet agents
 * appending to the same node inside one tick still interleave, and one
 * attachment vanishes behind a 201. jsonb concat closes it outright, and
 * the ceiling predicate closes the same race on the limit check.
 *
 * Zero rows back means the WHERE matched nothing — either the node is gone
 * or it is full. One extra read on that path tells the two apart, so the
 * caller gets a message worth reading.
 */
export async function addAttachment(
  nodeId: string,
  input: NewAttachment,
  addedBy: string | null = null,
  handle: DbHandle = db,
): Promise<CoreNode> {
  const attachment = buildAttachment(input, addedBy);

  const [updated] = await handle
    .update(nodes)
    .set({
      attachments: sql`${nodes.attachments} || ${JSON.stringify([attachment])}::jsonb`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(nodes.id, nodeId),
        notDeleted,
        sql`jsonb_array_length(${nodes.attachments}) < ${MAX_ATTACHMENTS_PER_NODE}`,
      ),
    )
    .returning();

  if (!updated) {
    const [row] = await handle
      .select({ id: nodes.id })
      .from(nodes)
      .where(and(eq(nodes.id, nodeId), notDeleted));
    throw new AttachmentValidationError(
      row
        ? `Höchstens ${MAX_ATTACHMENTS_PER_NODE} Anhänge pro Knoten`
        : `Node ${nodeId} not found`,
    );
  }

  return dbNodeToCore(updated);
}

/**
 * Drop one attachment by id.
 *
 * The stored file, if any, is deliberately left on disk — see the
 * housekeeping note in deploy/README.md. Removing it here would break the
 * case where the same URL was pasted onto a second node, and node
 * deletion is a soft delete with a restore path regardless.
 */
export async function removeAttachment(
  nodeId: string,
  attachmentId: string,
  handle: DbHandle = db,
): Promise<CoreNode | null> {
  const [row] = await handle
    .select({ attachments: nodes.attachments })
    .from(nodes)
    .where(and(eq(nodes.id, nodeId), notDeleted));
  if (!row) return null;

  const existing = (row.attachments as CoreNode["attachments"]) ?? [];
  const next = existing.filter((a) => a.id !== attachmentId);
  if (next.length === existing.length) return null;

  const [updated] = await handle
    .update(nodes)
    .set({ attachments: next, updatedAt: new Date() })
    .where(and(eq(nodes.id, nodeId), notDeleted))
    .returning();

  return dbNodeToCore(updated);
}

/**
 * GitHub links for `owner/repo` that still carry no `state` mirror.
 *
 * The catchup's main loop iterates the issues GitHub *lists* as changed,
 * so it can only repair links it happens to encounter. Two kinds of link
 * are never listed: pull requests (filtered out of the issues list) and
 * issues that haven't changed since the sync cursor. This query finds
 * them so they can be resolved directly, one API call each.
 *
 * Bounded by `limit` — this is a repair trickle running on every tick,
 * not a bulk backfill, and it must not blow the repo's API budget.
 */
export async function findLinksMissingState(
  repoFullName: string,
  limit: number,
): Promise<Array<{ nodeId: string; externalId: string }>> {
  const rows = await db
    .select({ id: nodes.id, externalLinks: nodes.externalLinks })
    .from(nodes)
    .where(and(isNotNull(nodes.externalLinks), notDeleted));

  const out: Array<{ nodeId: string; externalId: string }> = [];
  for (const row of rows) {
    for (const l of (row.externalLinks as ExternalLink[]) ?? []) {
      if (l.provider !== 'github' || l.state !== undefined) continue;
      if (!l.externalId.startsWith(`${repoFullName}#`)) continue;
      out.push({ nodeId: row.id, externalId: l.externalId });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

// ── Delete (with descendants) ──────────────────────────────────────

/**
 * Walk a node subtree (inclusive) and return all GitHub externalLinks with
 * syncEnabled=true. Used to fire outbound closes before destructive deletes.
 */
export async function collectGitHubLinksInSubtree(
  rootNodeId: string,
): Promise<ExternalLink[]> {
  const collected: ExternalLink[] = [];
  const queue: string[] = [rootNodeId];
  while (queue.length > 0) {
    const currentId = queue.shift()!;
    const [row] = await db
      .select({ externalLinks: nodes.externalLinks })
      .from(nodes)
      .where(eq(nodes.id, currentId));
    if (row) {
      const links = (row.externalLinks as ExternalLink[]) ?? [];
      for (const l of links) {
        if (l.provider === 'github' && l.syncEnabled) collected.push(l);
      }
    }
    const children = await db
      .select({ id: nodes.id })
      .from(nodes)
      .where(eq(nodes.parentId, currentId));
    for (const c of children) queue.push(c.id);
  }
  return collected;
}

/**
 * Result of a soft-delete: the set of node IDs that moved to the Trash, and
 * the index the root occupied in its parent's children_order at the moment
 * of delete (so restoreNode can splice it back into the same position).
 * parentChildIndex is null when the deleted node was the map root (which
 * deleteNode refuses) or when its parent_id was null.
 */
export interface DeleteResult {
  deletedIds: string[];
  parentChildIndex: number | null;
}

export async function deleteNode(nodeId: string): Promise<DeleteResult> {
  // Get the node — read the row whether or not it's already soft-deleted.
  // Idempotent re-deletes are a no-op (return empty).
  const [node] = await db.select().from(nodes).where(eq(nodes.id, nodeId));
  if (!node) return { deletedIds: [], parentChildIndex: null };
  if (node.deletedAt) return { deletedIds: [], parentChildIndex: null };

  // BFS the subtree — include any nodes still live (deletedAt IS NULL) under
  // this root. Trash items underneath stay in the trash without bumping
  // their deleted_at.
  const toDelete: string[] = [];
  const queue: string[] = [nodeId];

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    toDelete.push(currentId);

    const children = await db.select({ id: nodes.id })
      .from(nodes)
      .where(and(eq(nodes.parentId, currentId), notDeleted));

    for (const child of children) {
      queue.push(child.id);
    }
  }

  // Capture the root's original position in its parent's children_order
  // BEFORE removing it. Used by restoreNode to splice the subtree back at
  // the same index. null when the deleted node had no parent.
  let parentChildIndex: number | null = null;
  if (node.parentId) {
    const [parent] = await db
      .select()
      .from(nodes)
      .where(and(eq(nodes.id, node.parentId), notDeleted));
    if (parent) {
      const order = (parent.childrenOrder as string[]) ?? [];
      const idx = order.indexOf(nodeId);
      parentChildIndex = idx >= 0 ? idx : null;
      const filteredOrder = order.filter((id: string) => id !== nodeId);
      await db.update(nodes)
        .set({ childrenOrder: filteredOrder, updatedAt: new Date() })
        .where(eq(nodes.id, node.parentId));
    }
  }

  // Remove dependency edges pointing into the trashed subtree from surviving
  // nodes. We don't clean these up on restore — restoring a node doesn't
  // automatically reinstate other nodes' dependency edges to it. Users who
  // need that re-link it manually.
  const allMapNodes = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.mapId, node.mapId as string), notDeleted));
  const deleteSet = new Set(toDelete);

  for (const n of allMapNodes) {
    if (deleteSet.has(n.id)) continue;
    const deps = (n.dependencies as Dependency[]) ?? [];
    const filtered = deps.filter((d) => !deleteSet.has(d.targetNodeId));
    if (filtered.length !== deps.length) {
      await db.update(nodes)
        .set({ dependencies: filtered, updatedAt: new Date() })
        .where(eq(nodes.id, n.id));
    }
  }

  // Soft-delete: flip deleted_at on the subtree instead of dropping rows.
  // The row stays so restoreNode (or a pg backup) can recover it; the GC
  // job hard-deletes after the retention window.
  if (toDelete.length > 0) {
    await db.update(nodes)
      .set({ deletedAt: new Date() })
      .where(inArray(nodes.id, toDelete));
  }

  invalidateMapContext(node.mapId as string);

  return { deletedIds: toDelete, parentChildIndex };
}

// ── Restore (undelete) ────────────────────────────────────────────

export class RestoreError extends Error {
  constructor(public code: 'NOT_DELETED' | 'PARENT_IN_TRASH' | 'NOT_FOUND', message: string) {
    super(message);
    this.name = 'RestoreError';
  }
}

export interface RestoreResult {
  restoredIds: string[];
  /** The node IDs whose children_order changed (the restored root's parent). */
  affectedParentIds: string[];
}

/**
 * Restore a soft-deleted node and its trashed descendants.
 *
 * Requires the root's parent to itself be live (not in the trash) — restoring
 * a node whose parent is gone has no obvious home. Callers can either restore
 * the parent first, or pass `{ recursive: true }` to walk up and restore the
 * whole chain of trashed ancestors.
 *
 * Position-preserving: reads the most-recent `node.deleted` event for this
 * node and splices into the parent at its original index (clamped to the
 * current children_order length).
 */
export async function restoreNode(
  nodeId: string,
  opts: { recursive?: boolean } = {},
): Promise<RestoreResult> {
  const [node] = await db.select().from(nodes).where(eq(nodes.id, nodeId));
  if (!node) {
    throw new RestoreError('NOT_FOUND', `Node ${nodeId} not found`);
  }
  if (!node.deletedAt) {
    throw new RestoreError('NOT_DELETED', `Node ${nodeId} is not in the Trash`);
  }

  // Build the chain of ancestors that also need to be restored. We climb
  // parent_id while the parent itself is in the trash. If we reach a live
  // parent → fine. If we reach a null parent (root) without finding a live
  // one → fine. If non-recursive and the immediate parent is in the trash
  // → error.
  const ancestorChainToRestore: string[] = [];
  let p = node.parentId;
  while (p) {
    const [parentRow] = await db.select().from(nodes).where(eq(nodes.id, p));
    if (!parentRow) break;
    if (!parentRow.deletedAt) break;
    if (!opts.recursive) {
      throw new RestoreError(
        'PARENT_IN_TRASH',
        `Parent ${p} is in the Trash. Restore it first, or pass recursive: true.`,
      );
    }
    ancestorChainToRestore.unshift(p);
    p = parentRow.parentId;
  }

  // BFS the subtree of trashed descendants under each restored root.
  // For each restored root we'll also splice it back into its parent's
  // children_order at the original index (from the most-recent delete event).
  const rootsToRestore = [...ancestorChainToRestore, nodeId];
  const allToRestore = new Set<string>();
  for (const rootId of rootsToRestore) {
    const queue: string[] = [rootId];
    while (queue.length > 0) {
      const currentId = queue.shift()!;
      allToRestore.add(currentId);
      const children = await db
        .select({ id: nodes.id })
        .from(nodes)
        .where(and(eq(nodes.parentId, currentId), isNotNull(nodes.deletedAt)));
      for (const child of children) queue.push(child.id);
    }
  }

  const affectedParentIds: string[] = [];
  for (const rootId of rootsToRestore) {
    const [rootRow] = await db.select().from(nodes).where(eq(nodes.id, rootId));
    if (!rootRow?.parentId) continue;

    // Look up the most-recent delete event for this root to find the
    // original children_order index. Fall back to "append" when the event
    // wasn't recorded with an index (older events, or roots that lost their
    // parent).
    const [evt] = await db
      .select()
      .from(changeEvents)
      .where(
        and(
          eq(changeEvents.nodeId, rootId),
          eq(changeEvents.eventType, 'node.deleted'),
        ),
      )
      .orderBy(desc(changeEvents.createdAt))
      .limit(1);
    const stored = (evt?.oldValue ?? null) as
      | { parentChildIndex?: number | null }
      | null;
    const originalIndex =
      stored && typeof stored.parentChildIndex === 'number'
        ? stored.parentChildIndex
        : null;

    const [parent] = await db.select().from(nodes).where(eq(nodes.id, rootRow.parentId));
    if (!parent) continue;
    const order = ((parent.childrenOrder as string[]) ?? []).filter(
      (id) => id !== rootId,
    );
    const insertAt =
      originalIndex == null
        ? order.length
        : Math.min(Math.max(0, originalIndex), order.length);
    order.splice(insertAt, 0, rootId);
    await db
      .update(nodes)
      .set({ childrenOrder: order, updatedAt: new Date() })
      .where(eq(nodes.id, rootRow.parentId));
    affectedParentIds.push(rootRow.parentId);
  }

  // Flip deleted_at = null on every restored row.
  const restoredIds = [...allToRestore];
  if (restoredIds.length > 0) {
    await db
      .update(nodes)
      .set({ deletedAt: null, updatedAt: new Date() })
      .where(inArray(nodes.id, restoredIds));
  }

  invalidateMapContext(node.mapId as string);

  return { restoredIds, affectedParentIds };
}

// ── List recently deleted (Trash view) ────────────────────────────

export interface DeletedNodeSummary {
  id: string;
  mapId: string;
  parentId: string | null;
  text: string;
  deletedAt: string;
  effortEstimate: number | null;
  percentComplete: number | null;
}

/**
 * List soft-deleted subtree roots in a map, newest first. A "subtree root"
 * is a trashed node whose parent isn't itself trashed — i.e. the actual
 * entry-point the user clicked Delete on. Internal descendants are excluded
 * so the Trash UI lists one row per deletion, not 99.
 */
export async function listDeleted(
  mapId: string,
  opts: { sinceDays?: number; limit?: number } = {},
): Promise<DeletedNodeSummary[]> {
  const conditions = [eq(nodes.mapId, mapId), isNotNull(nodes.deletedAt)];
  if (opts.sinceDays !== undefined) {
    const since = new Date(Date.now() - opts.sinceDays * 86_400_000);
    conditions.push(gte(nodes.deletedAt, since));
  }

  const rows = await db
    .select()
    .from(nodes)
    .where(and(...conditions))
    .orderBy(desc(nodes.deletedAt))
    .limit(opts.limit ?? 500);

  // Filter to subtree roots: the row's parent isn't itself in the trash.
  // (A null parent is a root by definition.) We resolve parents from the
  // same `rows` set first; for parents outside the result we fall back to a
  // single follow-up SELECT.
  const trashed = new Set(rows.map((r) => r.id));
  const unknownParentIds = new Set<string>();
  for (const r of rows) {
    if (r.parentId && !trashed.has(r.parentId)) unknownParentIds.add(r.parentId);
  }
  let liveParents = new Set<string>();
  if (unknownParentIds.size > 0) {
    const parentRows = await db
      .select({ id: nodes.id, deletedAt: nodes.deletedAt })
      .from(nodes)
      .where(inArray(nodes.id, [...unknownParentIds]));
    for (const p of parentRows) {
      if (!p.deletedAt) liveParents.add(p.id);
    }
  }

  return rows
    .filter((r) => !r.parentId || liveParents.has(r.parentId))
    .map((r) => ({
      id: r.id,
      mapId: r.mapId as string,
      parentId: (r.parentId as string | null) ?? null,
      text: r.text as string,
      deletedAt: (r.deletedAt as Date).toISOString(),
      effortEstimate: (r.effortEstimate as number | null) ?? null,
      percentComplete: (r.percentComplete as number | null) ?? null,
    }));
}

// ── GC (hard-delete after retention window) ──────────────────────

/**
 * Permanently DROP rows that have been in the Trash longer than
 * retentionDays. Returns the IDs of rows actually deleted. Idempotent and
 * safe to run as a cron — picks up only rows whose deleted_at is past the
 * window, regardless of how many GC runs have happened since.
 */
export async function purgeExpiredTrash(retentionDays: number): Promise<string[]> {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  const rows = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(isNotNull(nodes.deletedAt), sql`${nodes.deletedAt} < ${cutoff}`));
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  await db.delete(nodes).where(inArray(nodes.id, ids));
  return ids;
}

// ── Move ───────────────────────────────────────────────────────────

export async function moveNode(
  nodeId: string,
  newParentId: string,
  position?: number,
): Promise<CoreNode | null> {
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, nodeId), notDeleted));
  if (!node) return null;

  const now = new Date();

  // Remove from old parent's children_order
  if (node.parentId) {
    const [oldParent] = await db
      .select()
      .from(nodes)
      .where(and(eq(nodes.id, node.parentId), notDeleted));
    if (oldParent) {
      const order = (oldParent.childrenOrder as string[]).filter((id: string) => id !== nodeId);
      await db.update(nodes)
        .set({ childrenOrder: order, updatedAt: now })
        .where(eq(nodes.id, node.parentId));
    }
  }

  // Add to new parent's children_order
  const [newParent] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, newParentId), notDeleted));
  if (!newParent) return null;

  // Remove any existing reference first to prevent duplicates
  const newOrder = ((newParent.childrenOrder as string[]) ?? []).filter((id: string) => id !== nodeId);
  if (position != null && position >= 0 && position <= newOrder.length) {
    newOrder.splice(position, 0, nodeId);
  } else {
    newOrder.push(nodeId);
  }

  await db.update(nodes)
    .set({ childrenOrder: newOrder, updatedAt: now })
    .where(eq(nodes.id, newParentId));

  // Update the node's parentId
  const [updated] = await db.update(nodes)
    .set({ parentId: newParentId, updatedAt: now })
    .where(eq(nodes.id, nodeId))
    .returning();

  // Triage cache invalidation (#92, #93). A move can change whether a
  // node is depth-1 (epic-level) — either by promoting a child to be a
  // root-direct child or vice versa. Invalidate to force the next
  // triage call to rebuild from the DB.
  invalidateMapContext(node.mapId as string);

  return dbNodeToCore(updated as unknown as Record<string, unknown>);
}

// ── Reorder children ───────────────────────────────────────────────

export async function reorderChildren(
  parentId: string,
  newChildrenIds: string[],
): Promise<boolean> {
  const [parent] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, parentId), notDeleted));
  if (!parent) return false;

  const existing = new Set((parent.childrenOrder as string[]) ?? []);
  const incoming = new Set(newChildrenIds);

  // Validate: must be the same set
  if (existing.size !== incoming.size) return false;
  for (const id of incoming) {
    if (!existing.has(id)) return false;
  }

  await db.update(nodes)
    .set({ childrenOrder: newChildrenIds, updatedAt: new Date() })
    .where(eq(nodes.id, parentId));

  return true;
}

// ── Dependency helpers ────────────────────────────────────────────

/**
 * Build a NodeMap from all nodes sharing the same mapId as `nodeId`.
 * Used for cycle detection via the core `hasCycle` function.
 */
async function buildNodeMapForNode(
  nodeId: string,
  handle: DbHandle = db,
): Promise<{ mapId: string; nodeMap: NodeMap }> {
  const [node] = await handle
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, nodeId), notDeleted));
  if (!node) throw new DependencyValidationError(`Node ${nodeId} not found`);

  const mapId = node.mapId as string;
  const allNodes = await handle
    .select()
    .from(nodes)
    .where(and(eq(nodes.mapId, mapId), notDeleted));
  const nodeMap: NodeMap = new Map();
  for (const n of allNodes) {
    const coreNode = dbNodeToCore(n as unknown as Record<string, unknown>);
    nodeMap.set(coreNode.id, coreNode);
  }
  return { mapId, nodeMap };
}

/**
 * Validate a full dependency array for a node.
 * Rejects self-references and circular dependencies.
 */
async function validateDependencies(
  nodeId: string,
  deps: Dependency[],
  handle: DbHandle = db,
): Promise<void> {
  // Check for self-references
  for (const dep of deps) {
    if (dep.targetNodeId === nodeId) {
      throw new DependencyValidationError(
        `A node cannot depend on itself (node ${nodeId})`,
      );
    }
  }

  // Check for circular dependencies by simulating the new dependency set
  if (deps.length > 0) {
    const { nodeMap } = await buildNodeMapForNode(nodeId, handle);

    // Temporarily update the node's dependencies in the map for cycle detection
    const currentNode = nodeMap.get(nodeId);
    if (currentNode) {
      const tempNode = { ...currentNode, dependencies: deps };
      nodeMap.set(nodeId, tempNode);

      // Check each new dependency target for cycles
      for (const dep of deps) {
        // hasCycle checks: would "nodeId depends on dep.targetNodeId" create a cycle?
        // Since we already set the deps on the node, we need to check if
        // dep.targetNodeId can reach nodeId via the existing graph (excluding this edge).
        // We use a simpler approach: temporarily set deps, then check for cycles.
        if (hasCycle(nodeId, dep.targetNodeId, nodeMap)) {
          throw new DependencyValidationError(
            `Adding dependency ${nodeId} -> ${dep.targetNodeId} would create a circular dependency`,
          );
        }
      }
    }
  }
}

/**
 * Add a single dependency to a node with full validation.
 * Rejects self-references and circular dependencies.
 */
export async function addDependency(
  nodeId: string,
  targetNodeId: string,
  type: DependencyType,
  lag: number = 0,
): Promise<CoreNode> {
  // Self-reference check
  if (nodeId === targetNodeId) {
    throw new DependencyValidationError(
      `A node cannot depend on itself (node ${nodeId})`,
    );
  }

  const { nodeMap } = await buildNodeMapForNode(nodeId);

  const node = nodeMap.get(nodeId);
  if (!node) {
    throw new DependencyValidationError(`Node ${nodeId} not found`);
  }

  // Check for duplicate
  const alreadyExists = node.dependencies.some(
    (d) => d.targetNodeId === targetNodeId && d.type === type,
  );
  if (alreadyExists) {
    throw new DependencyValidationError(
      `Dependency already exists: ${nodeId} -> ${targetNodeId} (${type})`,
    );
  }

  // Circular dependency check using core hasCycle
  if (hasCycle(nodeId, targetNodeId, nodeMap)) {
    throw new DependencyValidationError(
      `Adding dependency ${nodeId} -> ${targetNodeId} would create a circular dependency`,
    );
  }

  const newDeps: Dependency[] = [...node.dependencies, { targetNodeId, type, lag }];

  const [row] = await db.update(nodes)
    .set({ dependencies: newDeps, updatedAt: new Date() })
    .where(eq(nodes.id, nodeId))
    .returning();

  if (!row) {
    throw new DependencyValidationError(`Failed to update node ${nodeId}`);
  }

  return dbNodeToCore(row as unknown as Record<string, unknown>);
}

/**
 * Custom error class for dependency validation failures.
 */
export class DependencyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DependencyValidationError';
  }
}
