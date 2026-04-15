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

  console.log('[db] Migrations complete.');
}
