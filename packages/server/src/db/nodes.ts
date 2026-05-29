import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from './connection.js';
import { nodes, maps } from './schema.js';
import { dbNodeToCore } from './helpers.js';
import { hasCycle } from '@mindblown/core';
import type { Node as CoreNode, Dependency, DependencyType, ExternalLink, Priority, CustomFieldValue, NodeMap, StatusDef } from '@mindblown/core';

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
): Promise<string | undefined> {
  const targetCategory: 'todo' | 'in_progress' | 'done' =
    newProgress == null || newProgress <= 0
      ? 'todo'
      : newProgress >= 100
        ? 'done'
        : 'in_progress';

  const [map] = await db
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
}

export async function createNode(input: CreateNodeInput): Promise<CoreNode> {
  const now = new Date();

  // Create the node
  const [row] = await db.insert(nodes).values({
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
    assigneeIds: [],
    tags: [],
    customFields: {},
    dependencies: [],
    externalLinks: [],
    createdAt: now,
    updatedAt: now,
    createdBy: input.createdBy,
  }).returning();

  // Add to parent's children_order
  const [parent] = await db.select().from(nodes).where(eq(nodes.id, input.parentId));
  if (parent) {
    const order = (parent.childrenOrder as string[]) ?? [];
    const idx = input.position;
    if (idx != null && idx >= 0 && idx < order.length) {
      order.splice(idx, 0, row.id);
    } else {
      order.push(row.id);
    }
    await db.update(nodes)
      .set({ childrenOrder: order, updatedAt: now })
      .where(eq(nodes.id, input.parentId));
  }

  return dbNodeToCore(row as unknown as Record<string, unknown>);
}

// ── Get ────────────────────────────────────────────────────────────

export async function getNode(nodeId: string): Promise<CoreNode | null> {
  const [row] = await db.select().from(nodes).where(eq(nodes.id, nodeId));
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
  customFields?: Record<string, CustomFieldValue>;
  dependencies?: Dependency[];
  versionId?: string | null;
  cycleId?: string | null;
  externalLinks?: ExternalLink[];
  autoProgress?: 'off' | 'children';
}

export async function updateNode(
  nodeId: string,
  input: UpdateNodeInput,
  expectedRevision?: number,
): Promise<CoreNode | null> {
  // Validate dependencies if provided
  if (input.dependencies !== undefined) {
    await validateDependencies(nodeId, input.dependencies);
  }

  // Auto-derive status from percentComplete when status is not explicitly set
  // in this update. See deriveAutoStatus for the exact rules.
  if (input.percentComplete !== undefined && input.status === undefined) {
    const [current] = await db
      .select({ status: nodes.status, mapId: nodes.mapId })
      .from(nodes)
      .where(eq(nodes.id, nodeId));
    if (current) {
      const derived = await deriveAutoStatus(
        current.mapId as string,
        (current.status as string | null) ?? null,
        input.percentComplete,
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

  // Conditional update: when expectedRevision is provided, the WHERE clause
  // also matches on revision so a stale write affects 0 rows. We then look
  // up the current state to distinguish "not found" from "conflict" and
  // raise RevisionConflictError accordingly.
  const where =
    expectedRevision === undefined
      ? eq(nodes.id, nodeId)
      : and(eq(nodes.id, nodeId), eq(nodes.revision, expectedRevision));

  const [row] = await db.update(nodes).set(updates).where(where).returning();
  if (row) return dbNodeToCore(row as unknown as Record<string, unknown>);

  // No row affected — either the node doesn't exist, or the revision was stale.
  if (expectedRevision !== undefined) {
    const current = await getNode(nodeId);
    if (current) throw new RevisionConflictError(current);
  }
  return null;
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

export async function deleteNode(nodeId: string): Promise<string[]> {
  // Get the node to find its parent
  const [node] = await db.select().from(nodes).where(eq(nodes.id, nodeId));
  if (!node) return [];

  // Collect all descendant IDs via BFS
  const toDelete: string[] = [];
  const queue: string[] = [nodeId];

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    toDelete.push(currentId);

    const children = await db.select({ id: nodes.id })
      .from(nodes)
      .where(eq(nodes.parentId, currentId));

    for (const child of children) {
      queue.push(child.id);
    }
  }

  // Remove from parent's children_order
  if (node.parentId) {
    const [parent] = await db.select().from(nodes).where(eq(nodes.id, node.parentId));
    if (parent) {
      const order = (parent.childrenOrder as string[]).filter((id: string) => id !== nodeId);
      await db.update(nodes)
        .set({ childrenOrder: order, updatedAt: new Date() })
        .where(eq(nodes.id, node.parentId));
    }
  }

  // Remove dependency edges pointing to deleted nodes from surviving nodes
  const allMapNodes = await db.select().from(nodes).where(eq(nodes.mapId, node.mapId as string));
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

  // Delete all collected nodes
  if (toDelete.length > 0) {
    await db.delete(nodes).where(inArray(nodes.id, toDelete));
  }

  return toDelete;
}

// ── Move ───────────────────────────────────────────────────────────

export async function moveNode(
  nodeId: string,
  newParentId: string,
  position?: number,
): Promise<CoreNode | null> {
  const [node] = await db.select().from(nodes).where(eq(nodes.id, nodeId));
  if (!node) return null;

  const now = new Date();

  // Remove from old parent's children_order
  if (node.parentId) {
    const [oldParent] = await db.select().from(nodes).where(eq(nodes.id, node.parentId));
    if (oldParent) {
      const order = (oldParent.childrenOrder as string[]).filter((id: string) => id !== nodeId);
      await db.update(nodes)
        .set({ childrenOrder: order, updatedAt: now })
        .where(eq(nodes.id, node.parentId));
    }
  }

  // Add to new parent's children_order
  const [newParent] = await db.select().from(nodes).where(eq(nodes.id, newParentId));
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

  return dbNodeToCore(updated as unknown as Record<string, unknown>);
}

// ── Reorder children ───────────────────────────────────────────────

export async function reorderChildren(
  parentId: string,
  newChildrenIds: string[],
): Promise<boolean> {
  const [parent] = await db.select().from(nodes).where(eq(nodes.id, parentId));
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
async function buildNodeMapForNode(nodeId: string): Promise<{ mapId: string; nodeMap: NodeMap }> {
  const [node] = await db.select().from(nodes).where(eq(nodes.id, nodeId));
  if (!node) throw new DependencyValidationError(`Node ${nodeId} not found`);

  const mapId = node.mapId as string;
  const allNodes = await db.select().from(nodes).where(eq(nodes.mapId, mapId));
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
async function validateDependencies(nodeId: string, deps: Dependency[]): Promise<void> {
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
    const { nodeMap } = await buildNodeMapForNode(nodeId);

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
