import { sql } from 'drizzle-orm';
import { db } from './connection.js';
import * as schema from './schema.js';

/**
 * Ensure all tables exist by running a simple create-if-not-exists approach.
 * In production, use drizzle-kit push or migrate for proper migrations.
 * For dev, we create tables directly from the schema.
 */
export async function runMigrations(): Promise<void> {
  console.log('[db] Running migrations...');

  // Create tables using raw SQL (matching the Drizzle schema)
  // This is the pragmatic approach for a dev setup — drizzle-kit push
  // handles production migrations.

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      avatar_url TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS workspaces (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      owner_id UUID NOT NULL REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS maps (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id UUID NOT NULL REFERENCES workspaces(id),
      name TEXT NOT NULL,
      description TEXT,
      root_node_id UUID,
      effort_unit TEXT NOT NULL DEFAULT 'days',
      status_workflow JSONB NOT NULL DEFAULT '[{"id":"todo","name":"Todo","category":"todo","color":"#9ca3af","position":0},{"id":"in_progress","name":"In Progress","category":"in_progress","color":"#3b82f6","position":1},{"id":"done","name":"Done","category":"done","color":"#22c55e","position":2}]',
      custom_field_defs JSONB NOT NULL DEFAULT '[]',
      default_layout TEXT NOT NULL DEFAULT 'tree_lr',
      health_threshold REAL NOT NULL DEFAULT 0.2,
      baselines JSONB NOT NULL DEFAULT '[]',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by UUID NOT NULL REFERENCES users(id),
      archived_at TIMESTAMPTZ
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS nodes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      map_id UUID NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
      parent_id UUID,
      children_order JSONB NOT NULL DEFAULT '[]',
      text TEXT NOT NULL,
      description JSONB,
      x REAL,
      y REAL,
      collapsed BOOLEAN NOT NULL DEFAULT false,
      effort_estimate REAL,
      percent_complete REAL,
      status TEXT,
      assignee_ids JSONB NOT NULL DEFAULT '[]',
      priority TEXT,
      due_date DATE,
      start_date DATE,
      tags JSONB NOT NULL DEFAULT '[]',
      custom_fields JSONB NOT NULL DEFAULT '{}',
      dependencies JSONB NOT NULL DEFAULT '[]',
      cycle_id UUID,
      external_links JSONB NOT NULL DEFAULT '[]',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by UUID NOT NULL REFERENCES users(id)
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS cycles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id UUID NOT NULL REFERENCES workspaces(id),
      name TEXT NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      status TEXT NOT NULL DEFAULT 'planned',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // ── Versions ──────────────────────────────────────────────────
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS versions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id UUID NOT NULL REFERENCES workspaces(id),
      name TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'planning',
      target_date DATE,
      sort_order REAL NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // ── Add version_id to cycles (sprints belong to a version) ────
  await db.execute(sql`
    ALTER TABLE cycles ADD COLUMN IF NOT EXISTS version_id UUID REFERENCES versions(id)
  `);

  // ── Add version_id to nodes ───────────────────────────────────
  await db.execute(sql`
    ALTER TABLE nodes ADD COLUMN IF NOT EXISTS version_id UUID REFERENCES versions(id)
  `);

  // ── Scope versions and cycles to a map (not just a workspace) ──
  // Versions and sprints are per-map, matching the way nodes are
  // organized. Added 2026-04-22. Backfill logic:
  //   1. For versions with node refs: mode of nodes.map_id.
  //   2. Otherwise: oldest map in the same workspace.
  //   3. For cycles: inherit from version if set, else same fallback.
  // After backfill we null out cross-map node.version_id / cycle_id
  // refs so the new (nodes.map_id, version.map_id) invariant holds.
  await db.execute(sql`
    ALTER TABLE versions ADD COLUMN IF NOT EXISTS map_id UUID REFERENCES maps(id) ON DELETE CASCADE
  `);
  await db.execute(sql`
    ALTER TABLE cycles ADD COLUMN IF NOT EXISTS map_id UUID REFERENCES maps(id) ON DELETE CASCADE
  `);

  await db.execute(sql`
    UPDATE versions v
    SET map_id = sub.map_id
    FROM (
      SELECT DISTINCT ON (n.version_id) n.version_id, n.map_id, COUNT(*) OVER (PARTITION BY n.version_id, n.map_id) AS cnt
      FROM nodes n
      WHERE n.version_id IS NOT NULL
      ORDER BY n.version_id, cnt DESC, n.map_id
    ) sub
    WHERE v.id = sub.version_id AND v.map_id IS NULL
  `);

  await db.execute(sql`
    UPDATE versions v
    SET map_id = (
      SELECT m.id FROM maps m
      WHERE m.workspace_id = v.workspace_id
      ORDER BY m.created_at ASC
      LIMIT 1
    )
    WHERE v.map_id IS NULL
  `);

  await db.execute(sql`
    UPDATE cycles c
    SET map_id = v.map_id
    FROM versions v
    WHERE c.version_id = v.id AND c.map_id IS NULL
  `);

  await db.execute(sql`
    UPDATE cycles c
    SET map_id = sub.map_id
    FROM (
      SELECT DISTINCT ON (n.cycle_id) n.cycle_id, n.map_id, COUNT(*) OVER (PARTITION BY n.cycle_id, n.map_id) AS cnt
      FROM nodes n
      WHERE n.cycle_id IS NOT NULL
      ORDER BY n.cycle_id, cnt DESC, n.map_id
    ) sub
    WHERE c.id = sub.cycle_id AND c.map_id IS NULL
  `);

  await db.execute(sql`
    UPDATE cycles c
    SET map_id = (
      SELECT m.id FROM maps m
      WHERE m.workspace_id = c.workspace_id
      ORDER BY m.created_at ASC
      LIMIT 1
    )
    WHERE c.map_id IS NULL
  `);

  // Null out cross-map node refs so the invariant holds.
  await db.execute(sql`
    UPDATE nodes n
    SET version_id = NULL
    WHERE n.version_id IS NOT NULL
      AND (SELECT map_id FROM versions v WHERE v.id = n.version_id) <> n.map_id
  `);
  await db.execute(sql`
    UPDATE nodes n
    SET cycle_id = NULL
    WHERE n.cycle_id IS NOT NULL
      AND (SELECT map_id FROM cycles c WHERE c.id = n.cycle_id) <> n.map_id
  `);

  // Versions/cycles with no workspace maps at all stay NULL; leaving the
  // column nullable for that edge case (orphan workspace). In practice
  // every prod workspace has at least one map, so the guards here are belt-
  // and-braces — not a runtime hot path.
  await db.execute(sql`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM versions WHERE map_id IS NULL) THEN
        ALTER TABLE versions ALTER COLUMN map_id SET NOT NULL;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM cycles WHERE map_id IS NULL) THEN
        ALTER TABLE cycles ALTER COLUMN map_id SET NOT NULL;
      END IF;
    END $$
  `);

  // ── Add password_hash and public_token columns (idempotent) ────
  await db.execute(sql`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT
  `);

  await db.execute(sql`
    ALTER TABLE maps ADD COLUMN IF NOT EXISTS public_token TEXT
  `);

  await db.execute(sql`
    ALTER TABLE maps ADD COLUMN IF NOT EXISTS wip_limit REAL
  `);

  await db.execute(sql`
    ALTER TABLE nodes ADD COLUMN IF NOT EXISTS actual_effort REAL
  `);

  await db.execute(sql`
    ALTER TABLE nodes ADD COLUMN IF NOT EXISTS blocked_reason TEXT
  `);

  await db.execute(sql`
    ALTER TABLE maps ADD COLUMN IF NOT EXISTS project_start_date DATE
  `);
  await db.execute(sql`
    ALTER TABLE maps ADD COLUMN IF NOT EXISTS hours_per_day REAL NOT NULL DEFAULT 8
  `);

  // ── Map Permissions ───────────────────────────────────────────
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS map_permissions (
      map_id UUID NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      permission TEXT NOT NULL,
      PRIMARY KEY (map_id, user_id)
    )
  `);

  // ── Comments ──────────────────────────────────────────────────
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS comments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      node_id UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id),
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // ── Integrations ──────────────────────────────────────────────
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS integrations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id UUID NOT NULL REFERENCES workspaces(id),
      provider TEXT NOT NULL,
      config JSONB NOT NULL DEFAULT '{}',
      enabled BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // ── GitHub App Installations ────────────────────────────────────
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS github_installations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      installation_id TEXT NOT NULL,
      account_login TEXT NOT NULL,
      account_type TEXT NOT NULL,
      account_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // ── User GitHub Identities (OAuth) ────────────────────────────
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS user_github_identities (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
      github_user_id TEXT NOT NULL,
      github_login TEXT NOT NULL,
      avatar_url TEXT,
      encrypted_access_token TEXT NOT NULL,
      encrypted_refresh_token TEXT,
      token_expires_at TIMESTAMPTZ,
      scopes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // ── Change Events (append-only mutation log) ───────────────────
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS change_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      map_id UUID NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
      node_id UUID,
      user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      event_type TEXT NOT NULL,
      field_name TEXT,
      old_value JSONB,
      new_value JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_change_events_map_created ON change_events(map_id, created_at DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_change_events_node ON change_events(node_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_change_events_event_type ON change_events(event_type)`);

  // ── Add GitHub repo binding columns to maps ───────────────────
  await db.execute(sql`
    ALTER TABLE maps ADD COLUMN IF NOT EXISTS github_installation_id TEXT
  `);
  await db.execute(sql`
    ALTER TABLE maps ADD COLUMN IF NOT EXISTS github_repo_owner TEXT
  `);
  await db.execute(sql`
    ALTER TABLE maps ADD COLUMN IF NOT EXISTS github_repo_name TEXT
  `);

  // ── GitHub Repo Sync State ─────────────────────────────────────
  // Per-repo "last successful catch-up reconcile" timestamp. The
  // periodic catch-up uses this as the `since=` filter on GitHub's
  // issues API so we only refetch things that have changed since the
  // last clean sweep. Keyed by (owner, repo) — a single repo may be
  // shared across maps/workspaces, but we sync it once per cycle.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS github_repo_sync (
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      last_synced_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (owner, repo)
    )
  `);

  // ── Pending Invites ────────────────────────────────────────────
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS pending_invites (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      map_id UUID NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      permission TEXT NOT NULL,
      invited_by UUID NOT NULL REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(map_id, email)
    )
  `);

  // Create indexes (idempotent)
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_nodes_map_id ON nodes(map_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_nodes_parent_id ON nodes(parent_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_integrations_workspace_id ON integrations(workspace_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_comments_node_id ON comments(node_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_map_permissions_map_id ON map_permissions(map_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_map_permissions_user_id ON map_permissions(user_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_versions_workspace_id ON versions(workspace_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_cycles_version_id ON cycles(version_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_nodes_version_id ON nodes(version_id)`);

  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pending_invites_email ON pending_invites(email)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pending_invites_map_id ON pending_invites(map_id)`);

  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_github_installations_user_id ON github_installations(user_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_github_installations_installation_id ON github_installations(installation_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_user_github_identities_user_id ON user_github_identities(user_id)`);

  // ── System settings (key/value store) ─────────────────────────
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // ── Admin flag on users ───────────────────────────────────────
  await db.execute(sql`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false
  `);

  // First-run bootstrap: if no user is an admin yet, promote the
  // oldest-registered REAL user. We explicitly skip users in the seed
  // domain (@mindblown.dev) so the example workspace's demo account
  // doesn't accidentally become the admin on a fresh deploy.
  await db.execute(sql`
    UPDATE users SET is_admin = true
    WHERE id = (
      SELECT id FROM users
      WHERE email NOT LIKE '%@mindblown.dev'
      ORDER BY created_at ASC
      LIMIT 1
    )
    AND NOT EXISTS (SELECT 1 FROM users WHERE is_admin = true)
  `);

  // ── Optimistic locking counter on nodes ───────────────────────
  // Bumps on every successful update. Clients pass their last-seen
  // value; server rejects mismatches with 409 so concurrent edits
  // don't silently clobber each other.
  await db.execute(sql`
    ALTER TABLE nodes ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1
  `);

  // ── Node embeddings (semantic search) ─────────────────────────
  // Stored as jsonb float array — pgvector isn't available on the
  // prod Postgres image, so similarity is computed in JS. Fine for
  // the map sizes we're targeting (< 10k nodes). `embedding_text`
  // tracks the exact text the vector was computed from so we know
  // when to re-embed vs reuse.
  await db.execute(sql`
    ALTER TABLE nodes ADD COLUMN IF NOT EXISTS embedding JSONB
  `);
  await db.execute(sql`
    ALTER TABLE nodes ADD COLUMN IF NOT EXISTS embedding_text TEXT
  `);
  await db.execute(sql`
    ALTER TABLE nodes ADD COLUMN IF NOT EXISTS embedding_updated_at TIMESTAMPTZ
  `);

  // ── Release Snapshots (daily history for trend indicators) ────
  // Written by the hourly snapshot job (upserts today's row per
  // (map, version)) and on-demand via ?refresh=1 on the forecast
  // endpoint. Used by the Releases view to show "+5d this week"
  // trend deltas. version_id deliberately lacks a FK so deleted
  // versions leave their history behind as read-only audit trail.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS release_snapshots (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      map_id UUID NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
      version_id UUID NOT NULL,
      version_name TEXT NOT NULL,
      snapshot_date DATE NOT NULL,
      target_date DATE,
      planned_finish_date DATE,
      velocity_adjusted_finish_date DATE,
      remaining_effort REAL NOT NULL,
      total_effort REAL NOT NULL,
      leaves REAL NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (map_id, version_id, snapshot_date)
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_release_snapshots_map_date
    ON release_snapshots(map_id, snapshot_date DESC)
  `);

  // ── Auto-ingest of new GitHub issues into a map's "Inbox" node ──
  // Per-map opt-in flag + cached inbox node id. Default off so existing
  // maps don't repopulate "what shipped last month" on the next
  // catchup tick when this feature lands. The frontend defaults the
  // toggle to checked on first GitHub connect, so new connections
  // get auto-import naturally. No FK on the node id — when the user
  // deletes the inbox node, ensureInboxNode() lazy-recreates.
  await db.execute(sql`
    ALTER TABLE maps ADD COLUMN IF NOT EXISTS auto_import_new_issues BOOLEAN NOT NULL DEFAULT false
  `);
  await db.execute(sql`
    ALTER TABLE maps ADD COLUMN IF NOT EXISTS github_inbox_node_id UUID
  `);

  // ── Parent-epic auto-progress flag on nodes (#57) ─────────────
  // Default 'off' so existing nodes keep manual progress; flip to
  // 'children' to opt into auto-rollup from GitHub child-PR patterns.
  // No backfill needed — the default covers every existing row.
  await db.execute(sql`
    ALTER TABLE nodes ADD COLUMN IF NOT EXISTS auto_progress TEXT NOT NULL DEFAULT 'off'
  `);

  // ── API Keys (per-user, GitHub-PAT style) ────────────────────
  // Plaintext format: `mb_<32-char base64url>`. We store only the scrypt
  // hash (salt+key, same format as the password_hash column) plus the
  // first 8 plaintext chars in `key_prefix` so the UI can show a
  // recognizable stub. revoked_at = NULL means active; expires_at = NULL
  // means never expires. last_used_at is updated best-effort on each
  // successful validation so users can audit dormant keys.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS api_keys (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      key_prefix TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_api_keys_user_id_active
    ON api_keys(user_id) WHERE revoked_at IS NULL
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_api_keys_key_prefix
    ON api_keys(key_prefix)
  `);

  // ── AI Triage (#92, #93) ──────────────────────────────────────
  // Per-map opt-in flag + per-issue decision table. Default false so
  // existing maps keep their flat-under-inbox behavior when this column
  // lands. The decisions table is keyed on (map_id, external_id) so
  // re-triage upserts cleanly. `placed_node_id` is FK-less on purpose —
  // when the auto-created node is later deleted, the decision row stays
  // as audit trail (matches release_snapshots.version_id convention).
  await db.execute(sql`
    ALTER TABLE maps ADD COLUMN IF NOT EXISTS triage_enabled BOOLEAN NOT NULL DEFAULT false
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS triage_decisions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      map_id UUID NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
      external_id TEXT NOT NULL,
      issue_title TEXT NOT NULL,
      issue_state TEXT NOT NULL,
      decision TEXT NOT NULL,
      reason TEXT NOT NULL,
      confidence INTEGER NOT NULL,
      placed_node_id UUID,
      decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      decided_by TEXT NOT NULL,
      reviewed BOOLEAN NOT NULL DEFAULT false,
      reviewed_at TIMESTAMPTZ,
      reviewed_by UUID REFERENCES users(id),
      UNIQUE (map_id, external_id)
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS triage_decisions_map_unreviewed_idx
    ON triage_decisions(map_id) WHERE reviewed = false
  `);

  // ── suggested_parent_node_id (#TBD) ───────────────────────────
  // The LLM's most recent suggested parent for `place` decisions —
  // distinct from `placed_node_id` (which is set only when a node was
  // actually created). On low-confidence places the operator must
  // review; without this column the suggestion is only embedded in the
  // `reason` text and the Override modal opens with empty selection.
  // FK-less on purpose (mirrors placed_node_id) — when the suggested
  // node is later deleted, the row stays and the UI shows a "stale
  // suggestion" badge. Operator overrides do NOT update this column;
  // it always reflects the latest LLM suggestion so the audit history
  // can show "Claude suggested X, operator chose Y".
  await db.execute(sql`
    ALTER TABLE triage_decisions ADD COLUMN IF NOT EXISTS suggested_parent_node_id UUID
  `);

  // ── Triage cost opt (#142) — body-hash idempotency ────────────
  // SHA-256 of the canonical (title + body + sorted labels + state)
  // tuple used for the last successful auto-triage call. When a webhook
  // arrives whose hash matches this column, the LLM call is skipped
  // entirely. Existing rows keep `NULL` until their next auto-triage
  // populates the column (lazy migration — no backfill). Operator
  // reclassify accepts `force=true` to bypass the hash short-circuit.
  await db.execute(sql`
    ALTER TABLE triage_decisions ADD COLUMN IF NOT EXISTS last_input_hash TEXT
  `);

  // ── Phase 3 (#96) — opt-in GitHub label write-back per map ────
  // When true, finalized triage decisions write `triage:placed` /
  // `triage:skipped` labels back to the source GitHub issue. Default
  // false so existing maps don't suddenly mutate their bound repos.
  await db.execute(sql`
    ALTER TABLE maps ADD COLUMN IF NOT EXISTS triage_label_writeback BOOLEAN NOT NULL DEFAULT false
  `);

  // ── Phase 3 (#96) — triage decision history (audit log) ───────
  // Append-only history of every mutation on a triage_decisions row.
  // ON DELETE CASCADE: when a decision row is removed (cascade from
  // map delete, manual cleanup), its history rides along.
  // changed_by is TEXT (not a users FK) so the 'auto' sentinel doesn't
  // need a synthetic user row, and so dropping an operator user
  // doesn't truncate their audit trail.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS triage_decision_history (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      decision_id UUID NOT NULL REFERENCES triage_decisions(id) ON DELETE CASCADE,
      changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      changed_by TEXT NOT NULL,
      change_type TEXT NOT NULL,
      previous_decision TEXT,
      new_decision TEXT NOT NULL,
      previous_confidence INTEGER,
      new_confidence INTEGER,
      previous_parent_node_id UUID,
      new_parent_node_id UUID,
      reason TEXT
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS triage_decision_history_decision_idx
    ON triage_decision_history(decision_id)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS triage_decision_history_changed_at_idx
    ON triage_decision_history(changed_at DESC)
  `);

  // ── Drop Milestone entity (collapsed into Version) ────────────
  // Historical: milestones were a first-class entity and nodes carried
  // both milestone_id and an is_milestone boolean checkpoint flag.
  // In practice teams used only versions, so the two concepts were
  // collapsed. These drops run every startup; once applied they're
  // no-ops.
  await db.execute(sql`DROP INDEX IF EXISTS idx_nodes_milestone_id`);
  await db.execute(sql`DROP INDEX IF EXISTS idx_milestones_workspace_id`);
  await db.execute(sql`DROP INDEX IF EXISTS idx_milestones_version_id`);
  await db.execute(sql`ALTER TABLE nodes DROP COLUMN IF EXISTS milestone_id`);
  await db.execute(sql`ALTER TABLE nodes DROP COLUMN IF EXISTS is_milestone`);
  await db.execute(sql`DROP TABLE IF EXISTS milestones CASCADE`);

  // ── Soft delete (#107) ────────────────────────────────────────
  // Non-null = in Trash. Partial index keeps the hot WHERE deleted_at
  // IS NULL path index-free (most rows) while making Trash queries
  // fast and small.
  await db.execute(sql`
    ALTER TABLE nodes ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_nodes_deleted_at
    ON nodes(deleted_at) WHERE deleted_at IS NOT NULL
  `);

  // ── Gantt slice 1 (#109): priorityRank ──────────────────────────
  // Fractional ranking for drag-to-reorder within a sibling group.
  // REAL (float) for midpoint insertion. null = no explicit rank.
  await db.execute(sql`
    ALTER TABLE nodes ADD COLUMN IF NOT EXISTS priority_rank REAL
  `);
  // children_scheduling (#109) was DROPPED in v0.17.0 — the priority-
  // inheritance scheduler doesn't need a per-parent sequential/parallel
  // flag. Children are scheduled by global priority, with inheritance
  // ensuring blockers run before their dependents.
  await db.execute(sql`
    ALTER TABLE nodes DROP COLUMN IF EXISTS children_scheduling
  `);

  // ── Orchestration substrate (#111): work-queue + soft-conflict detection ──
  // claimed_by_session: session ID that has claimed this node for active work.
  //   null = unclaimed (available for dispatch). TEXT to accommodate arbitrary
  //   session-ID formats (UUID, human-readable handles, etc.).
  // claimed_at: ISO timestamp when the current claim was set. Used by the
  //   stale-claim sweeper to auto-release claims with no progress updates
  //   after N hours (default 4h, configurable per map via staleClaimHours).
  // scopes: JSONB text[] of free-form scope tags for conflict detection.
  //   Examples: 'apps/workflows', 'model:Mandate', 'migration:workflows'.
  //   Empty array = no declared scopes (no conflict-detection for this node).
  await db.execute(sql`
    ALTER TABLE nodes ADD COLUMN IF NOT EXISTS claimed_by_session TEXT
  `);
  await db.execute(sql`
    ALTER TABLE nodes ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ
  `);
  await db.execute(sql`
    ALTER TABLE nodes ADD COLUMN IF NOT EXISTS scopes JSONB NOT NULL DEFAULT '[]'
  `);
  // Partial index on claimed_by_session: the stale-claim sweeper and
  // conflict_scan only care about claimed rows; the partial index keeps
  // those scans fast and bounded without touching the large unclaimed
  // majority.
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_nodes_claimed_by_session
    ON nodes(claimed_by_session) WHERE claimed_by_session IS NOT NULL
  `);

  // ── stale_claim_hours per map (#111) ────────────────────────────
  // Each map can configure how long a claim may sit idle before the
  // sweeper auto-clears it. Default 4 hours. Stored as a REAL (fractional
  // hours allowed) on the maps table so operators can fine-tune per
  // project without a global env-var.
  await db.execute(sql`
    ALTER TABLE maps ADD COLUMN IF NOT EXISTS stale_claim_hours REAL NOT NULL DEFAULT 4
  `);

  // ── Scheduler view knob: workerCount (v0.17.1) ──────────────────
  // Per-map number of parallel work tracks. View-only projection knob —
  // the underlying priorities + estimates + deps are unchanged. Default
  // 1 = strict serial single-worker view.
  await db.execute(sql`
    ALTER TABLE maps ADD COLUMN IF NOT EXISTS worker_count REAL NOT NULL DEFAULT 1
  `);

  // ── Forecast capacity knob: focusFactor ────────────────────────
  // Per-map fraction of calendar time reaching planned-ticket work (0.05–1.0).
  // Discounts the velocity-adjusted completion forecast. Default 1 = no
  // leakage, so existing maps forecast exactly as before until it is set.
  await db.execute(sql`
    ALTER TABLE maps ADD COLUMN IF NOT EXISTS focus_factor REAL NOT NULL DEFAULT 1
  `);

  // ── One-shot data migrations ───────────────────────────────────
  // Tracks data flips that should run exactly once per database.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS data_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // (The 'flip_children_scheduling_default_v1' data migration from
  // v0.16.1 is a no-op now that the column has been dropped; the marker
  // row stays in data_migrations as historical record.)

  // ── nodes.completed_at (v0.17.6) ───────────────────────────────
  // Timestamp of when a node was marked done. Written by updateNode on
  // status→done category or percentComplete→100 transitions; cleared on
  // un-done. Used by the Gantt to position done bars at real close dates.
  await db.execute(sql`
    ALTER TABLE nodes ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ
  `);

  // One-shot backfill: for every currently-done node without a
  // completedAt, derive a best-effort timestamp from history. Priority:
  //   1. Latest change_event where field_name in ('status','percentComplete')
  //   2. Fallback: the node's updated_at
  // Items completed before the change_events table started getting
  // populated (or by bulk imports that bypass updateNode) land at
  // updated_at — imperfect but past, which is the point.
  await db.execute(sql`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM data_migrations WHERE id = 'backfill_completed_at_v1') THEN
        UPDATE nodes n
        SET completed_at = COALESCE(
          (
            SELECT MAX(ce.created_at) FROM change_events ce
            WHERE ce.node_id = n.id
              AND ce.event_type = 'node.field_changed'
              AND ce.field_name IN ('status', 'percentComplete')
          ),
          n.updated_at
        )
        WHERE n.percent_complete >= 100
          AND n.completed_at IS NULL
          AND n.deleted_at IS NULL;
        INSERT INTO data_migrations (id) VALUES ('backfill_completed_at_v1');
      END IF;
    END $$;
  `);

  // linked_pr: mirror of the GitHub PR state attached to this node's
  // linked issue (number, head/base branches, reviews, checks,
  // mergeable). Populated by PR webhook handlers so dispatch/review
  // automation can read PR state without polling the GH API.
  await db.execute(sql`
    ALTER TABLE nodes ADD COLUMN IF NOT EXISTS linked_pr JSONB
  `);

  // ── Requirements register ──────────────────────────────────────
  // requirement_id: stable business requirement ID (e.g. 'MAN-01');
  // non-null marks the node as a requirement. requirement_priority:
  // MoSCoW 'must' | 'should' | 'could'. Per-map uniqueness of
  // requirement_id is enforced application-level in db/nodes.ts.
  await db.execute(sql`
    ALTER TABLE nodes ADD COLUMN IF NOT EXISTS requirement_id TEXT
  `);
  await db.execute(sql`
    ALTER TABLE nodes ADD COLUMN IF NOT EXISTS requirement_priority TEXT
  `);
  // DB-level backstop for per-map requirement_id uniqueness. The
  // application-level precheck in db/nodes.ts gives friendly errors on
  // the sequential path, but concurrent creates (MCP pipelines tool
  // calls) can both pass the precheck — observed in verification. The
  // partial index closes that race; 23505 on this index is mapped back
  // to RequirementIdConflictError in db/nodes.ts.
  await db.execute(sql`
    ALTER TABLE nodes ADD COLUMN IF NOT EXISTS requirement_text TEXT
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS nodes_map_requirement_id_unique
      ON nodes (map_id, requirement_id)
      WHERE requirement_id IS NOT NULL AND deleted_at IS NULL
  `);

  // ── Requirement acceptances (Abnahme) ──────────────────────────
  // Append-only sign-off history per requirement node per user.
  // Active acceptance = revoked_at IS NULL; the partial unique index
  // guarantees at most one active acceptance per (node, user) even
  // under concurrent accepts.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS requirement_acceptances (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      map_id UUID NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
      node_id UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id),
      accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      progress_at_acceptance REAL NOT NULL,
      node_revision_at_acceptance INTEGER NOT NULL,
      revoked_at TIMESTAMPTZ
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS requirement_acceptances_active_unique
      ON requirement_acceptances (node_id, user_id)
      WHERE revoked_at IS NULL
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS requirement_acceptances_map_idx
      ON requirement_acceptances (map_id)
  `);

  // ── Phase column (nodes.phase_id + maps.phases) ────────────────
  // maps.phases: PhaseDef[] jsonb — {id, name, position, color?,
  // targetDate?} (statusWorkflow idiom). nodes.phase_id: nullable TEXT
  // referencing a PhaseDef.id; stable ids make phase renames free.
  // Deliberately lightweight — a phase is a label with an order, not an
  // entity (unlike the April-removed Milestones).
  await db.execute(sql`
    ALTER TABLE nodes ADD COLUMN IF NOT EXISTS phase_id TEXT
  `);
  await db.execute(sql`
    ALTER TABLE maps ADD COLUMN IF NOT EXISTS phases JSONB NOT NULL DEFAULT '[]'
  `);

  // ── Lint dismissals (plan-health panel) ────────────────────────
  // node_id NULL = rule muted map-wide. Non-FK node_id by convention
  // (see triage_decisions.placed_node_id) so node deletion leaves the
  // dismissal row inert rather than cascading.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS lint_dismissals (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      map_id UUID NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
      node_id UUID,
      rule_id TEXT NOT NULL,
      dismissed_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS lint_dismissals_map_idx ON lint_dismissals (map_id)
  `);

  console.log('[db] Migrations complete.');
}
