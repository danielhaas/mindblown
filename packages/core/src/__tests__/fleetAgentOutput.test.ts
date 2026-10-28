import { describe, it, expect } from 'vitest';
import type { FleetRollup } from '../fleet.js';
import { AGENT_OUTPUT_MAX_LINES, AGENT_OUTPUT_MAX_LINE_CHARS, claimOutput, parseRollup, withoutClaimOutput } from '../fleet.js';

const MAP_A = 'map-a';
const MAP_B = 'map-b';

const base = { v: 2, host: 'njoerd', generated_at: '2026-10-28T10:00:00Z', maps: [MAP_A], workers: [] };

describe('agent output on a claim (#585)', () => {
  it('keeps the newest lines, cuts long ones and drops non-strings', () => {
    const lines = Array.from({ length: 150 }, (_, i) => `line ${i}`);
    lines[149] = 'x'.repeat(AGENT_OUTPUT_MAX_LINE_CHARS + 10);
    const r = parseRollup({ ...base, claims: [{ nodeId: 'n1', phase: 'working', output: [42, ...lines], output_at: '2026-10-28T09:59:00Z' }] })!;
    const out = r.claims![0].output!;
    expect(out).toHaveLength(AGENT_OUTPUT_MAX_LINES);
    expect(out[0]).toBe('line 50');
    expect(out[99]).toHaveLength(AGENT_OUTPUT_MAX_LINE_CHARS + 1);
    expect(r.claims![0].output_at).toBe('2026-10-28T09:59:00Z');
  });

  it('drops a malformed output and a bad timestamp, keeps the claim', () => {
    const r = parseRollup({ ...base, claims: [{ nodeId: 'n1', phase: 'working', output: 'nope', output_at: 'soon' }] })!;
    expect(r.claims![0]).toEqual({ nodeId: 'n1', phase: 'working' });
  });

  it('withoutClaimOutput strips the tail and leaves the phase', () => {
    const r: FleetRollup = { ...base, claims: [{ nodeId: 'n1', phase: 'working', output: ['$ pnpm test'], output_at: '2026-10-28T09:59:00Z' }] };
    expect(withoutClaimOutput(r).claims).toEqual([{ nodeId: 'n1', phase: 'working' }]);
    expect(r.claims![0].output).toEqual(['$ pnpm test']);
  });

  it('claimOutput picks the ticket on the map, newest report first', () => {
    const host = (name: string, at: string, mapIds: string[], claims: FleetRollup['claims']) => ({
      host: name,
      generatedAt: at,
      mapIds,
      rollup: { ...base, host: name, generated_at: at, maps: mapIds, claims },
    });
    const hosts = [
      host('old', '2026-10-28T09:00:00Z', [MAP_A], [{ nodeId: 'n1', phase: 'working', output: ['old'] }]),
      host('new', '2026-10-28T10:00:00Z', [MAP_A, MAP_B], [{ nodeId: 'n1', mapId: MAP_A, phase: 'working', output: ['new'] }]),
      // No mapId on a host serving two maps: can't be placed.
      host('two', '2026-10-28T11:00:00Z', [MAP_A, MAP_B], [{ nodeId: 'n1', phase: 'working', output: ['unplaced'] }]),
    ];
    expect(claimOutput(hosts, MAP_A, 'n1')).toEqual({ host: 'new', at: '2026-10-28T10:00:00Z', lines: ['new'] });
    expect(claimOutput(hosts, MAP_B, 'n1')).toBeNull();
    expect(claimOutput(hosts, MAP_A, 'other')).toBeNull();
  });
});
