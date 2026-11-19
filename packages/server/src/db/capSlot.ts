import { sql } from 'drizzle-orm';
import { nodes } from './schema.js';

/**
 * SQL twin of core `holdsCapSlot` — what the map and fleet caps count: a
 * claim, unless it carries the worker's own PR wait note (core
 * WORKER_WAIT_NOTE) and no fix was asked for. Built per query, not at
 * import, so tests that mock the schema without `nodes` still load.
 */
export const holdsCapSlotSql = () => sql`(${nodes.claimedBySession} IS NOT NULL AND NOT (
  coalesce(btrim(${nodes.blockedReason}), '') ~ '^Fleet worker [^ ]+: '
  AND NOT ${nodes.tags} @> '["fleet-fix"]'::jsonb
  AND NOT ${nodes.tags} @> '["fleet-check"]'::jsonb
))`;
