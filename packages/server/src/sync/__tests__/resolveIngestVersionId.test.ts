/**
 * Unit coverage for the release-lane resolution used when ingest (and
 * the operator triage-place paths) create a new MindBlown node.
 *
 * Contract (callers skip the whole call for CLOSED issues):
 *   1. the triage LLM's suggestion, when it names an eligible
 *      (planning/active) lane on this map,
 *   2. a GH milestone whose V-prefix matches an eligible lane by name
 *      (bulk-import-bootstrapped maps have planning-only lanes created
 *      FROM milestone prefixes — for them this is the only signal),
 *   3. the active lane with the highest sortOrder (id tie-break),
 *   4. null.
 * Released AND archived lanes are never candidates.
 *
 * Tested against a tiny fake drizzle handle (same pattern as the other
 * sync unit tests): the fake select returns ALL configured rows — the
 * SUT filters status in JS, and mapId scoping lives in the (untested
 * here) SQL predicate.
 */

import { describe, it, expect } from 'vitest';
import { resolveIngestVersionId } from '../githubIngest.js';
import type { DbHandle } from '../../db/nodes.js';

interface VersionRow {
  id: string;
  name: string;
  status: string;
  sortOrder: number;
}

function fakeHandle(rows: VersionRow[]): DbHandle {
  const select = (_cols?: unknown) => ({
    from(_table: unknown) {
      return {
        where(_pred: unknown) {
          return Promise.resolve(rows);
        },
      };
    },
  });
  return { select } as unknown as DbHandle;
}

const LANES: VersionRow[] = [
  { id: 'v-mvp', name: 'MVP', status: 'active', sortOrder: 0 },
  { id: 'v1', name: 'V1', status: 'active', sortOrder: 10 },
  { id: 'v15', name: 'V1.5', status: 'active', sortOrder: 15 },
  { id: 'v2', name: 'V2', status: 'planning', sortOrder: 20 },
  { id: 'v-arch', name: 'V0', status: 'archived', sortOrder: -10 },
];

describe('resolveIngestVersionId', () => {
  it('returns the suggested version when it is an eligible lane', async () => {
    const got = await resolveIngestVersionId(fakeHandle(LANES), 'map-1', {
      suggestedVersionId: 'v2',
    });
    expect(got).toBe('v2');
  });

  it('rejects an archived suggestion and falls through', async () => {
    const got = await resolveIngestVersionId(fakeHandle(LANES), 'map-1', {
      suggestedVersionId: 'v-arch',
    });
    expect(got).toBe('v15');
  });

  it('falls back to the active lane when the suggestion is unknown', async () => {
    const got = await resolveIngestVersionId(fakeHandle(LANES), 'map-1', {
      suggestedVersionId: 'v-hallucinated',
    });
    expect(got).toBe('v15');
  });

  it('routes a V-prefixed milestone into the matching lane by name', async () => {
    const got = await resolveIngestVersionId(fakeHandle(LANES), 'map-1', {
      milestoneTitle: 'V2: 7. Infrastruktur',
    });
    expect(got).toBe('v2');
  });

  it('suggestion wins over the milestone', async () => {
    const got = await resolveIngestVersionId(fakeHandle(LANES), 'map-1', {
      suggestedVersionId: 'v1',
      milestoneTitle: 'V2: 7. Infrastruktur',
    });
    expect(got).toBe('v1');
  });

  it('ignores a milestone without a matching lane and defaults to the active lane', async () => {
    const got = await resolveIngestVersionId(fakeHandle(LANES), 'map-1', {
      milestoneTitle: 'V9: from the future',
    });
    expect(got).toBe('v15');
  });

  it('picks the active version with the highest sortOrder', async () => {
    const got = await resolveIngestVersionId(fakeHandle(LANES), 'map-1');
    expect(got).toBe('v15');
  });

  it('breaks sortOrder ties deterministically by id', async () => {
    const tied: VersionRow[] = [
      { id: 'b-lane', name: 'B', status: 'active', sortOrder: 0 },
      { id: 'a-lane', name: 'A', status: 'active', sortOrder: 0 },
    ];
    expect(await resolveIngestVersionId(fakeHandle(tied), 'map-1')).toBe('a-lane');
    expect(
      await resolveIngestVersionId(fakeHandle([...tied].reverse()), 'map-1'),
    ).toBe('a-lane');
  });

  it('never defaults into an archived lane', async () => {
    const got = await resolveIngestVersionId(
      fakeHandle([{ id: 'v-arch', name: 'V0', status: 'archived', sortOrder: 10 }]),
      'map-1',
    );
    expect(got).toBeNull();
  });

  it('ignores planning-only maps and returns null without a signal', async () => {
    const got = await resolveIngestVersionId(
      fakeHandle([{ id: 'v2', name: 'V2', status: 'planning', sortOrder: 20 }]),
      'map-1',
    );
    expect(got).toBeNull();
  });

  it('returns null when the map has no versions at all', async () => {
    expect(await resolveIngestVersionId(fakeHandle([]), 'map-1')).toBeNull();
  });
});
