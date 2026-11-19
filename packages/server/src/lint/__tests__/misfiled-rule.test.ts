/**
 * The misfiled-repo rule (wrong-map guard): the engine only scopes what
 * services/misfiled.ts found — open leaves, with the move fix.
 */
import { describe, it, expect } from 'vitest';
import type { Node } from '@mindblown/core';
import { computePlanLint, LINT_FIX_ACTIONS } from '../engine.js';

const node = (id: string, over: Partial<Node> = {}): Node =>
  ({
    id,
    mapId: 'mb',
    parentId: 'root',
    childrenIds: [],
    text: id,
    description: null,
    status: null,
    percentComplete: null,
    effortEstimate: 1,
    blockedReason: null,
    tags: [],
    dependencies: [],
    externalLinks: [],
    versionId: null,
    cycleId: null,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    ...over,
  }) as Node;

const nodes = [
  node('root', { parentId: null, childrenIds: ['open', 'done', 'parent'] }),
  node('open', { text: 'fleet-worker (claude-fleet): x' }),
  node('done', { status: 'done', percentComplete: 100 }),
  node('parent', { childrenIds: ['child'] }),
  node('child', { parentId: 'parent' }),
];
const hit = { repo: 'danielhaas/claude-fleet', suggestedMapId: 'cf', suggestedMapName: 'claude-fleet' };

function misfiledRule(misfiled?: Map<string, typeof hit>) {
  const report = computePlanLint({
    map: { effortUnit: 'days', statusWorkflow: [{ id: 'done', category: 'done' }] },
    nodes,
    unitsPerDay: 1,
    history: { ok: true, lastProgressChange: new Map(), replanEvents: new Map(), anyRecentEvent: true },
    dismissals: [],
    misfiled,
    now: new Date('2026-11-19T12:00:00Z'),
  });
  if ('error' in report) throw new Error(report.error);
  return report.rules.find((r) => r.ruleId === 'misfiled-repo')!;
}

describe('computePlanLint — misfiled-repo', () => {
  it('flags open leaves only, with the move fix', () => {
    const r = misfiledRule(new Map([['open', hit], ['done', hit], ['parent', hit]]));
    expect(r.severity).toBe('warn');
    expect(r.findings.map((f) => [f.nodeId, f.detail])).toEqual([['open', 'names danielhaas/claude-fleet, which map "claude-fleet" plans']]);
    expect(r.findings[0].actions?.map((a) => a.id)).toEqual(['move-to-map']);
    expect(LINT_FIX_ACTIONS['misfiled-repo']).toEqual(['move-to-map']);
  });

  it('is skipped when the map plans no repo', () => {
    const r = misfiledRule(undefined);
    expect(r.skipped).toBe('the map plans no repo');
    expect(r.findings).toEqual([]);
  });
});
