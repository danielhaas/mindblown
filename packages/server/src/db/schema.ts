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

// ── API Keys (per-user, GitHub-PAT style) ─────────────────────────
//
// Headless clients (the HTTP MCP at /mcp, future CLI tools) authenticate
// with a long-lived per-user secret rather than a session JWT. Plaintext
// looks like `mb_<32-char base64url>`; only the scrypt hash is stored.
// `keyPrefix` keeps the first 8 plaintext chars so the management UI
// can show "mb_abc12345…" without exposing the full secret.

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  keyHash: text('key_hash').notNull(),
  keyPrefix: text('key_prefix').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
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
  // Per-map opt-in: when true, new GitHub issues on the bound repo are
  // auto-imported as nodes under the GitHub Inbox. Default false so
  // existing maps don't flood retroactively when this column lands.
  autoImportNewIssues: boolean('auto_import_new_issues').notNull().default(false),
  // Cached "GitHub Inbox" node id — created lazily on first ingest and
  // refreshed when the stored node is gone (deleted by the user).
  // Deliberately no FK so deleting the node doesn't cascade-mutate this
  // column; ensureInboxNode() detects the dangling ref and recreates.
  githubInboxNodeId: uuid('github_inbox_node_id'),
  // Per-map opt-in for the AI triage pipeline (#92, #93). When true, new
  // GitHub issues bound to this map go through `triageIssue()` before
  // any node is created; the decision is persisted in `triage_decisions`
  // and high-confidence place-decisions auto-create the node under the
  // suggested parent. Default false → ingest behaves exactly like
  // before (flat under the GitHub Inbox).
  triageEnabled: boolean('triage_enabled').notNull().default(false),
  // Per-map opt-in for Phase 3 GitHub label write-back (#96). When true,
  // finalized triage decisions write `triage:placed` / `triage:skipped`
  // labels back to the source GitHub issue. Default false so existing
  // maps don't suddenly mutate their bound repos. Best-effort: a label
  // write failure never blocks the triage flow. Uncertain decisions do
  // NOT write labels — intermediate state would just noise up GitHub.
  triageLabelWriteback: boolean('triage_label_writeback').notNull().default(false),

  // ── Orchestration substrate (#111) ───────────────────────────
  // How long (in hours) a claim may sit without a progress update before the
  // stale-claim sweeper auto-releases it. Default 4 h. REAL so operators can
  // set fractional hours (e.g. 0.5 for 30-minute stale threshold during
  // short sessions).
  staleClaimHours: real('stale_claim_hours').notNull().default(4),
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
  blockedReason: text('blocked_reason'),
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
  // Parent-epic auto-progress rollup. 'off' (default) = manual progress is
  // authoritative; 'children' = computed from linked GitHub child PRs via
  // parentEpicRollup. See packages/server/src/sync/parentEpicRollup.ts.
  autoProgress: text('auto_progress').notNull().default('off'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  // Optimistic-locking counter — bumps on every successful update.
  revision: integer('revision').notNull().default(1),
  // Semantic search — jsonb float array; see packages/server/src/ai/embeddings.ts
  embedding: jsonb('embedding'),
  embeddingText: text('embedding_text'),
  embeddingUpdatedAt: timestamp('embedding_updated_at', { withTimezone: true }),
  // Soft delete — non-null = in the Trash. Reads must filter `WHERE
  // deleted_at IS NULL` unless they're an audit/snapshot path. GC hard-deletes
  // rows after the retention window. See packages/server/src/db/nodes.ts.
  deletedAt: timestamp('deleted_at', { withTimezone: true }),

  // ── Gantt slice 1 (#109) ──────────────────────────────────────
  // Fractional ranking for drag-to-reorder within a sibling group.
  // null = no explicit rank (sorts after ranked siblings in resolved order).
  priorityRank: real('priority_rank'),

  // ── Orchestration substrate (#111) ───────────────────────────
  // claimed_by_session: session ID that owns this node for active work.
  //   null = unclaimed / available.
  // claimed_at: when the current claim was set; used by stale-claim sweeper.
  // scopes: free-form tags for conflict detection (e.g. 'apps/workflows',
  //   'model:Mandate'). Stored as JSONB text[]. Empty = no declared scopes.
  claimedBySession: text('claimed_by_session'),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  scopes: jsonb('scopes').notNull().default([]),
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

// ── GitHub Repo Sync State ───────────────────────────────────────
// Tracks the last successful catch-up reconcile per (owner, repo) so
// the periodic catch-up can ask GitHub for "issues updated since X"
// instead of refetching the world. Webhooks remain the realtime path;
// this table backstops missed deliveries (downtime, signature mismatch).

export const githubRepoSync = pgTable('github_repo_sync', {
  owner: text('owner').notNull(),
  repo: text('repo').notNull(),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }).notNull(),
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

// ── Triage Decisions (#92, #93) ───────────────────────────────────
// Per-issue AI triage outcome. Written by the triage pipeline before a
// node is created; persisted regardless of decision so operators can
// audit + override. UNIQUE on (map_id, external_id) so re-triage is an
// idempotent upsert. `placed_node_id` is non-FK on purpose — when the
// auto-created node is later deleted, the decision row stays around as
// audit trail (same convention as `release_snapshots.version_id`).
// `decided_by`: 'auto' for pipeline-produced rows, 'operator' once an
// override or reclassify has been applied.

export const triageDecisions = pgTable('triage_decisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  mapId: uuid('map_id').notNull().references(() => maps.id, { onDelete: 'cascade' }),
  externalId: text('external_id').notNull(), // "owner/repo#NNN"
  issueTitle: text('issue_title').notNull(),
  issueState: text('issue_state').notNull(), // 'open' | 'closed'
  decision: text('decision').notNull(), // 'skip' | 'place' | 'uncertain'
  reason: text('reason').notNull(),
  confidence: integer('confidence').notNull(), // 0-100
  placedNodeId: uuid('placed_node_id'),
  decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
  decidedBy: text('decided_by').notNull(), // 'auto' | 'operator'
  reviewed: boolean('reviewed').notNull().default(false),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  reviewedBy: uuid('reviewed_by').references(() => users.id),
});

// ── Triage Decision History (#96, Phase 3) ────────────────────────
// Append-only audit log for every mutation of a `triage_decisions` row.
// Written by `recordTriageHistory()` from each call site that mutates a
// triage row (auto-ingest, override, reclassify, confirm, reopen-sync,
// bulk variants). Cascades on `triage_decisions` delete because the
// decision row is the natural lifecycle anchor — if the operator deletes
// a triage row, its history rides along.
//
// `changed_by` is either the literal string 'auto' (the pipeline) or a
// stringified userId. It's text rather than a nullable users(id) FK so
// the 'auto' sentinel doesn't need a synthetic user row, and so deleting
// an operator user doesn't drop their audit trail.

export const triageDecisionHistory = pgTable('triage_decision_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  decisionId: uuid('decision_id').notNull().references(() => triageDecisions.id, { onDelete: 'cascade' }),
  changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  changedBy: text('changed_by').notNull(), // 'auto' | userId
  changeType: text('change_type').notNull(), // 'created' | 'overridden' | 'reclassified' | 'confirmed' | 'state_synced'
  previousDecision: text('previous_decision'), // null on 'created'
  newDecision: text('new_decision').notNull(),
  previousConfidence: integer('previous_confidence'),
  newConfidence: integer('new_confidence'),
  previousParentNodeId: uuid('previous_parent_node_id'),
  newParentNodeId: uuid('new_parent_node_id'),
  reason: text('reason'), // snapshot of the new decision's reason
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
