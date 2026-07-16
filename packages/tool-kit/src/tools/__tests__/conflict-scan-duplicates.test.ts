/**
 * conflict_scan duplicate-link detection — the tool's formatting contract
 * for the map-wide sweep and the per-candidate duplicate section.
 * (Duplicate GH links falsify rollups; 164 were removed in the 2026-07-15
 * cleanup — this is the hygiene check that keeps them from regrowing.)
 */

import { describe, it, expect } from 'vitest';
import { conflictScanTool } from '../orchestration.js';
import type { ToolBackend, ConflictScanResult } from '../../backend.js';

function backendReturning(result: ConflictScanResult): ToolBackend {
  return { conflictScan: async () => result } as unknown as ToolBackend;
}

const DUPE = {
  externalId: 'FulcrumCRM/crm#2649',
  nodes: [
    { id: 'n-done', text: '#2649 Epic: Jahressitzung', percentComplete: 100, hasChildren: true },
    { id: 'n-zero', text: '#2649 Jahressitzung (Inbox)', percentComplete: 0, hasChildren: false },
  ],
};

describe('conflict_scan — map-wide duplicate sweep (no candidate)', () => {
  it('reports duplicate groups with per-node progress', async () => {
    const out = await conflictScanTool.handler(
      backendReturning({ candidateId: null, candidateScopes: [], conflicts: [], duplicateLinks: [DUPE] }),
      { mapId: 'm1' } as never,
    );
    expect(out).toContain('Map-wide duplicate sweep: 1 GitHub link(s)');
    expect(out).toContain('FulcrumCRM/crm#2649 on 2 nodes');
    expect(out).toContain('n-done');
    expect(out).toContain('n-zero');
    // The resolution warning must mention stripping links before delete —
    // deleting a linked node closes the GitHub issue as not_planned.
    expect(out).toMatch(/unlink_github_issue BEFORE deleting/i);
  });

  it('reports a clean map tersely', async () => {
    const out = await conflictScanTool.handler(
      backendReturning({ candidateId: null, candidateScopes: [], conflicts: [], duplicateLinks: [] }),
      { mapId: 'm1' } as never,
    );
    expect(out).toContain('Clean');
  });
});

describe('conflict_scan — empty candidateNodeId means map-wide', () => {
  // Jenna passed candidateNodeId: '' on 2026-07-16 and got a 404 node
  // lookup — agents use '' for "none", the tool must treat it as omitted.
  it("treats '' as a map-wide sweep", async () => {
    let received: unknown = 'sentinel';
    const backend = {
      conflictScan: async (_m: string, c?: string) => {
        received = c;
        return { candidateId: null, candidateScopes: [], conflicts: [], duplicateLinks: [] };
      },
    } as unknown as ToolBackend;
    const out = await conflictScanTool.handler(backend, {
      mapId: 'm1',
      candidateNodeId: '',
    } as never);
    expect(received).toBeUndefined();
    expect(out).toContain('Map-wide duplicate sweep');
  });
});

describe('conflict_scan — per-candidate duplicate section', () => {
  it('appends duplicates to a no-scope candidate result', async () => {
    const out = await conflictScanTool.handler(
      backendReturning({
        candidateId: 'n-zero',
        candidateScopes: [],
        conflicts: [],
        duplicateLinks: [DUPE],
      }),
      { mapId: 'm1', candidateNodeId: 'n-zero' } as never,
    );
    expect(out).toContain('scope-conflict detection skipped');
    expect(out).toContain('duplicate GitHub link(s) involving this node');
    expect(out).toContain('FulcrumCRM/crm#2649');
  });

  it('stays silent about duplicates when there are none', async () => {
    const out = await conflictScanTool.handler(
      backendReturning({
        candidateId: 'n1',
        candidateScopes: ['apps/x'],
        conflicts: [],
        duplicateLinks: [],
      }),
      { mapId: 'm1', candidateNodeId: 'n1' } as never,
    );
    expect(out).toContain('No scope conflicts');
    expect(out).not.toContain('duplicate');
  });
});
