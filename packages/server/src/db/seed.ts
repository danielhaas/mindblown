import { db } from './connection.js';
import { users, workspaces, maps, nodes, cycles, mapPermissions } from './schema.js';
import { sql } from 'drizzle-orm';
import { hashPassword } from '../auth.js';

/**
 * Seed the "Website Redesign" example map on first run (empty database).
 */
export async function seedIfEmpty(): Promise<void> {
  // Check if any maps exist
  const existing = await db.select({ id: maps.id }).from(maps).limit(1);
  if (existing.length > 0) {
    console.log('[seed] Database already has data, skipping seed.');
    return;
  }

  console.log('[seed] Empty database detected. Seeding "Website Redesign" example...');

  const now = new Date();

  // Create default user with password
  const demoPasswordHash = await hashPassword('demo123');
  const [user] = await db.insert(users).values({
    email: 'demo@mindblown.dev',
    name: 'Demo User',
    passwordHash: demoPasswordHash,
    createdAt: now,
  }).returning();

  // Create collaborator user
  const collabPasswordHash = await hashPassword('demo123');
  const [collaborator] = await db.insert(users).values({
    email: 'collaborator@mindblown.dev',
    name: 'Collaborator',
    passwordHash: collabPasswordHash,
    createdAt: now,
  }).returning();

  // Create default workspace
  const [workspace] = await db.insert(workspaces).values({
    name: 'Demo Workspace',
    slug: 'demo',
    ownerId: user.id,
    createdAt: now,
  }).returning();

  // Create the map
  const [map] = await db.insert(maps).values({
    name: 'Website Redesign',
    description: 'Complete redesign of the company website with modern stack',
    workspaceId: workspace.id,
    createdBy: user.id,
    effortUnit: 'days',
    createdAt: now,
    updatedAt: now,
  }).returning();

  // Helper to create a node
  async function createNode(
    text: string,
    parentId: string | null,
    opts: {
      effortEstimate?: number;
      percentComplete?: number;
      status?: string;
      startDate?: string;
      dueDate?: string;
      isMilestone?: boolean;
      dependencies?: Array<{ targetNodeId: string; type: string; lag: number }>;
    } = {},
  ) {
    const [node] = await db.insert(nodes).values({
      mapId: map.id,
      parentId,
      childrenOrder: [],
      text,
      collapsed: false,
      effortEstimate: opts.effortEstimate ?? null,
      percentComplete: opts.percentComplete ?? null,
      status: opts.status ?? null,
      startDate: opts.startDate ?? null,
      dueDate: opts.dueDate ?? null,
      isMilestone: opts.isMilestone ?? false,
      dependencies: opts.dependencies ?? [],
      assigneeIds: [],
      tags: [],
      customFields: {},
      externalLinks: [],
      createdAt: now,
      updatedAt: now,
      createdBy: user.id,
    }).returning();
    return node;
  }

  // Build the tree:
  // Website Redesign (root)
  //   ├── Design
  //   │   ├── Wireframes (3d, 100%)
  //   │   ├── Visual Design (5d, 80%)
  //   │   └── Design System (4d, 25%)
  //   ├── Backend
  //   │   ├── API Endpoints (7d, 0%)
  //   │   └── DB Migration (5d, 0%)
  //   ├── Frontend
  //   │   ├── Component Library (6d, 40%)
  //   │   ├── Page Templates (8d, 10%)
  //   │   └── Responsive Testing (3d, 0%)
  //   ├── Content
  //   │   ├── Copywriting (4d, 60%)
  //   │   └── Asset Creation (3d, 30%)
  //   ├── Integration Testing (3d, 0%)
  //   └── 🔶 Launch (milestone)

  const root = await createNode('Website Redesign', null);

  // ── Design branch ────────────────────────────────────────
  const design = await createNode('Design', root.id);
  const wireframes = await createNode('Wireframes', design.id, {
    effortEstimate: 3, percentComplete: 100, status: 'done',
    startDate: '2026-03-15', dueDate: '2026-03-18',
  });
  const visualDesign = await createNode('Visual Design', design.id, {
    effortEstimate: 5, percentComplete: 80, status: 'in_progress',
    startDate: '2026-03-18', dueDate: '2026-03-25',
    dependencies: [{ targetNodeId: wireframes.id, type: 'FS', lag: 0 }],
  });
  const designSystem = await createNode('Design System', design.id, {
    effortEstimate: 4, percentComplete: 25, status: 'in_progress',
    startDate: '2026-03-20', dueDate: '2026-03-28',
    dependencies: [{ targetNodeId: wireframes.id, type: 'FS', lag: 0 }],
  });

  // Update design children_order
  await db.update(nodes)
    .set({ childrenOrder: [wireframes.id, visualDesign.id, designSystem.id] })
    .where(sql`${nodes.id} = ${design.id}`);

  // ── Backend branch ───────────────────────────────────────
  const backend = await createNode('Backend', root.id);
  const apiEndpoints = await createNode('API Endpoints', backend.id, {
    effortEstimate: 7, percentComplete: 0, status: 'todo',
    startDate: '2026-03-25', dueDate: '2026-04-05',
  });
  const dbMigration = await createNode('DB Migration', backend.id, {
    effortEstimate: 5, percentComplete: 0, status: 'todo',
    startDate: '2026-03-25', dueDate: '2026-04-02',
  });

  await db.update(nodes)
    .set({ childrenOrder: [apiEndpoints.id, dbMigration.id] })
    .where(sql`${nodes.id} = ${backend.id}`);

  // ── Frontend branch ──────────────────────────────────────
  const frontend = await createNode('Frontend', root.id);
  const componentLib = await createNode('Component Library', frontend.id, {
    effortEstimate: 6, percentComplete: 40, status: 'in_progress',
    startDate: '2026-03-22', dueDate: '2026-04-02',
    dependencies: [{ targetNodeId: designSystem.id, type: 'SS', lag: 2 }],
  });
  const pageTemplates = await createNode('Page Templates', frontend.id, {
    effortEstimate: 8, percentComplete: 10, status: 'in_progress',
    startDate: '2026-03-28', dueDate: '2026-04-10',
    dependencies: [{ targetNodeId: componentLib.id, type: 'FS', lag: 0 }],
  });
  const responsiveTesting = await createNode('Responsive Testing', frontend.id, {
    effortEstimate: 3, percentComplete: 0, status: 'todo',
    startDate: '2026-04-10', dueDate: '2026-04-15',
    dependencies: [{ targetNodeId: pageTemplates.id, type: 'FS', lag: 0 }],
  });

  await db.update(nodes)
    .set({ childrenOrder: [componentLib.id, pageTemplates.id, responsiveTesting.id] })
    .where(sql`${nodes.id} = ${frontend.id}`);

  // ── Content branch ───────────────────────────────────────
  const content = await createNode('Content', root.id);
  const copywriting = await createNode('Copywriting', content.id, {
    effortEstimate: 4, percentComplete: 60, status: 'in_progress',
    startDate: '2026-03-18', dueDate: '2026-03-28',
  });
  const assetCreation = await createNode('Asset Creation', content.id, {
    effortEstimate: 3, percentComplete: 30, status: 'in_progress',
    startDate: '2026-03-22', dueDate: '2026-03-30',
    dependencies: [{ targetNodeId: visualDesign.id, type: 'SS', lag: 0 }],
  });

  await db.update(nodes)
    .set({ childrenOrder: [copywriting.id, assetCreation.id] })
    .where(sql`${nodes.id} = ${content.id}`);

  // ── Integration Testing ──────────────────────────────────
  const integrationTesting = await createNode('Integration Testing', root.id, {
    effortEstimate: 3, percentComplete: 0, status: 'todo',
    startDate: '2026-04-10', dueDate: '2026-04-15',
    dependencies: [
      { targetNodeId: apiEndpoints.id, type: 'FS', lag: 0 },
      { targetNodeId: responsiveTesting.id, type: 'SS', lag: 0 },
    ],
  });

  // ── Launch milestone ─────────────────────────────────────
  const launch = await createNode('Launch', root.id, {
    isMilestone: true,
    dueDate: '2026-04-18',
    dependencies: [{ targetNodeId: integrationTesting.id, type: 'FS', lag: 0 }],
  });

  // Update root children_order
  await db.update(nodes)
    .set({
      childrenOrder: [
        design.id,
        backend.id,
        frontend.id,
        content.id,
        integrationTesting.id,
        launch.id,
      ],
    })
    .where(sql`${nodes.id} = ${root.id}`);

  // Set map's rootNodeId
  await db.update(maps)
    .set({ rootNodeId: root.id })
    .where(sql`${maps.id} = ${map.id}`);

  // ── Cycles ──────────────────────────────────────────────────────
  const [sprint1] = await db.insert(cycles).values({
    workspaceId: workspace.id,
    name: 'Sprint 1',
    startDate: '2026-04-01',
    endDate: '2026-04-14',
    status: 'active',
    createdAt: now,
  }).returning();

  const [sprint2] = await db.insert(cycles).values({
    workspaceId: workspace.id,
    name: 'Sprint 2',
    startDate: '2026-04-15',
    endDate: '2026-04-28',
    status: 'planned',
    createdAt: now,
  }).returning();

  // Assign Design and Content leaf nodes to Sprint 1
  const sprint1NodeIds = [wireframes.id, visualDesign.id, designSystem.id, copywriting.id, assetCreation.id];
  for (const nodeId of sprint1NodeIds) {
    await db.update(nodes)
      .set({ cycleId: sprint1.id, updatedAt: now })
      .where(sql`${nodes.id} = ${nodeId}`);
  }

  // Assign Backend, Frontend, and Integration Testing leaf nodes to Sprint 2
  const sprint2NodeIds = [apiEndpoints.id, dbMigration.id, componentLib.id, pageTemplates.id, responsiveTesting.id, integrationTesting.id];
  for (const nodeId of sprint2NodeIds) {
    await db.update(nodes)
      .set({ cycleId: sprint2.id, updatedAt: now })
      .where(sql`${nodes.id} = ${nodeId}`);
  }

  // Give collaborator edit permission on the map
  await db.insert(mapPermissions).values({
    mapId: map.id,
    userId: collaborator.id,
    permission: 'edit',
  });

  console.log('[seed] "Website Redesign" example created successfully.');
  console.log(`[seed]   Map ID: ${map.id}`);
  console.log(`[seed]   Root Node ID: ${root.id}`);
  console.log(`[seed]   Total nodes: 13`);
  console.log(`[seed]   Sprint 1 ID: ${sprint1.id} (${sprint1NodeIds.length} nodes)`);
  console.log(`[seed]   Sprint 2 ID: ${sprint2.id} (${sprint2NodeIds.length} nodes)`);
  console.log(`[seed]   Demo user: demo@mindblown.dev / demo123`);
  console.log(`[seed]   Collaborator: collaborator@mindblown.dev / demo123`);
}
