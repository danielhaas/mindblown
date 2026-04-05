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
      is_milestone BOOLEAN NOT NULL DEFAULT false,
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

  // ── Add password_hash and public_token columns (idempotent) ────
  await db.execute(sql`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT
  `);

  await db.execute(sql`
    ALTER TABLE maps ADD COLUMN IF NOT EXISTS public_token TEXT
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

  // Create indexes (idempotent)
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_nodes_map_id ON nodes(map_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_nodes_parent_id ON nodes(parent_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_integrations_workspace_id ON integrations(workspace_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_comments_node_id ON comments(node_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_map_permissions_map_id ON map_permissions(map_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_map_permissions_user_id ON map_permissions(user_id)`);

  console.log('[db] Migrations complete.');
}
