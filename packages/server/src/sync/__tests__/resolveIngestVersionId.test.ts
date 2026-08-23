/**
 * Unit coverage for the release-lane resolution used when ingest (and
 * the operator triage-place paths) create a new MindBlown node.
 *
 * Replaced the milestone → version routing helper: on the bound prod
 * repo 0 of 1200 sampled issues carried a GitHub milestone, so that
 * path never fired and every ingested node landed unversioned —
 * invisible to the dispatch queue. The new contract:
 *
 *   - triage LLM suggestion wins when it names a version that exists
 *     (and is not released) on this map
 *   - otherwise: the active version with the highest sortOrder
 *   - no active version → null (node lands unversioned)
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

describe('resolveIngestVersionId', () => {
  it('returns the suggested version when it exists on the map', async () => {
    const got = await resolveIngestVersionId(
      fakeHandle([
        { id: 'v-active', status: 'active', sortOrder: 10 },
        { id: 'v-planning', status: 'planning', sortOrder: 20 },
      ]),
      'map-1',
      'v-planning',
    );
    expect(got).toBe('v-planning');
  });

  it('falls back to the active lane when the suggestion is unknown', async () => {
    const got = await resolveIngestVersionId(
      fakeHandle([{ id: 'v-active', status: 'active', sortOrder: 10 }]),
      'map-1',
      'v-hallucinated',
    );
    expect(got).toBe('v-active');
  });

  it('picks the active version with the highest sortOrder', async () => {
    const got = await resolveIngestVersionId(
      fakeHandle([
        { id: 'v-mvp', status: 'active', sortOrder: 0 },
        { id: 'v1', status: 'active', sortOrder: 10 },
        { id: 'v15', status: 'active', sortOrder: 15 },
        { id: 'v2', status: 'planning', sortOrder: 20 },
      ]),
      'map-1',
    );
    expect(got).toBe('v15');
  });

  it('ignores planning-only maps and returns null without a suggestion', async () => {
    const got = await resolveIngestVersionId(
      fakeHandle([{ id: 'v2', status: 'planning', sortOrder: 20 }]),
      'map-1',
    );
    expect(got).toBeNull();
  });

  it('returns null when the map has no versions at all', async () => {
    const got = await resolveIngestVersionId(fakeHandle([]), 'map-1');
    expect(got).toBeNull();
  });
});
