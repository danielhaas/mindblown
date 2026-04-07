import { eq, inArray } from 'drizzle-orm';
import { db } from './connection.js';
import { nodes } from './schema.js';
import { dbNodeToCore } from './helpers.js';
import type { Node as CoreNode, Dependency, ExternalLink, Priority, CustomFieldValue } from '@mindblown/core';

// ── Create ─────────────────────────────────────────────────────────

export interface CreateNodeInput {
  mapId: string;
  parentId: string;
  text: string;
  createdBy: string;
  position?: number; // index in parent's children_order; omit = append
  effortEstimate?: number;
  percentComplete?: number;
  status?: string;
  priority?: Priority;
  startDate?: string;
  dueDate?: string;
  isMilestone?: boolean;
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
    effortEstimate: input.effortEstimate ?? null,
    percentComplete: input.percentComplete ?? null,
    status: input.status ?? null,
    priority: input.priority ?? null,
    startDate: input.startDate ?? null,
    dueDate: input.dueDate ?? null,
    isMilestone: input.isMilestone ?? false,
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
  percentComplete?: number | null;
  status?: string | null;
  assigneeIds?: string[];
  priority?: Priority | null;
  dueDate?: string | null;
  startDate?: string | null;
  tags?: string[];
  customFields?: Record<string, CustomFieldValue>;
  dependencies?: Dependency[];
  isMilestone?: boolean;
  cycleId?: string | null;
  externalLinks?: ExternalLink[];
}

export async function updateNode(nodeId: string, input: UpdateNodeInput): Promise<CoreNode | null> {
  const updates: Record<string, unknown> = { updatedAt: new Date() };

  if (input.text !== undefined) updates.text = input.text;
  if (input.description !== undefined) updates.description = input.description;
  if (input.x !== undefined) updates.x = input.x;
  if (input.y !== undefined) updates.y = input.y;
  if (input.collapsed !== undefined) updates.collapsed = input.collapsed;
  if (input.effortEstimate !== undefined) updates.effortEstimate = input.effortEstimate;
  if (input.percentComplete !== undefined) updates.percentComplete = input.percentComplete;
  if (input.status !== undefined) updates.status = input.status;
  if (input.assigneeIds !== undefined) updates.assigneeIds = input.assigneeIds;
  if (input.priority !== undefined) updates.priority = input.priority;
  if (input.dueDate !== undefined) updates.dueDate = input.dueDate;
  if (input.startDate !== undefined) updates.startDate = input.startDate;
  if (input.tags !== undefined) updates.tags = input.tags;
  if (input.customFields !== undefined) updates.customFields = input.customFields;
  if (input.dependencies !== undefined) updates.dependencies = input.dependencies;
  if (input.isMilestone !== undefined) updates.isMilestone = input.isMilestone;
  if (input.cycleId !== undefined) updates.cycleId = input.cycleId;
  if (input.externalLinks !== undefined) updates.externalLinks = input.externalLinks;

  const [row] = await db.update(nodes).set(updates).where(eq(nodes.id, nodeId)).returning();
  if (!row) return null;
  return dbNodeToCore(row as unknown as Record<string, unknown>);
}

// ── Delete (with descendants) ──────────────────────────────────────

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
