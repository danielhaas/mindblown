import { describe, it, expect } from 'vitest';
import type { FleetRollup } from '../fleet.js';
import { parseRollup, redactRollup, stopBlockerReason, ticketPhase, ticketPhases, ticketPhaseText } from '../fleet.js';

const base = { host: 'big', generated_at: '2026-10-22T10:00:00Z' };
const now = new Date('2026-10-22T10:05:00Z');

describe('ticket phase (#546)', () => {
  it('parseRollup keeps well-formed claims and drops the rest, never the rollup', () => {
    const r = parseRollup({ ...base, v: 2, workers: [], claims: [{ nodeId: 'n1', phase: 'pr', ci: 'pending' }, { nodeId: 'n2' }, null, 'x'] });
    expect(r?.claims).toEqual([{ nodeId: 'n1', phase: 'pr', ci: 'pending' }]);
    const bad = parseRollup({ ...base, v: 2, workers: [], claims: 'n1' });
    expect(bad).not.toBeNull();
    expect(bad?.claims).toBeUndefined();
    expect(parseRollup({ ...base, workers: [] })?.claims).toBeUndefined();
  });

  it('labels each worker phase; a PR is waiting, red or conflicted; unknown phases verbatim', () => {
    expect(ticketPhase({ nodeId: 'n', phase: 'starting' })).toMatchObject({ label: 'Setting up', tone: 'active' });
    expect(ticketPhase({ nodeId: 'n', phase: 'working' })).toMatchObject({ label: 'Agent working', tone: 'active' });
    expect(ticketPhase({ nodeId: 'n', phase: 'pr', ci: 'pending', pr_number: 7 })).toMatchObject({ label: 'Waiting for CI', tone: 'waiting', prNumber: 7 });
    expect(ticketPhase({ nodeId: 'n', phase: 'pr' })).toMatchObject({ label: 'Waiting for CI' });
    expect(ticketPhase({ nodeId: 'n', phase: 'pr', ci: 'red' })).toMatchObject({ label: 'CI red', tone: 'problem' });
    expect(ticketPhase({ nodeId: 'n', phase: 'pr', ci: 'conflict' })).toMatchObject({ label: 'Merge conflict', tone: 'problem' });
    expect(ticketPhase({ nodeId: 'n', phase: 'pr', ci: 'none' })).toMatchObject({ label: 'No CI', tone: 'problem' });
    expect(ticketPhase({ nodeId: 'n', phase: 'pr', ci: 'manual' })).toMatchObject({ label: 'Needs a human merge', tone: 'problem' });
    expect(ticketPhase({ nodeId: 'n', phase: 'fixing', fix_attempt: 2 })).toMatchObject({ label: 'Fixing (2)', tone: 'active' });
    expect(ticketPhase({ nodeId: 'n', phase: 'fixing' }).label).toBe('Fixing');
    expect(ticketPhase({ nodeId: 'n', phase: 'merging' }).label).toBe('Merging');
    expect(ticketPhase({ nodeId: 'n', phase: 'reviewing' }).label).toBe('reviewing');
  });

  it('agentRunning only while an agent works it — what a Stop can stop (#549)', () => {
    const running = (phase: string, ci?: string) => ticketPhase({ nodeId: 'n', phase, ...(ci ? { ci } : {}) } as never).agentRunning;
    expect(['starting', 'working', 'fixing'].map((p) => running(p))).toEqual([true, true, true]);
    expect([running('pr'), running('pr', 'red'), running('merging'), running('reviewing')]).toEqual([false, false, false, false]);
  });

  it('stopBlockerReason names who stopped it, with the reason when there is one', () => {
    expect(stopBlockerReason('Dan Haas', ' wrong approach ')).toBe('Stopped by Dan Haas: wrong approach');
    expect(stopBlockerReason('Dan Haas', '  ')).toBe('Stopped by Dan Haas');
    expect(stopBlockerReason('', 'x')).toBe('Stopped by a person: x');
  });

  it('ticketPhases: by node id, stale hosts say nothing, the newer rollup wins', () => {
    const host = (generatedAt: string, claims: FleetRollup['claims']) => ({
      generatedAt, receivedAt: generatedAt, rollup: { ...base, v: 2, generated_at: generatedAt, workers: [], claims },
    });
    const phases = ticketPhases([
      host('2026-10-22T10:04:00Z', [{ nodeId: 'n1', phase: 'merging' }]),
      host('2026-10-22T10:01:00Z', [{ nodeId: 'n1', phase: 'pr' }, { nodeId: 'n2', phase: 'working' }]),
      host('2026-10-22T09:30:00Z', [{ nodeId: 'n3', phase: 'working' }]),
      { generatedAt: '2026-10-22T10:00:00Z', receivedAt: '2026-10-22T10:00:00Z', rollup: { ...base, v: 1, workers: [] } },
    ], now);
    expect(phases.get('n1')?.label).toBe('Merging');
    expect(phases.get('n2')?.label).toBe('Agent working');
    expect(phases.has('n3')).toBe(false);
    expect(phases.size).toBe(2);
  });

  it('ticketPhaseText adds the time in the phase', () => {
    const p = ticketPhase({ nodeId: 'n', phase: 'pr', phase_since: '2026-10-22T09:53:00Z' });
    expect(ticketPhaseText(p, now)).toBe('Waiting for CI · 12m');
    expect(ticketPhaseText({ ...p, since: '2026-10-22T07:00:00Z' }, now)).toBe('Waiting for CI · 3h');
    expect(ticketPhaseText({ ...p, since: '2026-10-19T07:00:00Z' }, now)).toBe('Waiting for CI · 3d');
    expect(ticketPhaseText({ ...p, since: null }, now)).toBe('Waiting for CI');
  });

  it('redactRollup drops claims on maps the reader cannot view; mapless ones only for a reader who sees all', () => {
    const rollup: FleetRollup = {
      ...base, v: 2, maps: ['a', 'b'], workers: [],
      claims: [{ nodeId: 'n1', mapId: 'a', phase: 'pr' }, { nodeId: 'n2', mapId: 'b', phase: 'pr' }, { nodeId: 'n3', phase: 'pr' }],
    };
    expect(redactRollup(rollup, ['a', 'b'], new Set(['a'])).claims?.map((c) => c.nodeId)).toEqual(['n1']);
    expect(redactRollup(rollup, ['a', 'b'], new Set(['a', 'b'])).claims?.map((c) => c.nodeId)).toEqual(['n1', 'n2', 'n3']);
  });
});
