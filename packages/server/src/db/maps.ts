import { and, eq, inArray, or } from 'drizzle-orm';
import { db } from './connection.js';
import { maps, mapPermissions, nodes } from './schema.js';
import { dbMapToCore, dbNodeToCore } from './helpers.js';
import { notDeleted } from './nodes.js';
import type { MindMap, Node as CoreNode, StatusDef, CustomFieldDef, LayoutMode, EffortUnit, Baseline } from '@mindblown/core';

// ── Create ─────────────────────────────────────────────────────────

export interface CreateMapInput {
  name: string;
  description?: string;
  workspaceId: string;
  createdBy: string;
  effortUnit?: EffortUnit;
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
  baselines?: Baseline[];
  wipLimit?: number | null;
  projectStartDate?: string | null;
  hoursPerDay?: number;
  githubInstallationId?: string | null;
  githubRepoOwner?: string | null;
  githubRepoName?: string | null;
  autoImportNewIssues?: boolean;
  githubInboxNodeId?: string | null;
}

export async function updateMap(mapId: string, input: UpdateMapInput): Promise<MindMap | null> {
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (input.name !== undefined) updates.name = input.name;
  if (input.description !== undefined) updates.description = input.description;
  if (input.effortUnit !== undefined) updates.effortUnit = input.effortUnit;
  if (input.statusWorkflow !== undefined) updates.statusWorkflow = input.statusWorkflow;
  if (input.customFieldDefs !== undefined) updates.customFieldDefs = input.customFieldDefs;
  if (input.defaultLayout !== undefined) updates.defaultLayout = input.defaultLayout;
  if (input.healthThreshold !== undefined) updates.healthThreshold = input.healthThreshold;
  if (input.baselines !== undefined) updates.baselines = input.baselines;
  if (input.wipLimit !== undefined) updates.wipLimit = input.wipLimit;
  if (input.projectStartDate !== undefined) updates.projectStartDate = input.projectStartDate;
  if (input.hoursPerDay !== undefined) updates.hoursPerDay = input.hoursPerDay;
  if (input.githubInstallationId !== undefined) updates.githubInstallationId = input.githubInstallationId;
  if (input.githubRepoOwner !== undefined) updates.githubRepoOwner = input.githubRepoOwner;
  if (input.githubRepoName !== undefined) updates.githubRepoName = input.githubRepoName;
  if (input.autoImportNewIssues !== undefined) updates.autoImportNewIssues = input.autoImportNewIssues;
  if (input.githubInboxNodeId !== undefined) updates.githubInboxNodeId = input.githubInboxNodeId;

  const [row] = await db.update(maps).set(updates).where(eq(maps.id, mapId)).returning();
  if (!row) return null;
  return dbMapToCore(row as unknown as Record<string, unknown>);
}

// ── Delete ─────────────────────────────────────────────────────────

export async function deleteMap(mapId: string): Promise<boolean> {
  // Nodes cascade-delete via FK
  const result = await db.delete(maps).where(eq(maps.id, mapId)).returning();
  return result.length > 0;
}

// ── Baseline ───────────────────────────────────────────────────────

export async function createBaseline(mapId: string, name: string): Promise<MindMap | null> {
  const data = await getMap(mapId);
  if (!data) return null;

  const nodeSnapshot: Record<string, unknown> = {};
  for (const node of data.nodes) {
    nodeSnapshot[node.id] = {
      effortEstimate: node.effortEstimate,
      percentComplete: node.percentComplete,
      startDate: node.startDate,
      dueDate: node.dueDate,
      status: node.status,
    };
  }

  const baseline: Baseline = {
    id: crypto.randomUUID(),
    name,
    createdAt: new Date().toISOString(),
    nodes: nodeSnapshot as Baseline['nodes'],
  };

  const existingBaselines = data.map.baselines ?? [];
  const updatedBaselines = [...existingBaselines, baseline];

  return updateMap(mapId, { baselines: updatedBaselines });
}
