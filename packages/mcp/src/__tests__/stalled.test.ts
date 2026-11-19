import { describe, it, expect } from 'vitest';
import type { StalledLeaf } from '@mindblown/core';
import { stalledSectionLines, wipClaimMarker, wipPhaseTexts } from '../stalled.js';

const now = new Date('2026-10-18T12:00:00Z');
const dead: StalledLeaf = {
  nodeId: 'n1',
  percentComplete: 25,
  lastChangeAt: '2026-10-18T03:00:00Z',
  lastRelease: { session: 'host-a/worker-3', releasedAt: '2026-10-18T03:00:00Z', reason: 'release' },
};

describe('blocked_digest stalled section', () => {
  it('lists each stalled leaf with progress, idle time and the last claim holder', () => {
    const lines = stalledSectionLines([dead], () => 'Fix the importer', now);
    expect(lines[0]).toBe('## Stalled — in progress, nobody working on it (1)');
    expect(lines[1]).toBe(
      '- ⏸ **Fix the importer** — 25 %, no change for 9 h, released by host-a/worker-3 9 h ago (release) (id: n1)',
    );
  });

  it('is empty when nothing is stalled', () => {
    expect(stalledSectionLines([], () => '', now)).toEqual([]);
  });
});

describe('get_wip_status claim marker', () => {
  const stalledById = new Map([['n1', dead]]);
  it('names the holder, or says unclaimed — and stalled when it is', () => {
    expect(wipClaimMarker({ id: 'n2', claimedBySession: 'host-a/worker-1' }, stalledById, now)).toBe(' (claimed by host-a/worker-1)');
    expect(wipClaimMarker({ id: 'n3', claimedBySession: null }, stalledById, now)).toBe(' (unclaimed)');
    expect(wipClaimMarker({ id: 'n1', claimedBySession: null }, stalledById, now)).toBe(' (unclaimed, stalled — no change for 9 h)');
  });
});

describe('fleet phase in get_wip_status (#546)', () => {
  it('a claimed ticket names its phase; a stale host names none', () => {
    const fresh = '2026-10-18T11:58:00Z';
    const phases = wipPhaseTexts([
      { generatedAt: fresh, receivedAt: fresh, rollup: { v: 2, host: 'big', generated_at: fresh, workers: [], claims: [{ nodeId: 'n2', phase: 'pr', ci: 'pending', pr_number: 41, phase_since: '2026-10-18T11:48:00Z' }] } },
      { generatedAt: '2026-10-18T10:00:00Z', receivedAt: '2026-10-18T10:00:00Z', rollup: { v: 2, host: 'old', generated_at: '2026-10-18T10:00:00Z', workers: [], claims: [{ nodeId: 'n4', phase: 'working' }] } },
    ], now);
    expect(phases.get('n2')).toBe('Waiting for CI · 12m, PR #41');
    expect(phases.has('n4')).toBe(false);
    expect(wipClaimMarker({ id: 'n2', claimedBySession: 'big:slot1:fleet-worker' }, new Map(), now, phases.get('n2')))
      .toBe(' (claimed by big:slot1:fleet-worker — Waiting for CI · 12m, PR #41)');
  });
});
