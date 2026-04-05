import {
  pgTable,
  uuid,
  text,
  real,
  boolean,
  jsonb,
  timestamp,
  date,
  primaryKey,
} from 'drizzle-orm/pg-core';

// ── Users ──────────────────────────────────────────────────────────

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash'),
  avatarUrl: text('avatar_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Workspaces ─────────────────────────────────────────────────────

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  ownerId: uuid('owner_id').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Maps ───────────────────────────────────────────────────────────

export const maps = pgTable('maps', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  name: text('name').notNull(),
  description: text('description'),
  rootNodeId: uuid('root_node_id'), // set after root node is created
  effortUnit: text('effort_unit').notNull().default('days'),
  statusWorkflow: jsonb('status_workflow').notNull().default([
    { id: 'todo', name: 'Todo', category: 'todo', color: '#9ca3af', position: 0 },
    { id: 'in_progress', name: 'In Progress', category: 'in_progress', color: '#3b82f6', position: 1 },
    { id: 'done', name: 'Done', category: 'done', color: '#22c55e', position: 2 },
  ]),
  customFieldDefs: jsonb('custom_field_defs').notNull().default([]),
  defaultLayout: text('default_layout').notNull().default('tree_lr'),
  healthThreshold: real('health_threshold').notNull().default(0.2),
  baselines: jsonb('baselines').notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  publicToken: text('public_token'),
});

// ── Nodes ──────────────────────────────────────────────────────────

export const nodes = pgTable('nodes', {
  id: uuid('id').primaryKey().defaultRandom(),
  mapId: uuid('map_id').notNull().references(() => maps.id, { onDelete: 'cascade' }),
  parentId: uuid('parent_id'), // self-referencing, null = root
  childrenOrder: jsonb('children_order').notNull().default([]), // uuid[] as jsonb array
  text: text('text').notNull(),
  description: jsonb('description'), // rich text as ProseMirror JSON
  x: real('x'),
  y: real('y'),
  collapsed: boolean('collapsed').notNull().default(false),
  effortEstimate: real('effort_estimate'),
  percentComplete: real('percent_complete'),
  status: text('status'),
  assigneeIds: jsonb('assignee_ids').notNull().default([]), // uuid[]
  priority: text('priority'),
  dueDate: date('due_date'),
  startDate: date('start_date'),
  tags: jsonb('tags').notNull().default([]), // text[]
  customFields: jsonb('custom_fields').notNull().default({}),
  dependencies: jsonb('dependencies').notNull().default([]), // Dependency[]
  isMilestone: boolean('is_milestone').notNull().default(false),
  cycleId: uuid('cycle_id'),
  externalLinks: jsonb('external_links').notNull().default([]), // ExternalLink[]
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by').notNull().references(() => users.id),
});

// ── Map Permissions ───────────────────────────────────────────────

export const mapPermissions = pgTable('map_permissions', {
  mapId: uuid('map_id').notNull().references(() => maps.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  permission: text('permission').notNull(), // 'view' | 'edit' | 'admin'
}, (table) => [
  primaryKey({ columns: [table.mapId, table.userId] }),
]);

// ── Comments ──────────────────────────────────────────────────────

export const comments = pgTable('comments', {
  id: uuid('id').primaryKey().defaultRandom(),
  nodeId: uuid('node_id').notNull().references(() => nodes.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id),
  text: text('text').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Integrations ──────────────────────────────────────────────────

export const integrations = pgTable('integrations', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  provider: text('provider').notNull(), // 'github' | 'jira' | 'linear' | 'gitlab'
  config: jsonb('config').notNull().default({}), // provider-specific: { owner, repo, token, webhookSecret }
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Cycles ─────────────────────────────────────────────────────────

export const cycles = pgTable('cycles', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  name: text('name').notNull(),
  startDate: date('start_date').notNull(),
  endDate: date('end_date').notNull(),
  status: text('status').notNull().default('planned'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
