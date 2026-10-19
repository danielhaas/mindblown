import { describe, it, expect } from 'vitest';
import type { FleetRollup } from '../fleet.js';
import { parseRollup, redactRollup, redactTick, rollupServedMaps, summarizeFleet } from '../fleet.js';
import { buildFleetJournal } from '../fleetJournal.js';

const base = { host: 'big', generated_at: '2026-10-19T10:00:00Z' };

describe('rollup v2 (#479)', () => {
  it('parseRollup keeps maps[] (deduplicated, strings only) and refuses a non-array', () => {
    expect(parseRollup({ ...base, v: 2, maps: ['a', 'b', 'a', 3, ''], workers: [] })?.maps).toEqual(['a', 'b']);
    expect(parseRollup({ ...base, maps: 'a', workers: [] })).toBeNull();
    expect(parseRollup({ ...base, workers: [] })?.maps).toBeUndefined();
  });

  it('rollupServedMaps: v2 names them, v1 serves its map_id or the map it was pushed for', () => {
    expect(rollupServedMaps({ ...base, v: 2, maps: ['a', 'b'], workers: [] }, 'x')).toEqual(['a', 'b']);
    expect(rollupServedMaps({ ...base, v: 1, map_id: 'a', workers: [] }, null)).toEqual(['a']);
    expect(rollupServedMaps({ ...base, v: 1, workers: [] }, 'x')).toEqual(['x']);
    expect(rollupServedMaps({ ...base, v: 1, workers: [] }, null)).toEqual([]);
  });

  describe('redactRollup', () => {
    const rollup: FleetRollup = {
      ...base,
      v: 2,
      maps: ['a', 'b'],
      workers: [
        { session: 's1', state: 'working', agent: 'qwen-code', claim: { mapId: 'a', nodeId: 'n1', title: 'Seen' } },
        { session: 's2', state: 'working', claim: { mapId: 'b', nodeId: 'n2', title: 'Hidden' } },
        { session: 's3', state: 'working', claim: { nodeId: 'n3', title: 'Unplaced' } },
        { session: 's4', state: 'parked', claim: null },
      ],
    };

    it('keeps claims on visible maps, redacts the rest, drops hidden maps', () => {
      const out = redactRollup(rollup, ['a', 'b'], new Set(['a']));
      expect(out.maps).toEqual(['a']);
      expect(out.workers.map((w) => w.claim)).toEqual([
        { mapId: 'a', nodeId: 'n1', title: 'Seen' },
        { redacted: true },
        // No mapId and two served maps: can't be placed, so not shown.
        { redacted: true },
        null,
      ]);
      expect(out.workers[0].agent).toBe('qwen-code');
      expect(JSON.stringify(out)).not.toMatch(/Hidden|Unplaced/);
    });

    it('a v1 claim without mapId belongs to the single served map', () => {
      const v1: FleetRollup = { ...base, v: 1, map_id: 'a', workers: [{ session: 's', state: 'working', claim: { nodeId: 'n', title: 'T' } }] };
      expect(redactRollup(v1, ['a'], new Set(['a'])).workers[0].claim).toEqual({ nodeId: 'n', title: 'T' });
      const hidden = redactRollup(v1, ['a'], new Set());
      expect(hidden.workers[0].claim).toEqual({ redacted: true });
      expect(hidden.map_id).toBeUndefined();
    });

    it('a claim without mapId is shown when the reader sees every served map', () => {
      expect(redactRollup(rollup, ['a', 'b'], new Set(['a', 'b'])).workers[2].claim).toEqual({ nodeId: 'n3', title: 'Unplaced' });
    });

    it('strips everything about a hidden ticket, and unplaceable node lists, but keeps counts', () => {
      const r: FleetRollup = {
        ...base,
        v: 2,
        maps: ['a', 'b'],
        blocked: { count: 2, recent: [{ node: 'x', at: 't' }] },
        workers: [
          { session: 's1', state: 'prompt', claim: { mapId: 'b', title: 'Hidden' }, prompt_question: 'q?', waiting: { since: 't', reason: 'r' }, pr_number: 7, blocked_nodes: [{ node: 'x', at: 't' }] },
          { session: 's2', state: 'working', claim: { mapId: 'a', title: 'Seen' }, blocked_nodes: [{ node: 'y', at: 't' }], prompt_question: 'fine?' },
        ],
      };
      const out = redactRollup(r, ['a', 'b'], new Set(['a']));
      expect(out.workers[0]).toEqual({ session: 's1', state: 'prompt', claim: { redacted: true } });
      // A visible claim keeps its own prose; node lists without a map can't be placed, so they go.
      expect(out.workers[1]).toEqual({ session: 's2', state: 'working', claim: { mapId: 'a', title: 'Seen' }, prompt_question: 'fine?' });
      expect(out.blocked).toEqual({ count: 2, recent: [] });
      expect(redactRollup(r, ['a', 'b'], new Set(['a', 'b'])).blocked?.recent).toHaveLength(1);
    });

    it('a redacted claim still counts as a claim in the summary', () => {
      const out = redactRollup(rollup, ['a', 'b'], new Set());
      const summary = summarizeFleet([{ rollup: out, receivedAt: '2026-10-19T10:00:00Z' }], new Date('2026-10-19T10:01:00Z'));
      expect(summary.hosts[0].claims).toBe(3);
    });
  });
});

