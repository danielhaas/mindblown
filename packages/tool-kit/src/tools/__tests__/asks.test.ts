/**
 * Asks tools — the MCP surface of /leidang-asks. Round-trips the args to
 * the backend and pins the rendering an agent reads: grouped by answerer,
 * the "keine Frage" fold, the write report after an answer, the digest.
 */
import { describe, it, expect } from 'vitest';
import { listAsksTool, answerAskTool, asksDigestTool, fleetCheckBlockersTool } from '../asks.js';
import type { ToolBackend, AskListResult, AskAnswerResult } from '../../backend.js';
import type { Ask, AskRow } from '@mindblown/core';

function ask(over: Partial<Ask> = {}): Ask {
  return {
    id: '#6823', ticket: 6823, requirement: null, title: '#6823 Avione Migrationsskript', url: 'https://github.com/x/y/issues/6823',
    sources: ['tick:decision'], question: 'skip / keep?', question_author: 'worker', options: ['skip', 'keep'],
    answerer: 'Dan', hint: 'decision', priority: 'P1', milestone: null, needs_version: false, idle_hours: 30,
    unblocks: { node_id: 'n1n1n1n1-0000', node_title: 'Avione', node_status: 'blocked', claimed_by: null, worker: null, pr: null, pr_state: null },
    moot: false, ...over,
  };
}
function row(a: Ask, over: Partial<AskRow> = {}): AskRow {
  return { ask: a, status: 'open', pushedAt: '2026-09-03T10:00:00Z', firstSeenAt: '2026-09-03T10:00:00Z', answer: null, answeredBy: null, answeredAt: null, writes: [], workerPending: false, ...over };
}
function listResult(items: AskRow[]): AskListResult {
  return { items, counts: { total: items.length, byAnswerer: {}, byHint: {}, byStatus: {} }, pushedAt: '2026-09-03T10:00:00Z', meta: { tick: '20260903T1000Z' }, now: '2026-09-03T10:05:00Z' };
}

describe('list_asks', () => {
  it('says so when nothing was pushed', async () => {
    const backend = { listAsks: async () => ({ ...listResult([]), pushedAt: null, meta: null }) } as unknown as ToolBackend;
    const out = await listAsksTool.handler(backend, { mapId: 'm1' } as never);
    expect(out).toContain('No asks pushed yet');
  });

  it('forwards the filters and renders grouped by answerer with the folds', async () => {
    const calls: unknown[][] = [];
    const items = [
      row(ask()),
      row(ask({ id: '#7', ticket: 7, answerer: 'Rita', title: '#7 Ruling', options: [] })),
      row(ask({ id: '#8', ticket: 8, hint: 'parked-plan', title: '#8 Wochenplan' })),
      row(ask({ id: '#9', ticket: 9, sources: ['github:needs-version'], title: '#9 Version?' })),
    ];
    const backend = { listAsks: async (...a: unknown[]) => { calls.push(a); return listResult(items); } } as unknown as ToolBackend;
    const out = await listAsksTool.handler(backend, { mapId: 'm1', answerer: 'Dan', status: 'all' } as never);
    expect(calls).toEqual([['m1', { status: 'all', hint: undefined, answerer: 'Dan', limit: undefined }]]);
    expect(out).toContain('Asks: 4');
    expect(out.indexOf('## Dan')).toBeLessThan(out.indexOf('## Rita'));
    expect(out).toContain('#6823 Avione Migrationsskript · P1 · idle 30h · [decision]');
    expect(out).toContain('Optionen: skip | keep');
    expect(out).toContain('entblockt: node n1n1n1n1 (blocked)');
    expect(out).toContain('## Keine Frage');
    expect(out).toContain('#8 · #8 [parked-plan] Wochenplan');
    expect(out).toContain('## Nur Version fehlt');
    expect(out).toContain('#9 · #9 Version?');
  });
});

