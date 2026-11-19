import { describe, it, expect } from 'vitest';
import type { FleetRollup, FleetWorkerStatus } from '../fleet.js';
import { liveWorkerClaims, liveClaimKey } from '../fleet.js';

const NOW = new Date('2026-11-12T10:00:00Z');
const FRESH = '2026-11-12T09:58:00Z';
const S = 'gamora:slot1:default';

function host(worker: Partial<FleetWorkerStatus>, opts: { at?: string; mapIds?: string[] } = {}) {
  const at = opts.at ?? FRESH;
  const w: FleetWorkerStatus = { session: S, state: 'working', last_activity: at, claim: { mapId: 'm1', nodeId: 'n1' }, ...worker };
  const rollup: FleetRollup = { v: 2, host: 'gamora', generated_at: at, workers: [w] };
  return { generatedAt: at, receivedAt: at, mapIds: opts.mapIds ?? ['m1'], rollup };
}

const live = (h: ReturnType<typeof host>) => liveWorkerClaims([h], NOW);

describe('liveWorkerClaims', () => {
  it('keys a working worker on a fresh host by map, node and session', () => {
    expect(live(host({}))).toEqual(new Set([liveClaimKey('m1', 'n1', S)]));
  });

  it('falls back to the one map a host serves when the claim names none', () => {
    expect(live(host({ claim: { nodeId: 'n1' } }))).toEqual(new Set([liveClaimKey('m1', 'n1', S)]));
  });

  it.each([
    ['a stale host', host({}, { at: '2026-11-12T09:00:00Z' })],
    ['a dead worker', host({ derived_dead: true })],
    ['a parked worker still naming its claim', host({ state: 'prompt' })],
    ['no map named and several served', host({ claim: { nodeId: 'n1' } }, { mapIds: ['m1', 'm2'] })],
    ['a map the host does not serve', host({}, { mapIds: [] })],
    ['an idle worker', host({ claim: null })],
  ])('protects nothing for %s', (_why, h) => {
    expect(live(h).size).toBe(0);
  });
});
