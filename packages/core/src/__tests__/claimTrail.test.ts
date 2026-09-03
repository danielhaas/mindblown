import { describe, it, expect } from 'vitest';
import {
  parseSession,
  heldMinutes,
  buildClaimedEvent,
  buildReleasedEvent,
  describeClaimEvent,
  formatHeld,
  claimTrail,
  claimTrailSummary,
  CLAIM_EVENT_TYPES,
} from '../claimTrail.js';
import type { ChangeEventLike } from '../claimTrail.js';

const T0 = '2026-09-03T08:00:00.000Z';
const T1 = '2026-09-03T08:42:00.000Z';
const T2 = '2026-09-03T09:10:00.000Z';

function ev(eventType: string, newValue: unknown, createdAt: string): ChangeEventLike {
  return { eventType, fieldName: null, oldValue: null, newValue, createdAt, userId: null };
}

describe('parseSession', () => {
  it('splits the fleet convention host:worker-N:profile', () => {
    expect(parseSession('njoerd:worker-3:default')).toEqual({ host: 'njoerd', worker: 'worker-3', profile: 'default' });
  });
  it('tolerates a missing profile', () => {
    expect(parseSession('claudia:worker-12')).toEqual({ host: 'claudia', worker: 'worker-12', profile: null });
    expect(parseSession('claudia:worker-12:')).toEqual({ host: 'claudia', worker: 'worker-12', profile: null });
  });
  it('yields nulls for anything else so the caller keeps the raw string', () => {
    expect(parseSession('jenna-pm')).toEqual({ host: null, worker: null, profile: null });
    expect(parseSession('a:b:c:d')).toEqual({ host: null, worker: null, profile: null });
    expect(parseSession(':worker-1:x')).toEqual({ host: null, worker: null, profile: null });
    expect(parseSession('')).toEqual({ host: null, worker: null, profile: null });
  });
});

describe('heldMinutes / formatHeld', () => {
  it('rounds to whole minutes, never negative, null when unknown', () => {
    expect(heldMinutes(T0, new Date(T1))).toBe(42);
    expect(heldMinutes(T1, new Date(T0))).toBe(0);
    expect(heldMinutes(null, new Date(T1))).toBeNull();
    expect(heldMinutes('not a date', new Date(T1))).toBeNull();
  });
  it('formats minutes, hours, days', () => {
    expect(formatHeld(42)).toBe('42 min');
    expect(formatHeld(90)).toBe('1.5 h');
    expect(formatHeld(120)).toBe('2 h');
    expect(formatHeld(60 * 72)).toBe('3 d');
    expect(formatHeld(null)).toBeNull();
  });
});

describe('payload builders', () => {
  it('buildClaimedEvent carries the split session and the previous holder', () => {
    expect(buildClaimedEvent('njoerd:worker-3:default', 'pull', null)).toEqual({
      session: 'njoerd:worker-3:default',
      host: 'njoerd',
      worker: 'worker-3',
      profile: 'default',
      via: 'pull',
      previousSession: null,
    });
  });
  it('buildReleasedEvent computes heldMinutes from claimedAt', () => {
    const r = buildReleasedEvent('njoerd:worker-3:default', T0, 'done', null, new Date(T1));
    expect(r).toMatchObject({ reason: 'done', note: null, claimedAt: T0, heldMinutes: 42, worker: 'worker-3' });
    expect(buildReleasedEvent('x', null, 'release', 'gave up', new Date(T1)).heldMinutes).toBeNull();
  });
});

