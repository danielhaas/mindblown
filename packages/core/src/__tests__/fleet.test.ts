import { describe, it, expect } from 'vitest';
import type { FleetRollup, FleetWorkerStatus } from '../fleet.js';
import {
  parseRollup,
  parseTick,
  hostFreshness,
  isWorkerDead,
  effectiveWorkerState,
  summarizeFleet,
  silentSatellites,
  estimateServerNow,
  parseTickWindow,
  severityRank,
  summarizeTick,
} from '../fleet.js';

const NOW = new Date('2026-09-01T12:00:00Z');
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();

function w(p: Partial<FleetWorkerStatus> & { session: string; state: string }): FleetWorkerStatus {
  return { v: 1, worker: p.session.split(':')[1], model: 'sonnet', claim: null, last_activity: ago(1), ...p };
}
function rollup(host: string, workers: FleetWorkerStatus[], p: Partial<FleetRollup> = {}): FleetRollup {
  return { v: 1, host, generated_at: ago(1), workers, ...p };
}

describe('parseRollup / parseTick', () => {
  it('accepts the v1 shape and drops malformed workers', () => {
    const r = parseRollup({ host: 'njoerd', generated_at: ago(2), workers: [w({ session: 'njoerd:worker-1:default', state: 'parked' }), { junk: true }, null] });
    expect(r?.host).toBe('njoerd');
    expect(r?.workers).toHaveLength(1);
    expect(r?.v).toBe(1);
  });
  it('rejects missing host, bad timestamp, missing workers', () => {
    expect(parseRollup(null)).toBeNull();
    expect(parseRollup({ generated_at: ago(1), workers: [] })).toBeNull();
    expect(parseRollup({ host: 'x', generated_at: 'yesterday', workers: [] })).toBeNull();
    expect(parseRollup({ host: 'x', generated_at: ago(1) })).toBeNull();
  });
  it('parseTick keeps the decision and normalises non-array anomalies/asks', () => {
    expect(parseTick({ assessment: 'ok', anomalies: 'nope', asks: null })).toEqual({ assessment: 'ok', anomalies: [], asks: [] });
    expect(parseTick('x')).toBeNull();
  });
});

describe('hostFreshness', () => {
  it('uses the OLDER of generated/received so a skewed clock cannot look fresh', () => {
    expect(hostFreshness(ago(2), ago(2), NOW).stale).toBe(false);
    // satellite clock 1h ahead: generated_at is in the future, received 25 min ago → stale
    expect(hostFreshness(ago(-60), ago(25), NOW)).toMatchObject({ stale: true });
    expect(hostFreshness(ago(25), ago(1), NOW).ageMin).toBeCloseTo(25, 5);
    expect(hostFreshness('garbage', 'garbage', NOW).stale).toBe(true);
  });
});

describe('worker deadness', () => {
  it('derives dead from a stale "working" state, honours the satellite flag, leaves parked alone', () => {
    expect(isWorkerDead(w({ session: 's', state: 'working', last_activity: ago(45) }), NOW)).toBe(true);
    expect(isWorkerDead(w({ session: 's', state: 'working', last_activity: ago(5) }), NOW)).toBe(false);
    expect(isWorkerDead(w({ session: 's', state: 'parked', last_activity: ago(600) }), NOW)).toBe(false);
    expect(isWorkerDead(w({ session: 's', state: 'parked', derived_dead: true }), NOW)).toBe(true);
    expect(effectiveWorkerState(w({ session: 's', state: 'working', last_activity: ago(45) }), NOW)).toBe('dead');
  });
});

describe('summarizeFleet', () => {
  const njoerd = rollup('njoerd', [
    w({ session: 'njoerd:worker-1:default', state: 'working', claim: { nodeId: 'n1', title: 'A' } }),
    w({ session: 'njoerd:worker-2:default', state: 'limit-parked', limit_reset_at: ago(-120) }),
    w({ session: 'njoerd:worker-3:default', state: 'working', last_activity: ago(90) }),
  ]);
  const sat3 = rollup('sat3', [w({ session: 'sat3:worker-1:default', state: 'parked' })], { generated_at: ago(40), draining: 'paused for login' });

  it('counts effective states on fresh hosts only, lists stale hosts, sorts by host', () => {
    const s = summarizeFleet(
      [
        { rollup: sat3, receivedAt: ago(40) },
        { rollup: njoerd, receivedAt: ago(1) },
      ],
      NOW,
    );
    expect(s.hosts.map((h) => h.host)).toEqual(['njoerd', 'sat3']);
    expect(s.hosts[0].counts).toEqual({ working: 1, 'limit-parked': 1, dead: 1 });
    expect(s.hosts[0].claims).toBe(1);
    expect(s.hosts[1].freshness.stale).toBe(true);
    expect(s.hosts[1].draining).toBe('paused for login');
    expect(s.totals).toEqual({ working: 1, 'limit-parked': 1, dead: 1 });
    expect(s.workersTotal).toBe(3);
    expect(s.staleWorkers).toBe(1);
    expect(s.working).toBe(1);
    expect(s.freshHosts).toBe(1);
    expect(s.staleHosts).toEqual(['sat3']);
  });

  it('is empty-safe', () => {
    expect(summarizeFleet([], NOW)).toMatchObject({ hosts: [], totals: {}, workersTotal: 0, working: 0, freshHosts: 0, staleHosts: [] });
  });
});

