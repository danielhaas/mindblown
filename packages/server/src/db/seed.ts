import { db } from './connection.js';
import { users, workspaces, maps, nodes } from './schema.js';
import { sql } from 'drizzle-orm';

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

  // Create default user
  const [user] = await db.insert(users).values({
    email: 'demo@mindblown.dev',
    name: 'Demo User',
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

  console.log('[seed] "Website Redesign" example created successfully.');
  console.log(`[seed]   Map ID: ${map.id}`);
  console.log(`[seed]   Root Node ID: ${root.id}`);
  console.log(`[seed]   Total nodes: 13`);
}
