import { describe, it, expect } from 'vitest';
import { findStalled, isStalledCandidate, describeStalled, STALLED_AFTER_HOURS, type StalledNodeLike, type StalledActivity } from '../stalled.js';
import type { StatusDef } from '../types.js';

const workflow: StatusDef[] = [
  { id: 'todo', name: 'Todo', category: 'todo', color: '#94a3b8', position: 0 },
  { id: 'wip', name: 'In Progress', category: 'in_progress', color: '#3b82f6', position: 1 },
  { id: 'done', name: 'Done', category: 'done', color: '#10b981', position: 2 },
];

const now = new Date('2026-10-18T12:00:00Z');
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();

function node(id: string, over: Partial<StalledNodeLike> = {}): StalledNodeLike {
  return {
    id,
    childrenIds: [],
    status: 'wip',
    percentComplete: 25,
    claimedBySession: null,
    blockedReason: null,
    tags: [],
    updatedAt: hoursAgo(1),
    ...over,
  };
}

// The worker-died shape: claimed, then released by orphan recovery 9 h ago,
// nothing since. The release is the node's latest change_event.
const released = { session: 'host-a/worker-3', releasedAt: hoursAgo(9), reason: 'release' };
function activity(lastChange: Record<string, string>, releases: Record<string, typeof released> = {}): StalledActivity {
  return { lastChangeAt: new Map(Object.entries(lastChange)), lastRelease: new Map(Object.entries(releases)) };
}

describe('findStalled', () => {
  it('a released-but-in-progress node is stalled once the threshold has passed', () => {
    const out = findStalled([node('dead')], workflow, activity({ dead: hoursAgo(9) }, { dead: released }), now);
    expect(out).toEqual([{ nodeId: 'dead', percentComplete: 25, lastChangeAt: hoursAgo(9), lastRelease: released }]);
  });

  it('not before the threshold', () => {
    const justReleased = activity({ dead: hoursAgo(STALLED_AFTER_HOURS - 0.5) }, { dead: released });
    expect(findStalled([node('dead')], workflow, justReleased, now)).toEqual([]);
  });

  it('a claimed node is not stalled, however old its last change', () => {
    expect(findStalled([node('c', { claimedBySession: 'host-a/worker-1' })], workflow, activity({ c: hoursAgo(30) }), now)).toEqual([]);
  });

  it('a recently changed node is not stalled', () => {
    expect(findStalled([node('r')], workflow, activity({ r: hoursAgo(1) }), now)).toEqual([]);
  });

  it('a blocked node is not stalled — reason, blocked tag or blocked status', () => {
    const old = activity({ a: hoursAgo(30), b: hoursAgo(30), c: hoursAgo(30) });
    const nodes = [
      node('a', { blockedReason: 'waiting on a vendor' }),
      node('b', { tags: ['blocked'] }),
      node('c', { status: 'blocked' }),
    ];
    expect(findStalled(nodes, workflow, old, now)).toEqual([]);
  });

  it('a done node is not stalled — done status or 100 %', () => {
    const old = activity({ a: hoursAgo(30), b: hoursAgo(30) });
    expect(findStalled([node('a', { status: 'done' }), node('b', { status: 'wip', percentComplete: 100 })], workflow, old, now)).toEqual([]);
  });

  it('a todo status is queued, not stalled, at any %; parents are not candidates; no status with progress is', () => {
    expect(isStalledCandidate(node('t', { status: 'todo', percentComplete: 0 }), workflow)).toBe(false);
    expect(isStalledCandidate(node('r', { status: 'todo', percentComplete: 25 }), workflow)).toBe(false);
    expect(isStalledCandidate(node('p', { childrenIds: ['x'] }), workflow)).toBe(false);
    expect(isStalledCandidate(node('t', { status: null, percentComplete: 40 }), workflow)).toBe(true);
    expect(isStalledCandidate(node('n', { status: 'In Progress', percentComplete: 0 }), workflow)).toBe(true);
  });

  it('falls back to updatedAt when the change log has nothing on the node', () => {
    const out = findStalled([node('old', { updatedAt: hoursAgo(5) })], workflow, activity({}), now);
    expect(out.map((s) => [s.nodeId, s.lastChangeAt, s.lastRelease])).toEqual([['old', hoursAgo(5), null]]);
  });

  it('longest idle first', () => {
    const out = findStalled([node('a'), node('b')], workflow, activity({ a: hoursAgo(3), b: hoursAgo(20) }), now);
    expect(out.map((s) => s.nodeId)).toEqual(['b', 'a']);
  });
});

describe('describeStalled', () => {
  it('names progress, idle time and the last claim holder', () => {
    const [s] = findStalled([node('dead')], workflow, activity({ dead: hoursAgo(9) }, { dead: released }), now);
    expect(describeStalled(s, now)).toBe('25 %, no change for 9 h, released by host-a/worker-3 9 h ago (release)');
  });

  it('says so when nobody ever claimed it', () => {
    const [s] = findStalled([node('x')], workflow, activity({ x: hoursAgo(72) }), now);
    expect(describeStalled(s, now)).toBe('25 %, no change for 3 d, never claimed');
  });
});