describe('redactTick', () => {
  it('keeps the numbers, drops the prose', () => {
    const out = redactTick({
      assessment: 'B stuck',
      anomalies: [{ severity: 'warn', what: 'B red' }],
      asks: ['decide B'],
      cap: { set: 4, reason: 'B CI' },
      policy: { set: ['bugs'], reason: 'B P0' },
      gate_recommendation: { set: ['v'], reason: 'r' },
      phase_recommendation: { phase: 'p', why: 'w' },
      notify: { title: 't' },
      summary: { claims: 2, cap: 4 },
      pullStatus: [{ sat: 's', ok: true, files: ['b-secret.json'], at: 't' }],
      noJudgment: null,
    });
    expect(out).toEqual({
      redacted: true,
      summary: { claims: 2, cap: 4 },
      cap: { set: 4, reason: null },
      policy: { set: ['bugs'], reason: null },
      noJudgment: null,
      pullStatus: [{ sat: 's', ok: true, files: [], at: 't' }],
    });
  });
});

describe('fleet journal across maps (#479)', () => {
  const from = new Date('2026-10-19T00:00:00Z');
  const to = new Date('2026-10-19T12:00:00Z');
  const node = (id: string, mapId?: string) => ({
    ...(mapId ? { mapId } : {}),
    id,
    text: `node ${id}`,
    status: 'done',
    completedAt: '2026-10-19T06:00:00Z',
    createdAt: '2026-10-19T01:00:00Z',
    createdBy: null,
    actualEffort: null,
    effortEstimate: null,
    priority: null,
    versionId: null,
    tags: [],
    externalLinks: [],
    blockedReason: null,
    claimedBySession: null,
  });
  const claim = (nodeId: string, mapId?: string) => ({
    ...(mapId ? { mapId } : {}),
    eventType: 'node.claimed',
    nodeId,
    userId: null,
    fieldName: null,
    oldValue: null,
    newValue: { session: 'big:worker-1:default', via: 'pull' },
    createdAt: '2026-10-19T02:00:00Z',
  });

  it('entries carry the mapId of their node when the loader tags rows', () => {
    const j = buildFleetJournal({ window: { from, to }, ticks: [], events: [claim('n1', 'a'), claim('n2', 'b')], nodes: [node('n1', 'a'), node('n2', 'b')], versions: [], users: [] });
    expect(j.claims.map((c) => c.mapId)).toEqual(['a', 'b']);
    expect(j.delivered.map((d) => d.mapId).sort()).toEqual(['a', 'b']);
    expect(j.created.map((c) => c.mapId).sort()).toEqual(['a', 'b']);
  });

  it('an untagged single-map journal keeps its old shape (no mapId key)', () => {
    const j = buildFleetJournal({ window: { from, to }, ticks: [], events: [claim('n1')], nodes: [node('n1')], versions: [], users: [] });
    expect(j.claims[0]).not.toHaveProperty('mapId');
    expect(j.delivered[0]).not.toHaveProperty('mapId');
  });
});
