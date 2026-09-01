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

function backendWith(result: FleetStatusResult): ToolBackend {
  return { getFleetStatus: async () => result } as unknown as ToolBackend;
}

describe('fleet_status tool', () => {
  it('says so when nothing was pushed yet', async () => {
    const out = await fleetStatusTool.handler(backendWith({ hosts: [], ticks: [], now: NOW }), { mapId: 'm1' } as never);
    expect(out).toContain('No satellite rollup received yet');
    expect(out).toContain('No orchestrator tick received yet');
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
});
