/**
 * fleet_status tool — renders what MindBlown last received from the
 * Leidang fleet. Pins the two things an agent must not misread: a stale
 * host is flagged and not counted as capacity, and a configured-but-silent
 * satellite is named (the 2026-07-26 six-workers-unseen failure).
 */
import { describe, it, expect } from 'vitest';
import { fleetStatusTool } from '../orchestration.js';
import type { ToolBackend, FleetStatusResult } from '../../backend.js';

const NOW = '2026-09-01T12:00:00Z';
const ago = (min: number) => new Date(Date.parse(NOW) - min * 60_000).toISOString();

function backendWith(result: FleetStatusResult, calls: unknown[][] = []): ToolBackend {
  return {
    getFleetStatus: async (...args: unknown[]) => {
      calls.push(args);
      return result;
    },
  } as unknown as ToolBackend;
}

describe('fleet_status tool — tick history (since)', () => {
  const host = {
    host: 'njoerd',
    generatedAt: ago(1),
    receivedAt: ago(1),
    rollup: { v: 1, host: 'njoerd', generated_at: ago(1), workers: [{ session: 'njoerd:worker-1:default', worker: 'worker-1', state: 'working', last_activity: ago(1) }] },
  };
  // Stored newest-first, as the route returns them; spans midnight UTC.
  const ticks: FleetStatusResult['ticks'] = [
    { id: 't4', tickAt: '2026-09-01T00:30:00Z', receivedAt: '2026-09-01T00:30:02Z', payload: { summary: { claims: 2, cap: 6, pullableInGate: 11, needsBrief: 4 }, noJudgment: 'orchestrator at limit', cap: { set: null, reason: null } } },
    { id: 't3', tickAt: '2026-09-01T00:00:00Z', receivedAt: '2026-09-01T00:00:02Z', payload: { summary: { claims: 3, cap: 9, pullableInGate: 11, needsBrief: 4 }, cap: { set: 6, reason: 'limit-parked x3' }, anomalies: [{ severity: 'warn', what: 'sat2 silent' }, { severity: 'info', what: 'noise' }], asks: ['#1'] } },
    { id: 't2', tickAt: '2026-08-31T23:30:00Z', receivedAt: '2026-08-31T23:30:02Z', payload: { summary: { claims: 3, cap: 9, pullableInGate: 12, needsBrief: 4 }, policy: { set: ['heavy', 'light'], reason: 'P0 open' } } },
    { id: 't1', tickAt: '2026-08-31T23:00:00Z', receivedAt: '2026-08-31T23:00:02Z', payload: { summary: { claims: 3, cap: 9, pullableInGate: 12, needsBrief: 5 }, gate_recommendation: { set: ['type:bug'], reason: 'queue dry' } } },
  ];

  it('passes since/limit to the backend and stays on the latest-tick rendering without since', async () => {
    const calls: unknown[][] = [];
    const out = await fleetStatusTool.handler(backendWith({ hosts: [host], ticks, now: NOW }, calls), { mapId: 'm1' } as never);
    expect(calls).toEqual([['m1', undefined]]);
    expect(out).not.toContain('Tick history');

    await fleetStatusTool.handler(backendWith({ hosts: [host], ticks, now: NOW }, calls), { mapId: 'm1', since: '2026-08-31T22:00:00Z', limit: 100 } as never);
    expect(calls[1]).toEqual(['m1', { since: '2026-08-31T22:00:00Z', limit: 100 }]);
  });

  it('renders one line per tick oldest first with a date line at midnight, writes, warn+ anomalies, and totals', async () => {
    const out = await fleetStatusTool.handler(
      backendWith({ hosts: [host], ticks, now: NOW, window: { since: '2026-08-31T22:00:00.000Z', until: null, limit: 500 } }),
      { mapId: 'm1', since: '2026-08-31T22:00:00Z' } as never,
    );
    const history = out.slice(out.indexOf('Tick history'));
    const lines = history.split('\n');
    expect(lines[0]).toContain('Tick history since 2026-08-31T22:00:00Z — 4 ticks, oldest first (times UTC)');
    expect(lines.slice(1)).toEqual([
      '  2026-08-31',
      '  23:00 claims 3/9 · in-gate 12 · needs-brief 5 · gate? type:bug',
      '  23:30 claims 3/9 · in-gate 12 · needs-brief 4 · policy→heavy › light (P0 open)',
      '  2026-09-01',
      '  00:00 claims 3/9 · in-gate 11 · needs-brief 4 · cap→6 (limit-parked x3) · [warn] sat2 silent · 1 ask',
      '  00:30 claims 2/6 · in-gate 11 · needs-brief 4 · NO JUDGMENT (orchestrator at limit)',
      'Total: 4 ticks · 1 cap write · 1 policy write · 1 anomaly warn+ · 1 without judgment',
    ]);
    // The latest-tick block is still there above the history.
    expect(out).toContain('Last orchestrator tick 2026-09-01T00:30:00Z — NO JUDGMENT (orchestrator at limit)');
  });

  it('says so for an empty window and flags a window cut by the limit', async () => {
    const empty = await fleetStatusTool.handler(backendWith({ hosts: [host], ticks: [], now: NOW, window: { since: ago(60), until: null, limit: 500 } }), { mapId: 'm1', since: ago(60) } as never);
    expect(empty).toContain('no ticks in this window');
    const cut = await fleetStatusTool.handler(backendWith({ hosts: [host], ticks: ticks.slice(0, 2), now: NOW, window: { since: ago(600), until: null, limit: 2 } }), { mapId: 'm1', since: ago(600), limit: 2 } as never);
    expect(cut).toContain('2 ticks, oldest first (times UTC) — newest 2 only');
  });
});

