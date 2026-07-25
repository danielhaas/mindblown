/**
 * dbMapToCore round-trip for the `profile_policy` column (#262).
 *
 * The pull queue's backward-compatibility contract hinges on this
 * mapping: a maps row WITHOUT a stored policy (the live prod state)
 * must surface as `profilePolicy: null`, which getNextTicket treats
 * as "profile-blind — ignore the profile parameter entirely". A
 * stored object must come back intact under both the snake_case
 * (raw SQL) and camelCase (drizzle) row shapes helpers.ts accepts.
 */
import { describe, it, expect } from 'vitest';
import { dbMapToCore } from '../helpers.js';

const baseRow = {
  id: 'map-1',
  workspace_id: 'ws-1',
  name: 'Test map',
  root_node_id: 'root-1',
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '2026-07-01T00:00:00Z',
  created_by: 'user-1',
};

describe('dbMapToCore — profilePolicy', () => {
  it('absent column (pre-#262 rows) maps to null', () => {
    expect(dbMapToCore(baseRow).profilePolicy).toBeNull();
  });

  it('round-trips a stored policy from snake_case and camelCase rows', () => {
    const policy = { heavyMinHours: 16, lightMaxHours: 4 };
    expect(dbMapToCore({ ...baseRow, profile_policy: policy }).profilePolicy).toEqual(policy);
    expect(dbMapToCore({ ...baseRow, profilePolicy: policy }).profilePolicy).toEqual(policy);
  });

  it('an explicitly NULL column maps to null, not undefined', () => {
    expect(dbMapToCore({ ...baseRow, profile_policy: null }).profilePolicy).toBeNull();
  });
});