describe('silentSatellites', () => {
  it('names configured satellites that delivered no rollup, with the reason', () => {
    const ps = [
      { sat: 'satellite-claudia', ok: true, files: ['njoerd.json'] },
      { sat: 'leidang-sat2', ok: true, files: [] },
      { sat: 'leidang-sat3', ok: false, files: [] },
    ];
    expect(silentSatellites(ps, ['njoerd'])).toEqual([
      { sat: 'leidang-sat2', reason: 'no-rollup' },
      { sat: 'leidang-sat3', reason: 'unreachable' },
    ]);
    expect(silentSatellites(undefined, ['njoerd'])).toEqual([]);
  });

  it('a satellite that delivered by scp but never pushed to MindBlown is "not-pushing", not an alarm', () => {
    // Merge-day state: the sender patch is not rolled out anywhere yet.
    const ps = [
      { sat: 'satellite-claudia', ok: true, files: ['njoerd.json'] },
      { sat: 'leidang-sat2', ok: true, files: ['sat2.json'] },
    ];
    expect(silentSatellites(ps, [])).toEqual([
      { sat: 'satellite-claudia', reason: 'not-pushing' },
      { sat: 'leidang-sat2', reason: 'not-pushing' },
    ]);
    expect(silentSatellites(ps, ['njoerd', 'sat2'])).toEqual([]);
  });
});

describe('estimateServerNow', () => {
  it('advances the server clock by the time since THAT fetch, never by page uptime', () => {
    const server = '2026-09-01T12:00:00Z';
    const fetchedAt = Date.parse('2026-09-01T09:00:00Z'); // browser clock is 3 h behind the server
    expect(estimateServerNow(server, fetchedAt, fetchedAt + 90_000).toISOString()).toBe('2026-09-01T12:01:30.000Z');
    // A refetch pairs a new server time with ITS fetch time — no drift accumulates.
    const refetched = '2026-09-01T12:30:00Z';
    const fetchedAt2 = fetchedAt + 30 * 60_000;
    expect(estimateServerNow(refetched, fetchedAt2, fetchedAt2 + 10_000).toISOString()).toBe('2026-09-01T12:30:10.000Z');
    // Garbage server time → the local clock
    expect(estimateServerNow('nope', 0, 5_000).getTime()).toBe(5_000);
    // A clock that ran backwards does not subtract
    expect(estimateServerNow(server, 10_000, 5_000).toISOString()).toBe('2026-09-01T12:00:00.000Z');
  });
});

describe('parseTickWindow', () => {
  it('defaults to 20 without since and 500 with since; clamps limit to 1..500', () => {
    expect(parseTickWindow({})).toEqual({ since: null, until: null, limit: 20 });
    const w = parseTickWindow({ since: '2026-09-01T00:00:00Z' });
    expect(w).toMatchObject({ until: null, limit: 500 });
    expect((w as { since: Date }).since.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(parseTickWindow({ limit: '9999' })).toMatchObject({ limit: 500 });
    expect(parseTickWindow({ limit: 0 })).toMatchObject({ limit: 1 });
    expect(parseTickWindow({ limit: '-3' })).toMatchObject({ limit: 1 });
    expect(parseTickWindow({ limit: '7.9' })).toMatchObject({ limit: 7 });
    expect(parseTickWindow({ since: '', until: '', limit: '' })).toEqual({ since: null, until: null, limit: 20 });
  });
  it('refuses garbage dates, repeated params and non-numeric limits instead of ignoring them', () => {
    expect(parseTickWindow({ since: 'yesterday' })).toHaveProperty('error');
    expect(parseTickWindow({ until: 'nope' })).toHaveProperty('error');
    expect(parseTickWindow({ since: ['a', 'b'] })).toHaveProperty('error');
    expect(parseTickWindow({ limit: 'many' })).toHaveProperty('error');
  });
});

describe('summarizeTick', () => {
  it('flattens the numbers, keeps only real knob writes and warn+ anomalies (worst first)', () => {
    const s = summarizeTick({
      tickAt: ago(30),
      receivedAt: ago(29),
      payload: {
        assessment: 'two workers limit-parked',
        summary: { claims: 3, cap: 9, pullableInGate: 12, needsBrief: 4 },
        cap: { set: 6, reason: 'limit-parked x2' },
        policy: { set: null, reason: null },
        gate_recommendation: { set: ['type:bug'], reason: 'release queue dry' },
        anomalies: [
          { severity: 'info', what: 'noise' },
          { severity: 'warn', what: 'sat2 silent' },
          { severity: 'critical', what: 'nothing works' },
        ],
        asks: ['#1', '#2'],
      },
    });
    expect(s).toMatchObject({
      at: ago(30),
      receivedAt: ago(29),
      claims: 3,
      cap: 9,
      pullableInGate: 12,
      needsBrief: 4,
      heartbeat: null,
      noJudgment: null,
      capWrite: { set: 6, reason: 'limit-parked x2' },
      policyWrite: null,
      gateRecommendation: { set: ['type:bug'], reason: 'release queue dry' },
      asksCount: 2,
      assessment: 'two workers limit-parked',
    });
    expect(s.anomalies.map((a) => a.severity)).toEqual(['critical', 'warn']);
  });
  it('is tolerant of the bare heartbeat tick (no judgment, no summary numbers)', () => {
    const s = summarizeTick({ tickAt: 'a', receivedAt: 'b', payload: { noJudgment: 'orchestrator at limit', cap: { set: null, reason: null } } });
    expect(s).toMatchObject({ claims: null, cap: null, pullableInGate: null, needsBrief: null, capWrite: null, policyWrite: null, gateRecommendation: null, anomalies: [], asksCount: 0, assessment: null, noJudgment: 'orchestrator at limit' });
    expect(severityRank('WARNING')).toBe(1);
    expect(severityRank('critical')).toBe(2);
    expect(severityRank('note')).toBe(0);
  });
});
