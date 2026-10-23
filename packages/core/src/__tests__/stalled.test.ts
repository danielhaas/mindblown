import { describe, it, expect } from 'vitest';
import {
  findStalled,
  isStalledCandidate,
  describeStalled,
  STALLED_AFTER_HOURS,
  STALLED_ASK_AFTER_HOURS,
  isStalledAskDue,
  stalledAskAfterHours,
  buildStalledAsk,
  stalledAskNodeId,
  stalledAnswerAction,
  stalledAnswerNote,
  type StalledNodeLike,
  type StalledActivity,
} from '../stalled.js';
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

  it('a node tagged for a person (needs-human, kira-skip …) is not stalled — someone already decided', () => {
    const old = activity({ a: hoursAgo(30), b: hoursAgo(30) });
    expect(findStalled([node('a', { tags: ['needs-human'] }), node('b', { tags: ['Kira-Skip'] })], workflow, old, now)).toEqual([]);
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

describe('stalled asks', () => {
  const [s] = findStalled([node('dead')], workflow, activity({ dead: hoursAgo(30) }, { dead: released }), now);

  it('are due after a day without a change, not before', () => {
    expect(isStalledAskDue(s, now)).toBe(true);
    const [fresh] = findStalled([node('f')], workflow, activity({ f: hoursAgo(STALLED_ASK_AFTER_HOURS - 1) }), now);
    expect(isStalledAskDue(fresh, now)).toBe(false);
  });

  it('a decision ticket is due once it is stalled', () => {
    const [two] = findStalled([node('d')], workflow, activity({ d: hoursAgo(STALLED_AFTER_HOURS) }), now);
    expect(isStalledAskDue(two, now, 'Decision: STP participation')).toBe(true);
    expect(isStalledAskDue(two, now, '  entscheid: Lizenz')).toBe(true);
    expect(isStalledAskDue(two, now, 'Implement the decision log')).toBe(false);
    expect(stalledAskAfterHours('Decision: x')).toBe(STALLED_AFTER_HOURS);
    expect(stalledAskAfterHours('Signed reports')).toBe(STALLED_ASK_AFTER_HOURS);
  });

  it('ask about the node with three answers, the issue link and the last holder', () => {
    const link = { provider: 'github', externalId: 'o/r#5', url: 'https://github.com/o/r/issues/5', syncEnabled: true, lastSyncedAt: null };
    const ask = buildStalledAsk({ id: 'dead', text: 'Nicknames', priority: 'P3', externalLinks: [link] }, s, 'map-1', now);
    expect(ask.id).toBe('stalled-dead');
    expect(stalledAskNodeId(ask.id)).toBe('dead');
    expect(ask).toMatchObject({
      map_id: 'map-1',
      ticket: null,
      title: 'Nicknames',
      url: 'https://github.com/o/r/issues/5',
      options: ['Done', 'Back to the queue', 'For a person'],
      answerer: 'Dan',
      hint: 'decision',
      priority: 'P3',
      idle_hours: 30,
      unblocks: { node_id: 'dead', node_status: 'stalled', worker: 'host-a/worker-3' },
    });
    expect(ask.question).toContain('25 %, no change for 30 h');
  });

  it('map an answer to its fix; free text is a person\'s next step and kept as the note', () => {
    expect(stalledAnswerAction('Done')).toBe('mark-done');
    expect(stalledAnswerAction('back to the queue')).toBe('requeue');
    expect(stalledAnswerAction('For a person')).toBe('needs-human');
    expect(stalledAnswerAction('run the import on prod first')).toBe('needs-human');
    expect(stalledAnswerNote('For a person')).toBeNull();
    expect(stalledAnswerNote('run the import on prod first')).toBe('run the import on prod first');
    expect(stalledAskNodeId('#6823')).toBeNull();
    expect(stalledAskNodeId('stalled-')).toBeNull();
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
