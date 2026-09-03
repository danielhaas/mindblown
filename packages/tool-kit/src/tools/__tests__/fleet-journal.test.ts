/**
 * fleet_journal tool — renders the night report from the journal and
 * resolves the presets into an explicit window for the backend.
 */
import { describe, it, expect, vi } from 'vitest';
import { fleetJournalTool, renderFleetJournal } from '../fleetJournal.js';
import type { ToolBackend, FleetJournalResult } from '../../backend.js';
import type { FleetJournal } from '@mindblown/core';

const journal: FleetJournal = {
  window: { from: '2026-09-02T15:00:00.000Z', to: '2026-09-03T05:00:00.000Z' },
  ticks: [
    { at: '2026-09-02T15:39:00Z', receivedAt: '2026-09-02T15:39:00Z', claims: 4, cap: 9, pullableInGate: 169, needsBrief: 30, heartbeat: null, noJudgment: null, capWrite: null, policyWrite: null, gateRecommendation: null, anomalies: [], asksCount: 0, assessment: null },
    { at: '2026-09-02T16:09:00Z', receivedAt: '2026-09-02T16:09:00Z', claims: 9, cap: 9, pullableInGate: 169, needsBrief: 30, heartbeat: null, noJudgment: null, capWrite: { set: 12, reason: 'CI green' }, policyWrite: null, gateRecommendation: null, anomalies: [{ severity: 'warn', what: 'nightly red' }], asksCount: 1, assessment: null },
  ],
  claims: [{ nodeId: 'n3', text: '#9633 provenance', session: 'sat3:worker-2:default', host: 'sat3', worker: 'worker-2', via: 'pull', at: '2026-09-02T17:00:00Z' }],
  releases: [{ nodeId: 'n3', text: '#9633 provenance', session: 'sat3:worker-2:default', host: 'sat3', worker: 'worker-2', reason: 'release', note: 'never started', heldMinutes: 5, at: '2026-09-02T17:05:00Z' }],
  delivered: [
    {
      nodeId: 'n1',
      text: '#10161 wB-Schwellen-Helper',
      completedAt: '2026-09-02T16:12:00Z',
      actualEffort: 0.1,
      effortEstimate: 0.5,
      deliveredBy: { session: 'njoerd:worker-3:default', host: 'njoerd', worker: 'worker-3' },
      pr: { number: 10256, url: 'https://github.com/FulcrumCRM/crm/pull/10256', repo: 'FulcrumCRM/crm', mergedAt: '2026-09-02T16:13:00Z' },
      issues: [{ externalId: 'FulcrumCRM/crm#10161', url: 'https://github.com/FulcrumCRM/crm/issues/10161' }],
      versionName: 'V1',
    },
  ],
  created: [{ nodeId: 'n5', text: '#10264 follow-up A', createdAt: '2026-09-02T16:20:00Z', createdBy: 'Dan', priority: 'P2', versionName: 'V1.5 follow-up', effortEstimate: 0.5, tags: [], issues: [] }],
  blocked: [{ nodeId: 'n4', text: '#6386 payment reconciliation', at: '2026-09-02T18:00:00Z', reason: 'needs Dan' }],
  knobWrites: [{ at: '2026-09-02T16:10:00Z', field: 'maxActiveClaims', oldValue: 9, newValue: 12, userId: 'u1', userName: 'Dan' }],
  totals: { ticks: 2, claims: 1, releases: 1, delivered: 1, created: 1, blocked: 1, knobWrites: 1, anomaliesWarn: 1, capMin: 9, capMax: 9, claimsMax: 9, actualEffortSum: 0.1, prsMerged: 1, createdByVersion: { 'V1.5 follow-up': 1 }, createdByPriority: { P2: 1 }, workers: 2 },
};

describe('renderFleetJournal', () => {
  it('renders the report sections a PM reads: ticks with cap writes, delivered with worker/PR/effort, closed issues, follow-ups, knob writes', () => {
    const out = renderFleetJournal(journal);
    expect(out).toContain('2 ticks · cap 9 · claims max 9 · 1 delivered (1 with PR, actual 0.1)');
    expect(out).toContain('16:09  claims 9/9 · in-gate 169 · needs-brief 30 · CAP → 12 (CI green) · [warn] nightly red · 1 ask');
    expect(out).toContain('PR #10256: #10161 wB-Schwellen-Helper — by worker-3@njoerd · actual 0.1 · V1 — FulcrumCRM/crm#10161');
    expect(out).toContain('## Issues closed (1)');
    expect(out).toContain('worker-2@sat3 handed back #9633 provenance — release after 5 min: never started');
    expect(out).toContain('#6386 payment reconciliation — needs Dan');
    expect(out).toContain('by version: V1.5 follow-up: 1');
    expect(out).toContain('maxActiveClaims: 9 → 12 — Dan');
  });

  it('says so on an empty window', () => {
    const empty: FleetJournal = { ...journal, ticks: [], delivered: [], claims: [], releases: [], blocked: [], created: [], knobWrites: [], totals: { ...journal.totals, ticks: 0, delivered: 0, created: 0 } };
    const out = renderFleetJournal(empty);
    expect(out).toContain('no orchestrator tick in the window');
    expect(out).toContain('nothing moved to done in the window');
    expect(out).not.toContain('## Knob writes');
  });
});

describe('fleet_journal tool', () => {
  it('passes explicit from/to through and resolves a preset into a window', async () => {
    const getFleetJournal = vi.fn(async (): Promise<FleetJournalResult> => ({ journal, now: '2026-09-03T05:00:00Z' }));
    const backend = { getFleetJournal } as unknown as ToolBackend;

    await fleetJournalTool.handler(backend, { mapId: 'm1', from: '2026-09-02T15:00:00Z', to: '2026-09-03T05:00:00Z' } as never);
    expect(getFleetJournal).toHaveBeenLastCalledWith('m1', { from: '2026-09-02T15:00:00Z', to: '2026-09-03T05:00:00Z' });

    const out = await fleetJournalTool.handler(backend, { mapId: 'm1', preset: '7d' } as never);
    const [, opts] = getFleetJournal.mock.calls[1] as unknown as [string, { from: string; to: string }];
    expect(Date.parse(opts.to) - Date.parse(opts.from)).toBe(7 * 86_400_000);
    expect(out).toContain('Fleet journal');
  });
});