describe('fleet_status tool', () => {
  it('says so when nothing was pushed yet', async () => {
    const out = await fleetStatusTool.handler(backendWith({ hosts: [], ticks: [], now: NOW }), { mapId: 'm1' } as never);
    expect(out).toContain('No satellite rollup received yet');
    expect(out).toContain('No orchestrator tick received yet');
  });

  it('says the map has no fleet when the server reports fleetId null (#479)', async () => {
    const out = await fleetStatusTool.handler(backendWith({ fleetId: null, hosts: [], ticks: [], now: NOW }), { mapId: 'm1' } as never);
    expect(out).toContain('is not connected to a fleet');
  });

  it('with fleetId reads the whole fleet: served maps, agent badge, redacted claims (#479)', async () => {
    const calls: unknown[][] = [];
    const result: FleetStatusResult = {
      fleetId: 'f1',
      hosts: [
        {
          host: 'big',
          generatedAt: ago(1),
          receivedAt: ago(1),
          mapIds: ['m1'],
          rollup: {
            v: 2,
            host: 'big',
            generated_at: ago(1),
            maps: ['m1'],
            workers: [
              { session: 'big:w1', worker: 'w1', agent: 'qwen-code', model: 'qwen3.8', state: 'working', last_activity: ago(1), claim: { mapId: 'm1', title: 'Seen ticket' } },
              { session: 'big:w2', worker: 'w2', state: 'working', last_activity: ago(1), claim: { redacted: true } },
            ],
          },
        },
      ],
      ticks: [],
      now: NOW,
    };
    const backend = {
      getFleetStatusForFleet: async (...args: unknown[]) => {
        calls.push(args);
        return result;
      },
    } as unknown as ToolBackend;
    const out = await fleetStatusTool.handler(backend, { fleetId: 'f1' } as never);
    expect(calls).toEqual([['f1', undefined]]);
    expect(out).toContain('big (1m ago) — serves maps m1');
    expect(out).toContain('w1: qwen-code qwen3.8 · working · claim: Seen ticket');
    expect(out).toContain("w2: working · claim: on a map you can't view");
    await expect(fleetStatusTool.handler(backend, {} as never)).rejects.toThrow(/exactly one/);
  });

  it('renders hosts with worker states, flags stale hosts, names silent satellites and the asks', async () => {
    const result: FleetStatusResult = {
      now: NOW,
      hosts: [
        {
          host: 'njoerd',
          generatedAt: ago(1),
          receivedAt: ago(1),
          rollup: {
            v: 1,
            host: 'njoerd',
            generated_at: ago(1),
            workers: [
              { session: 'njoerd:worker-1:default', worker: 'worker-1', model: 'sonnet', state: 'working', last_activity: ago(2), claim: { nodeId: 'n1', title: '#8770 export' }, ctx_pct: 42 },
              { session: 'njoerd:worker-2:default', worker: 'worker-2', model: 'fable', state: 'limit-parked', limit_reset_at: '2026-09-01T17:10:00Z', claim: null },
              { session: 'njoerd:worker-3:default', worker: 'worker-3', model: 'sonnet', state: 'working', last_activity: ago(90), claim: null },
            ],
          },
        },
        {
          host: 'sat3',
          generatedAt: ago(45),
          receivedAt: ago(45),
          rollup: { v: 1, host: 'sat3', generated_at: ago(45), workers: [{ session: 'sat3:worker-1:default', worker: 'worker-1', state: 'parked' }] },
        },
      ],
      ticks: [
        {
          id: 't1',
          tickAt: ago(10),
          receivedAt: ago(10),
          payload: {
            assessment: 'Fleet-wide zero working capacity.',
            anomalies: [{ severity: 'critical', what: 'nothing works' }],
            asks: ['#3287: deploy FM CT122'],
            cap: { set: null, reason: null },
            gate_recommendation: { set: ['type:bug'], reason: 'release queue dry' },
            pullStatus: [
              { sat: 'satellite-claudia', ok: true, files: ['njoerd.json'] },
              { sat: 'leidang-sat2', ok: true, files: [] },
              { sat: 'leidang-sat4', ok: true, files: ['sat4.json'] },
            ],
            summary: { heartbeat: 'claims 0/12 · gate 1/199 nb48' },
          },
        },
      ],
    };
    const out = await fleetStatusTool.handler(backendWith(result), { mapId: 'm1' } as never);
    expect(out).toContain('Fleet: 1/2 hosts reporting, 3 workers on fresh hosts');
    expect(out).toMatch(/working 1/);
    expect(out).toMatch(/dead 1/); // worker-3: "working" but silent for 90 min
    expect(out).toContain('sat3 (45m ago — STALE');
    expect(out).toContain('worker-1: sonnet · working · claim: #8770 export · ctx 42%');
    expect(out).toContain('worker-2: fable · limit-parked · reset 2026-09-01T17:10:00Z');
    expect(out).toContain('plus 1 last seen on stale hosts, not counted');
    expect(out).toContain('SILENT satellite leidang-sat2: up but delivered no rollup');
    expect(out).toContain('note: leidang-sat4 delivers to the orchestrator but does not push to MindBlown yet');
    expect(out).toContain('[critical] nothing works');
    expect(out).toContain('- #3287: deploy FM CT122');
    expect(out).toContain('gate RECOMMENDED (needs the human) → type:bug');
    expect(out).toContain('numbers: claims 0/12');
  });

  it('names the open PRs a parked slot still holds and which wait for a person', async () => {
    const result: FleetStatusResult = {
      now: NOW,
      hosts: [
        {
          host: 'big-blower',
          generatedAt: ago(1),
          receivedAt: ago(1),
          rollup: {
            v: 2,
            host: 'big-blower',
            generated_at: ago(1),
            workers: [{ session: 'big-blower:slot1:fleet-worker', worker: 'slot1', state: 'parked', last_activity: ago(1), claim: null }],
            claims: [
              { nodeId: 'n1', mapId: 'm1', phase: 'pr', ci: 'red', pr_number: 1038, phase_since: ago(90) },
              { nodeId: 'n2', mapId: 'm1', phase: 'pr', ci: 'pending', pr_number: 1040, phase_since: ago(5) },
            ],
          },
        },
      ],
      ticks: [],
    };
    const out = await fleetStatusTool.handler(backendWith(result), { mapId: 'm1' } as never);
    expect(out).toContain('slot1: parked');
    expect(out).toContain('- holds PR #1038 (node n1): CI red · 1h — needs a person');
    expect(out).toContain('- holds PR #1040 (node n2): Waiting for CI · 5m\n');
  });
});
