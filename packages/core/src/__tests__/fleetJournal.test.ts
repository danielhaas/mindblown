/**
 * Fleet journal — the night report, assembled from rows. Pins what the
 * hand-written 2026-09-02 report needed: ticks in order with cap writes,
 * delivered nodes carrying worker + PR + actual effort (PR from the event
 * OR from the stamped issue link when the mirror is gone), follow-ups
 * created in the window with version/priority tallies, and events outside
 * the window feeding the trail but not the lists.
 */
import { describe, it, expect } from 'vitest';
import { buildFleetJournal, journalWindow, splitSession } from '../fleetJournal.js';
import type { JournalInput } from '../fleetJournal.js';

const FROM = new Date('2026-09-02T15:00:00Z'); // 17:00 CEST
const TO = new Date('2026-09-03T05:00:00Z'); // 07:00 CEST
const at = (h: number, m = 0) => new Date(Date.UTC(2026, 8, 2, h, m)).toISOString();

const link = (id: string, extra: Record<string, unknown> = {}) => ({
  provider: 'github' as const,
  externalId: id,
  url: `https://github.com/${id.replace('#', '/issues/')}`,
  syncEnabled: true,
  lastSyncedAt: null,
  ...extra,
});

function node(id: string, text: string, extra: Partial<JournalInput['nodes'][number]> = {}): JournalInput['nodes'][number] {
  return {
    id,
    text,
    status: 'todo',
    completedAt: null,
    createdAt: at(10),
    createdBy: 'u1',
    actualEffort: null,
    effortEstimate: null,
    priority: null,
    versionId: null,
    tags: [],
    externalLinks: [],
    blockedReason: null,
    claimedBySession: null,
    ...extra,
  };
}

const base: JournalInput = {
  window: { from: FROM, to: TO },
  ticks: [
    { tickAt: at(16, 9), receivedAt: at(16, 9), payload: { summary: { claims: 9, cap: 9, pullableInGate: 169, needsBrief: 30 }, cap: { set: 12, reason: 'CI green' }, anomalies: [{ severity: 'info', what: 'x' }, { severity: 'warn', what: 'nightly red' }] } },
    { tickAt: at(15, 39), receivedAt: at(15, 39), payload: { summary: { claims: 4, cap: 9, pullableInGate: 169, needsBrief: 30 } } },
    { tickAt: at(9), receivedAt: at(9), payload: { summary: { claims: 0, cap: 0 } } }, // before the window
  ],
  events: [
    { eventType: 'node.claimed', nodeId: 'n1', userId: null, fieldName: null, oldValue: null, newValue: { session: 'njoerd:worker-3:default', via: 'pull' }, createdAt: at(15, 30) },
    { eventType: 'node.released', nodeId: 'n1', userId: null, fieldName: null, oldValue: null, newValue: { session: 'njoerd:worker-3:default', reason: 'done', heldMinutes: 42 }, createdAt: at(16, 12) },
    { eventType: 'node.pr_merged', nodeId: 'n1', userId: null, fieldName: null, oldValue: null, newValue: { prNumber: 10256, repo: 'FulcrumCRM/crm', url: 'https://github.com/FulcrumCRM/crm/pull/10256' }, createdAt: at(16, 13) },
    // n2: claimed BEFORE the window, delivered inside — the trail still names the worker
    { eventType: 'node.claimed', nodeId: 'n2', userId: null, fieldName: null, oldValue: null, newValue: { session: 'sat2:worker-1:default', via: 'claim' }, createdAt: at(12) },
    { eventType: 'node.claimed', nodeId: 'n3', userId: null, fieldName: null, oldValue: null, newValue: { session: 'sat3:worker-2:default', via: 'pull' }, createdAt: at(17) },
    { eventType: 'node.released', nodeId: 'n3', userId: null, fieldName: null, oldValue: null, newValue: { session: 'sat3:worker-2:default', reason: 'release', note: 'never started', heldMinutes: 5 }, createdAt: at(17, 5) },
    { eventType: 'node.field_changed', nodeId: 'n4', userId: null, fieldName: 'status', oldValue: 'in_progress', newValue: 'blocked', createdAt: at(18) },
    { eventType: 'map.field_changed', nodeId: null, userId: 'u1', fieldName: 'maxActiveClaims', oldValue: 9, newValue: 12, createdAt: at(16, 10) },
    { eventType: 'map.field_changed', nodeId: null, userId: 'u1', fieldName: 'maxActiveClaims', oldValue: 0, newValue: 9, createdAt: at(8) }, // before the window
  ],
  nodes: [
    node('n1', '#10161 wB-Schwellen-Helper', { status: 'done', completedAt: at(16, 12), actualEffort: 0.1, externalLinks: [link('FulcrumCRM/crm#10161')] }),
    node('n2', '#9163 Formular V', { status: 'done', completedAt: at(16, 57), actualEffort: 0.19, versionId: 'v1', externalLinks: [link('FulcrumCRM/crm#9163', { mergedPrNumber: 10262, mergeCommitSha: 'abc' })] }),
    node('n3', '#9633 provenance', {}),
    node('n4', '#6386 payment reconciliation', { status: 'blocked', blockedReason: 'needs Dan' }),
    node('n5', '#10264 follow-up A', { createdAt: at(16, 20), priority: 'P2', versionId: 'v15', effortEstimate: 0.5, externalLinks: [link('FulcrumCRM/crm#10264')] }),
    node('n6', '#10266 follow-up B', { createdAt: at(20), priority: 'P1', versionId: 'v15' }),
    node('n7', 'old done', { status: 'done', completedAt: at(9) }), // before the window
  ],
  versions: [
    { id: 'v1', name: 'V1' },
    { id: 'v15', name: 'V1.5 follow-up' },
  ],
  users: [{ id: 'u1', name: 'Dan' }],
};