describe('describeClaimEvent', () => {
  it('renders the three event kinds and ignores everything else', () => {
    expect(describeClaimEvent(ev('node.claimed', buildClaimedEvent('njoerd:worker-3:default', 'pull', null), T0))).toBe(
      'picked up by worker-3 on njoerd (pull)',
    );
    expect(
      describeClaimEvent(ev('node.claimed', buildClaimedEvent('njoerd:worker-3:default', 'claim', 'claudia:worker-1:default'), T0)),
    ).toBe('picked up by worker-3 on njoerd (claim, taken over from worker-1 on claudia)');
    expect(describeClaimEvent(ev('node.released', buildReleasedEvent('njoerd:worker-3:default', T0, 'done', null, new Date(T1)), T1))).toBe(
      'released after 42 min — done',
    );
    expect(describeClaimEvent(ev('node.released', buildReleasedEvent('n:worker-3:d', T0, 'release', 'never started', new Date(T1)), T1))).toBe(
      'released after 42 min — never started',
    );
    expect(describeClaimEvent(ev('node.released', buildReleasedEvent('n:worker-3:d', null, 'stale_sweep', 'no activity for 4h', new Date(T1)), T1))).toBe(
      'released — stale claim swept: no activity for 4h',
    );
    expect(describeClaimEvent(ev('node.pr_merged', { prNumber: 123, repo: 'acme/crm', url: null, mergeCommitSha: 'abc', externalId: 'acme/crm#9', alreadyDone: true }, T2))).toBe(
      'PR #123 merged (acme/crm)',
    );
    expect(describeClaimEvent(ev('node.field_changed', { status: 'done' }, T2))).toBeNull();
    expect(describeClaimEvent(ev('node.claimed', 'garbage', T2))).toBeNull();
  });
  it('falls back to the raw session for a human claimant', () => {
    expect(describeClaimEvent(ev('node.claimed', buildClaimedEvent('jenna-pm', 'claim', null), T0))).toBe('picked up by jenna-pm (claim)');
  });
});

describe('claimTrail', () => {
  const events = [
    ev('node.pr_merged', { prNumber: 123, repo: 'acme/crm' }, T2),
    ev('node.field_changed', { status: 'done' }, T1),
    ev('node.released', buildReleasedEvent('njoerd:worker-3:default', T0, 'done', null, new Date(T1)), T1),
    ev('node.claimed', buildClaimedEvent('njoerd:worker-3:default', 'pull', null), T0),
  ];

  it('orders ascending, drops non-claim rows, appends the done marker from the node', () => {
    const trail = claimTrail(events, { completedAt: T1, actualEffort: 1.5 });
    expect(trail.map((t) => t.kind)).toEqual(['claimed', 'released', 'done', 'delivered']);
    expect(trail.map((t) => t.text)).toEqual([
      'picked up by worker-3 on njoerd (pull)',
      'released after 42 min — done',
      'done · actual 1.5',
      'PR #123 merged (acme/crm)',
    ]);
    expect(trail[0].session).toBe('njoerd:worker-3:default');
    expect(trail[3].session).toBeNull();
  });
  it('has no done marker without completedAt', () => {
    expect(claimTrail(events).some((t) => t.kind === 'done')).toBe(false);
    expect(claimTrail(events, { completedAt: null, actualEffort: null })).toHaveLength(3);
  });
  it('is empty for an empty history', () => {
    expect(claimTrail([])).toEqual([]);
  });
});

describe('claimTrailSummary', () => {
  it('reports the open holder and the last deliverer independently of claimedBySession', () => {
    const claimedA = ev('node.claimed', buildClaimedEvent('njoerd:worker-3:default', 'pull', null), T0);
    const releasedA = ev('node.released', buildReleasedEvent('njoerd:worker-3:default', T0, 'done', null, new Date(T1)), T1);
    const claimedB = ev('node.claimed', buildClaimedEvent('claudia:worker-1:default', 'claim', null), T2);
    expect(claimTrailSummary([claimedA])).toEqual({ currentHolder: 'njoerd:worker-3:default', lastDeliveredBy: null });
    expect(claimTrailSummary([releasedA, claimedA])).toEqual({ currentHolder: null, lastDeliveredBy: 'njoerd:worker-3:default' });
    expect(claimTrailSummary([claimedB, releasedA, claimedA])).toEqual({
      currentHolder: 'claudia:worker-1:default',
      lastDeliveredBy: 'njoerd:worker-3:default',
    });
  });
  it('attributes a merge to the holder at the time even after a non-done release', () => {
    const claimed = ev('node.claimed', buildClaimedEvent('njoerd:worker-3:default', 'pull', null), T0);
    const released = ev('node.released', buildReleasedEvent('njoerd:worker-3:default', T0, 'release', 'PR open', new Date(T1)), T1);
    const merged = ev('node.pr_merged', { prNumber: 5 }, T2);
    expect(claimTrailSummary([claimed, released, merged]).lastDeliveredBy).toBe('njoerd:worker-3:default');
  });
  it('exposes the event types for callers building filters', () => {
    expect([...CLAIM_EVENT_TYPES]).toEqual(['node.claimed', 'node.released', 'node.pr_merged']);
  });
});
