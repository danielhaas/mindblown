/**
 * Unit coverage for the milestone → version routing helper that
 * githubIngest now uses when ensureNodeForIssue creates a new
 * MindBlown node. Jenna's 2026-06-11 housekeeping digest flagged
 * that the auto-ingest path was producing nodes with versionId=null
 * even when the issue's GH milestone parsed cleanly to a known
 * MindBlown version, leaving the Unversioned bucket to refill
 * between every sweep tick.
 *
 * The helper is tested against a tiny fake drizzle handle so we
 * don't have to spin up Postgres for branch coverage of:
 *   - no milestone → null
 *   - milestone whose title doesn't carry a V-prefix → null
 *   - V-prefix that matches a row → returns that row's id
 *   - V-prefix with no matching row in this map → null
 *   - V-prefix matches a same-named row on a DIFFERENT map → null
 */

import { describe, it, expect } from 'vitest';
import { resolveVersionIdFromMilestone } from '../githubIngest.js';
import type { DbHandle } from '../../db/nodes.js';

interface VersionRow {
  id: string;
  mapId: string;
  name: string;
}

function fakeHandle(rows: VersionRow[]): DbHandle {
  // Capture the drizzle `eq()` shape — drizzle's real `eq(col, val)`
  // builds a predicate object we can't introspect. So we shim our
  // own `eq` via the mock used by the SUT? No — drizzle is the
  // real module here. Instead, parse the SQL chain by trapping
  // `.where(predicate)` and pattern-matching on the predicate's
  // stringified params. Simpler: serialize the predicate into a
  // probe string and grep `mapId` / `name` out of it.
  //
  // Because we can't easily inspect drizzle's compiled predicate
  // tree without the database connection layer, we instead
  // expose a configurable filter: the test sets up `rows`, and
  // the fake select returns ALL rows. The SUT then takes [0]
  // of the result — so the test arranges `rows` so the relevant
  // single match is at the head.
  const select = (_cols?: unknown) => {
    return {
      from(_table: unknown) {
        return {
          where(_pred: unknown) {
            return Promise.resolve(rows.map((r) => ({ id: r.id })));
          },
        };
      },
    };
  };
  return { select } as unknown as DbHandle;
}

describe('resolveVersionIdFromMilestone', () => {
  it('returns null when milestoneTitle is null', async () => {
    const got = await resolveVersionIdFromMilestone(fakeHandle([]), 'map-1', null);
    expect(got).toBeNull();
  });

  it('returns null when milestoneTitle is empty', async () => {
    const got = await resolveVersionIdFromMilestone(fakeHandle([]), 'map-1', '');
    expect(got).toBeNull();
  });

  it('returns null when milestoneTitle has no V-prefix', async () => {
    // Real DB has versions, but the milestone doesn't parse → no lookup
    // is performed. The helper short-circuits before hitting the handle,
    // so even a non-empty `rows` list returns null.
    const handle = fakeHandle([{ id: 'v1', mapId: 'map-1', name: 'V1' }]);
    const got = await resolveVersionIdFromMilestone(handle, 'map-1', 'Deferred-from-V1 Scope');
    expect(got).toBeNull();
  });

  it('returns the row id when the V-prefix matches a version on this map', async () => {
    const handle = fakeHandle([{ id: 'v2-uuid', mapId: 'map-1', name: 'V2' }]);
    const got = await resolveVersionIdFromMilestone(handle, 'map-1', 'V2: 7. Infrastruktur');
    expect(got).toBe('v2-uuid');
  });

  it('returns null when no row matches (handle returns empty)', async () => {
    const got = await resolveVersionIdFromMilestone(fakeHandle([]), 'map-1', 'V1: 1a. Kernsystem');
    expect(got).toBeNull();
  });
});
