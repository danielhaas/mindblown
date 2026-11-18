import { describe, it, expect } from 'vitest';
import type { AskRow } from '../asks.js';
import type { FleetRollup, FleetWorkerStatus } from '../fleet.js';
import {
  fleetIdleState,
  ownerPerson,
  summarizeWaiting,
  waitingAlertDue,
  waitingItemsFromAsks,
  WAITING_ALERT_THROTTLE_MS,
  type WaitingItem,
} from '../waitingOnHumans.js';

const now = new Date('2026-11-18T12:00:00Z');
const host = (workers: Partial<FleetWorkerStatus>[], claims: FleetRollup['claims'] = [], at = '2026-11-18T11:58:00Z') => ({
  generatedAt: at,
  receivedAt: at,
  rollup: { v: 2, host: 'h', generated_at: at, workers: workers.map((w, i) => ({ session: `s${i}`, state: 'parked', ...w })), claims } as FleetRollup,
});

describe('fleetIdleState', () => {
  it('idle when no claims and every worker is parked or idle; since = the last one to stop', () => {
    const s = fleetIdleState(
      [host([{ state: 'parked', state_since: '2026-11-18T09:00:00Z' }, { state: 'limit-parked', state_since: '2026-11-18T10:00:00Z' }, { state: 'idle' }])],
      0,
      now,
    );
    expect(s).toMatchObject({ idle: true, idleSince: '2026-11-18T10:00:00.000Z', hostsReporting: 1, workers: { total: 3, working: 0, waiting: 3 } });
  });

  it('not idle while a worker works, a claim is active, or an agent runs on a claim', () => {
    expect(fleetIdleState([host([{ state: 'working', last_activity: '2026-11-18T11:59:00Z' }])], 0, now).idle).toBe(false);
    expect(fleetIdleState([host([{ state: 'parked' }])], 1, now).idle).toBe(false);
    expect(fleetIdleState([host([{ state: 'parked' }], [{ nodeId: 'n', phase: 'fixing' }])], 0, now).idle).toBe(false);
  });

  it('a PR waiting on a person does not keep the fleet busy; a dead worker is not working', () => {
    const s = fleetIdleState(
      [host([{ state: 'working', last_activity: '2026-11-18T10:00:00Z' }], [{ nodeId: 'n', phase: 'pr', ci: 'manual' }])],
      0,
      now,
    );
    expect(s.idle).toBe(true);
  });

  it('no fresh host = unknown, not idle; a stale host is ignored', () => {
    expect(fleetIdleState([], 0, now)).toMatchObject({ idle: false, hostsReporting: 0 });
    expect(fleetIdleState([host([{ state: 'working' }], [], '2026-11-18T08:00:00Z')], 0, now)).toMatchObject({ idle: false, hostsReporting: 0 });
  });
});

const row = (id: string, over: Partial<AskRow['ask']> = {}, status: AskRow['status'] = 'open'): AskRow => ({
  ask: {
    id, ticket: null, requirement: null, title: `T ${id}`, url: null, sources: [], question: 'Q?', question_author: null, options: [],
    answerer: 'Dan', hint: 'decision', priority: null, milestone: null, needs_version: false, idle_hours: null, moot: false,
    unblocks: { node_id: null, node_title: null, node_status: null, claimed_by: null, worker: null, pr: null, pr_state: null },
    ...over,
  },
  mapId: 'm1', status, pushedAt: '2026-11-18T00:00:00Z', firstSeenAt: '2026-11-17T00:00:00Z',
  answer: null, answeredBy: null, answeredAt: null, writes: [], workerPending: false,
});

describe('waitingItemsFromAsks', () => {
  it('open decisions and ops-tasks count; moot, stale, answered and other hints do not', () => {
    const items = waitingItemsFromAsks([
      row('a'),
      row('b', { hint: 'ops-task', answerer: 'Rita' }),
      row('c', { moot: true }),
      row('d', { stale: true }),
      row('e', { hint: 'waiting-external' }),
      row('f', {}, 'answered'),
    ]);
    expect(items.map((i) => [i.ref, i.kind, i.person])).toEqual([['a', 'decision', 'Dan'], ['b', 'step', 'Rita']]);
  });
});

describe('summarizeWaiting', () => {
  const it_ = (kind: WaitingItem['kind'], person: string, ref: string, nodeId: string | null, since: string): WaitingItem => ({
    kind, person, ref, title: ref, mapId: 'm1', nodeId, since, url: null,
  });

  it('counts per person, keeps the oldest 3 of each kind, counts distinct tickets unblocked', () => {
    const { people, total } = summarizeWaiting([
      it_('decision', 'Dan', 'd1', 'n1', '2026-11-10T00:00:00Z'),
      it_('decision', 'Dan', 'd2', 'n1', '2026-11-01T00:00:00Z'),
      it_('decision', 'Dan', 'd3', 'n2', '2026-11-05T00:00:00Z'),
      it_('decision', 'Dan', 'd4', null, '2026-11-02T00:00:00Z'),
      it_('step', 'Dan', 's1', 'n3', '2026-11-03T00:00:00Z'),
      it_('pr', 'Rita', 'acme/app#4', 'n4', '2026-11-04T00:00:00Z'),
      it_('approval', 'Rita', 'n5', 'n5', '2026-11-04T00:00:00Z'),
    ]);
    expect(people.map((p) => [p.person, p.decisions, p.steps, p.prs, p.approvals, p.unblocks])).toEqual([
      ['Dan', 4, 1, 0, 0, 4],
      ['Rita', 0, 0, 1, 1, 2],
    ]);
    expect(people[0].top.decisions.map((i) => i.ref)).toEqual(['d2', 'd4', 'd3']);
    expect(total).toEqual({ decisions: 4, steps: 1, prs: 1, approvals: 1, unblocks: 6 });
  });

  it('ownerPerson: the owner\'s first name, else Dan', () => {
    expect(ownerPerson('Rita Muster')).toBe('Rita');
    expect(ownerPerson('  ')).toBe('Dan');
    expect(ownerPerson(null)).toBe('Dan');
  });
});

describe('waitingAlertDue', () => {
  const c = (decisions: number) => ({ decisions, steps: 0, prs: 0, approvals: 0 });
  const later = (ms: number) => new Date(now.getTime() + ms);

  it('fires on the first idle stretch with something waiting; never while working or with nothing waiting', () => {
    expect(waitingAlertDue(undefined, true, c(2), now)).toBe(true);
    expect(waitingAlertDue(undefined, false, c(2), now)).toBe(false);
    expect(waitingAlertDue(undefined, true, c(0), now)).toBe(false);
  });

  it('once per idle stretch, again when the counts grow — at most once per 2 h', () => {
    const sent = { sentAt: now.toISOString(), counts: c(2), notifiedThisIdle: true };
    expect(waitingAlertDue(sent, true, c(2), later(3 * 3_600_000))).toBe(false); // same counts
    expect(waitingAlertDue(sent, true, c(3), later(3_600_000))).toBe(false); // grew, but throttled
    expect(waitingAlertDue(sent, true, c(3), later(WAITING_ALERT_THROTTLE_MS))).toBe(true);
    expect(waitingAlertDue(sent, true, c(1), later(WAITING_ALERT_THROTTLE_MS))).toBe(false); // shrank
    // A new idle stretch is news — after the throttle.
    const reset = { ...sent, notifiedThisIdle: false };
    expect(waitingAlertDue(reset, true, c(2), later(3_600_000))).toBe(false);
    expect(waitingAlertDue(reset, true, c(2), later(WAITING_ALERT_THROTTLE_MS))).toBe(true);
  });
});