describe('buildFleetJournal', () => {
  const j = buildFleetJournal(base);

  it('lists the ticks inside the window, oldest first, with cap writes and warn+ anomalies', () => {
    expect(j.ticks.map((t) => t.claims)).toEqual([4, 9]);
    expect(j.ticks[1].capWrite).toEqual({ set: 12, reason: 'CI green' });
    expect(j.ticks[1].anomalies).toEqual([{ severity: 'warn', what: 'nightly red' }]);
    expect(j.totals).toMatchObject({ ticks: 2, capMin: 9, capMax: 9, claimsMax: 9, anomaliesWarn: 1 });
  });

  it('delivered = completedAt in window, with worker, PR (event or stamped link) and actual effort', () => {
    expect(j.delivered.map((d) => d.nodeId)).toEqual(['n1', 'n2']);
    const [n1, n2] = j.delivered;
    expect(n1.deliveredBy).toEqual({ session: 'njoerd:worker-3:default', host: 'njoerd', worker: 'worker-3' });
    expect(n1.pr).toMatchObject({ number: 10256, repo: 'FulcrumCRM/crm', mergedAt: at(16, 13) });
    expect(n1.issues).toEqual([{ externalId: 'FulcrumCRM/crm#10161', url: 'https://github.com/FulcrumCRM/crm/issues/10161' }]);
    // Claimed before the window, mirror cleared on merge: still attributed, PR from the stamped link.
    expect(n2.deliveredBy?.worker).toBe('worker-1');
    expect(n2.pr).toEqual({ number: 10262, url: 'https://github.com/FulcrumCRM/crm/pull/10262', repo: 'FulcrumCRM/crm', mergedAt: null });
    expect(n2.versionName).toBe('V1');
    expect(j.totals).toMatchObject({ delivered: 2, prsMerged: 2, actualEffortSum: 0.29, workers: 3 });
  });

  it('claims and non-done releases inside the window only; done releases feed the trail, not the list', () => {
    expect(j.claims.map((c) => [c.nodeId, c.via, c.worker])).toEqual([
      ['n1', 'pull', 'worker-3'],
      ['n3', 'pull', 'worker-2'],
    ]);
    expect(j.releases).toHaveLength(1);
    expect(j.releases[0]).toMatchObject({ nodeId: 'n3', reason: 'release', note: 'never started', heldMinutes: 5, host: 'sat3' });
  });

  it('follow-ups created in the window with version/priority tallies; blocked and knob writes with names', () => {
    expect(j.created.map((c) => c.nodeId)).toEqual(['n5', 'n6']);
    expect(j.totals.createdByVersion).toEqual({ 'V1.5 follow-up': 2 });
    expect(j.totals.createdByPriority).toEqual({ P2: 1, P1: 1 });
    expect(j.created[0].createdBy).toBe('Dan');
    expect(j.blocked).toEqual([{ nodeId: 'n4', text: '#6386 payment reconciliation', at: at(18), reason: 'needs Dan' }]);
    expect(j.knobWrites).toEqual([{ at: at(16, 10), field: 'maxActiveClaims', oldValue: 9, newValue: 12, userId: 'u1', userName: 'Dan' }]);
  });

  it('is empty, not broken, on an empty window', () => {
    const e = buildFleetJournal({ ...base, ticks: [], events: [], nodes: [] });
    expect(e.totals).toMatchObject({ ticks: 0, delivered: 0, created: 0, capMin: null, claimsMax: null, actualEffortSum: 0, workers: 0 });
  });
});

describe('journalWindow', () => {
  it('last night = yesterday 17:00 → today 07:00 local, or → now before 07:00', () => {
    const morning = new Date(2026, 8, 3, 9, 30);
    const w = journalWindow('last-night', morning);
    expect([w.from.getDate(), w.from.getHours(), w.to.getDate(), w.to.getHours()]).toEqual([2, 17, 3, 7]);
    const early = new Date(2026, 8, 3, 3, 40);
    const w2 = journalWindow('last-night', early);
    expect(w2.to.getTime()).toBe(early.getTime());
    expect([w2.from.getDate(), w2.from.getHours()]).toEqual([2, 17]);
  });

  it('24h / 7d are trailing windows', () => {
    const now = new Date('2026-09-03T05:00:00Z');
    expect(journalWindow('24h', now).from.toISOString()).toBe('2026-09-02T05:00:00.000Z');
    expect(journalWindow('7d', now).from.toISOString()).toBe('2026-08-27T05:00:00.000Z');
  });
});

describe('splitSession', () => {
  it('reads host and worker from the fleet session string, tolerates other shapes', () => {
    expect(splitSession('njoerd:worker-3:default')).toEqual({ session: 'njoerd:worker-3:default', host: 'njoerd', worker: 'worker-3' });
    expect(splitSession('jenna-pm')).toEqual({ session: 'jenna-pm', host: null, worker: null });
  });
});