describe('answer_ask', () => {
  it('forwards the answer and reports every write', async () => {
    const calls: unknown[][] = [];
    const result: AskAnswerResult = {
      ask: row(ask(), {
        status: 'answered', answeredBy: 'Dan',
        writes: [
          { kind: 'gh-comment', target: '#6823', detail: 'Entscheid (Dan, 2026-09-03): skip', done: true },
          { kind: 'mb-put', target: 'n1n1n1n1', detail: 'status → todo', done: false, error: 'boom' },
        ],
      }),
      plan: { github: null, node: null, worker: null, skip: null },
      ok: false,
      node: null,
    };
    const backend = { answerAsk: async (...a: unknown[]) => { calls.push(a); return result; } } as unknown as ToolBackend;
    const out = await answerAskTool.handler(backend, { mapId: 'm1', askId: '#6823', action: 'answered', decision: 'skip' } as never);
    expect(calls).toEqual([['m1', '#6823', { action: 'answered', decision: 'skip', by: undefined, milestone: undefined, noRequeue: undefined, delegateTo: undefined }]]);
    expect(out).toContain('#6823: answered by Dan — SOME WRITES FAILED');
    expect(out).toContain('wrote: gh-comment #6823');
    expect(out).toContain('FAILED: mb-put n1n1n1n1 — status → todo (boom)');
  });

  it('with fleetId answers through the fleet, passing askMapId (#479)', async () => {
    const calls: unknown[][] = [];
    const result: AskAnswerResult = { ask: row(ask(), { status: 'later' }), plan: { github: null, node: null, worker: null, skip: null }, ok: true, node: null };
    const backend = { answerAskForFleet: async (...a: unknown[]) => { calls.push(a); return result; } } as unknown as ToolBackend;
    await answerAskTool.handler(backend, { fleetId: 'f1', askMapId: 'm2', askId: '#6823', action: 'later' } as never);
    expect(calls[0][0]).toBe('f1');
    expect(calls[0][1]).toBe('#6823');
    expect(calls[0][3]).toBe('m2');
    await expect(answerAskTool.handler(backend, { askId: '#6823', action: 'later' } as never)).rejects.toThrow(/exactly one/);
  });
});

describe('list_asks across a fleet (#479)', () => {
  it('prefixes every row with its map, [fleet] for a fleet-level ask', async () => {
    const res: AskListResult = {
      ...listResult([row(ask({ id: '#1' }), { mapId: 'm1' }), row(ask({ id: 'fleet:hosts', ticket: null, title: 'More hosts' }), { mapId: null })]),
      maps: [{ id: 'm1', name: 'Alpha' }],
    };
    const backend = { listAsksForFleet: async () => res } as unknown as ToolBackend;
    const out = await listAsksTool.handler(backend, { fleetId: 'f1' } as never);
    expect(out).toContain('- [Alpha] #1 · #6823');
    expect(out).toContain('- [fleet] fleet:hosts');
  });
});

describe('asks_digest', () => {
  it('reads all statuses since the timestamp and sums them', async () => {
    const calls: unknown[][] = [];
    const items = [
      row(ask(), { status: 'answered', answeredAt: '2026-09-03T11:00:00Z', writes: [{ kind: 'mb-put', target: 'n1n1n1n1', detail: 'status → todo', done: true }] }),
      row(ask({ id: '#2', ticket: 2 }), { status: 'later', answeredAt: '2026-09-03T11:00:00Z' }),
    ];
    const backend = { listAsks: async (...a: unknown[]) => { calls.push(a); return listResult(items); } } as unknown as ToolBackend;
    const out = await asksDigestTool.handler(backend, { mapId: 'm1', since: '2026-09-03T00:00:00Z' } as never);
    expect(calls).toEqual([['m1', { status: 'all', since: '2026-09-03T00:00:00Z' }]]);
    expect(out).toBe('/leidang-asks 2026-09-03: 1 beantwortet, 1 vertagt, 0 delegiert · Tickets #6823 · wieder pullbar: n1n1n1n1');
  });
});

describe('fleet_check_blockers', () => {
  it('passes fleet and by through and reports fix runs, check runs and failures', async () => {
    const calls: unknown[][] = [];
    const backend = {
      fleetCheckBlockers: async (...a: unknown[]) => {
        calls.push(a);
        return {
          sent: [{ askId: 'blocker-a', mapId: 'm1', action: 'fleet-fix' }, { askId: 'blocker-b', mapId: 'm1', action: 'fleet-check' }],
          failed: [{ askId: 'blocker-c', mapId: 'm1', error: 'gone' }],
        };
      },
    } as unknown as ToolBackend;
    const out = await fleetCheckBlockersTool.handler(backend, { fleetId: 'f1', by: 'Dan' } as never);
    expect(calls[0]).toEqual(['f1', 'Dan']);
    expect(out).toContain('2 blocker(s) handed to the fleet, 1 failed');
    expect(out).toContain('fix its PR: blocker-a');
    expect(out).toContain('check run: blocker-b');
    expect(out).toContain('FAILED blocker-c: gone');
  });
});
