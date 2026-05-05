import {
  pgTable,
  uuid,
  text,
  real,
  boolean,
  jsonb,
  timestamp,
  date,
  integer,
  primaryKey,
} from 'drizzle-orm/pg-core';

// ── Users ──────────────────────────────────────────────────────────

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash'),
  avatarUrl: text('avatar_url'),
  isAdmin: boolean('is_admin').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── System-wide key/value settings ────────────────────────────────

export const systemSettings = pgTable('system_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
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
  wipLimit: real('wip_limit'),
  projectStartDate: date('project_start_date'),
  hoursPerDay: real('hours_per_day').notNull().default(8),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  publicToken: text('public_token'),
  githubInstallationId: text('github_installation_id'),
  githubRepoOwner: text('github_repo_owner'),
  githubRepoName: text('github_repo_name'),
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
  actualEffort: real('actual_effort'),
  percentComplete: real('percent_complete'),
  status: text('status'),
  assigneeIds: jsonb('assignee_ids').notNull().default([]), // uuid[]
  priority: text('priority'),
  dueDate: date('due_date'),
  startDate: date('start_date'),
  tags: jsonb('tags').notNull().default([]), // text[]
  customFields: jsonb('custom_fields').notNull().default({}),
  dependencies: jsonb('dependencies').notNull().default([]), // Dependency[]
  versionId: uuid('version_id'),
  cycleId: uuid('cycle_id'),
  externalLinks: jsonb('external_links').notNull().default([]), // ExternalLink[]
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  // Optimistic-locking counter — bumps on every successful update.
  revision: integer('revision').notNull().default(1),
  // Semantic search — jsonb float array; see packages/server/src/ai/embeddings.ts
  embedding: jsonb('embedding'),
  embeddingText: text('embedding_text'),
  embeddingUpdatedAt: timestamp('embedding_updated_at', { withTimezone: true }),
});

// ── Map Permissions ───────────────────────────────────────────────

export const mapPermissions = pgTable('map_permissions', {
  mapId: uuid('map_id').notNull().references(() => maps.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  permission: text('permission').notNull(), // 'view' | 'edit' | 'admin'
}, (table) => [
  primaryKey({ columns: [table.mapId, table.userId] }),
]);

// ── Pending Invites ──────────────────────────────────────────────

export const pendingInvites = pgTable('pending_invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  mapId: uuid('map_id').notNull().references(() => maps.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  permission: text('permission').notNull(), // 'view' | 'edit' | 'admin'
  invitedBy: uuid('invited_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Comments ──────────────────────────────────────────────────────

export const comments = pgTable('comments', {
  id: uuid('id').primaryKey().defaultRandom(),
  nodeId: uuid('node_id').notNull().references(() => nodes.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id),
  text: text('text').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── GitHub App Installations ─────────────────────────────────────

export const githubInstallations = pgTable('github_installations', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  installationId: text('installation_id').notNull(), // GitHub's numeric ID (stored as text)
  accountLogin: text('account_login').notNull(), // GitHub user or org login
  accountType: text('account_type').notNull(), // 'User' | 'Organization'
  accountId: text('account_id').notNull(), // GitHub account numeric ID
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── User GitHub Identities (OAuth) ──────────────────────────────

export const userGithubIdentities = pgTable('user_github_identities', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }).unique(),
  githubUserId: text('github_user_id').notNull(),
  githubLogin: text('github_login').notNull(),
  avatarUrl: text('avatar_url'),
  encryptedAccessToken: text('encrypted_access_token').notNull(),
  encryptedRefreshToken: text('encrypted_refresh_token'),
  tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
  scopes: text('scopes'), // comma-separated
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

// ── Versions ──────────────────────────────────────────────────────

export const versions = pgTable('versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  mapId: uuid('map_id').notNull().references(() => maps.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  status: text('status').notNull().default('planning'),
  targetDate: date('target_date'),
  sortOrder: real('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Release Snapshots ────────────────────────────────────────────
// Daily history of each version's projected finish date so the
// Releases view can show "slipped +5d this week" trend indicators
// and alerts can diff two snapshots. Written by the hourly
// snapshotReleaseForecasts job (upserts today's row) and on-demand
// via ?refresh=1 on GET /api/maps/:id/release-forecast.
//
// versionId is intentionally not a FK — when a version is deleted
// the history rows stay around as read-only audit trail. version_name
// is denormalized for the same reason.

export const releaseSnapshots = pgTable('release_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  mapId: uuid('map_id').notNull().references(() => maps.id, { onDelete: 'cascade' }),
  versionId: uuid('version_id').notNull(),
  versionName: text('version_name').notNull(),
  snapshotDate: date('snapshot_date').notNull(),
  targetDate: date('target_date'),
  plannedFinishDate: date('planned_finish_date'),
  velocityAdjustedFinishDate: date('velocity_adjusted_finish_date'),
  remainingEffort: real('remaining_effort').notNull(),
  totalEffort: real('total_effort').notNull(),
  leaves: real('leaves').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Change Events ─────────────────────────────────────────────────
// Append-only log of node mutations — the substrate for burnup, status
// digest, and any other "what changed since X" feature. Writes happen
// fire-and-forget from the write routes so a logging failure never takes
// down a mutation.

export const changeEvents = pgTable('change_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  mapId: uuid('map_id').notNull().references(() => maps.id, { onDelete: 'cascade' }),
  nodeId: uuid('node_id'), // null for 'map.*' events, kept for deleted nodes
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  eventType: text('event_type').notNull(), // 'node.created' | 'node.deleted' | 'node.moved' | 'node.field_changed'
  fieldName: text('field_name'), // set when eventType = 'node.field_changed'
  oldValue: jsonb('old_value'),
  newValue: jsonb('new_value'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Cycles ─────────────────────────────────────────────────────────

export const cycles = pgTable('cycles', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  mapId: uuid('map_id').notNull().references(() => maps.id, { onDelete: 'cascade' }),
  versionId: uuid('version_id').references(() => versions.id),
  name: text('name').notNull(),
  startDate: date('start_date').notNull(),
  endDate: date('end_date').notNull(),
  status: text('status').notNull().default('planned'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
