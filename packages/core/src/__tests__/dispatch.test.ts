/**
 * Shared pull-queue predicates (core/dispatch.ts).
 *
 * These back both the server's get_next_ticket fence and the cockpit's
 * Dispatch card, so the semantics pinned here are the ones a PM reads off
 * the screen: version gates match the INHERITED version, unknown gate
 * entries empty the queue, and the state word follows the server's
 * refusal order (hold → full → empty → running).
 */
import { describe, it, expect } from 'vitest';
import type { Node, StatusDef } from '../types.js';
import {
  parseGateEntry,
  matchesDispatchGate,
  pullableNodes,
  dispatchQueueSnapshot,
  hasBrief,
  isBugNode,
  planUnblock,
  NEEDS_BRIEF_TAG,
} from '../dispatch.js';

function n(p: Partial<Node> & { id: string }): Node {
  return {
    mapId: 'm',
    parentId: 'root',
    childrenIds: [],
    text: p.id,
    description: null,
    effortEstimate: null,
    status: null,
    blockedReason: null,
    tags: [],
    dependencies: [],
    versionId: null,
    claimedBySession: null,
    claimedAt: null,
    // A linked issue = a brief; tests that need a briefless ticket pass externalLinks: [].
    externalLinks: [{ provider: 'github', externalId: `#${p.id}`, url: 'https://github.com/o/r/issues/1' }],
    ...p,
  } as unknown as Node;
}

const WORKFLOW: StatusDef[] = [
  { id: 'todo', name: 'To do', category: 'todo', color: '#000', position: 0 },
  { id: 'in_progress', name: 'Doing', category: 'in_progress', color: '#000', position: 1 },
  { id: 'blocked', name: 'Blocked', category: 'in_progress', color: '#000', position: 2 },
  { id: 'done', name: 'Done', category: 'done', color: '#000', position: 3 },
];

const root = n({ id: 'root', parentId: null, childrenIds: ['epic', 'bug', 'loose'] });
// Note: the server does NOT exclude parents from the pullable set — a
// status-less epic would be pullable too. Give it a non-todo status so the
// fixtures below read as leaves-only.
const epic = n({ id: 'epic', versionId: 'v1', childrenIds: ['leaf'], status: 'in_progress' });
const leaf = n({ id: 'leaf', parentId: 'epic', status: 'todo' });
const bug = n({ id: 'bug', status: 'todo', tags: ['Bug'] });
const loose = n({ id: 'loose', status: 'todo' });

describe('parseGateEntry', () => {
  it('classifies the two known shapes and flags the rest', () => {
    expect(parseGateEntry('type:bug')).toEqual({ kind: 'bugs', raw: 'type:bug' });
    expect(parseGateEntry('version:v1')).toEqual({ kind: 'version', raw: 'version:v1', versionId: 'v1' });
    expect(parseGateEntry('version:').kind).toBe('unknown');
    expect(parseGateEntry('priority:P0').kind).toBe('unknown');
  });
});

describe('isBugNode', () => {
  it('accepts "bug" and the GitHub-mirror spelling "type:bug", case-insensitive', () => {
    expect(isBugNode(n({ id: 'a', tags: ['bug'] }))).toBe(true);
    expect(isBugNode(n({ id: 'b', tags: ['type:bug'] }))).toBe(true);
    expect(isBugNode(n({ id: 'c', tags: ['Bug'] }))).toBe(true);
    expect(isBugNode(n({ id: 'd', tags: ['Type:Bug'] }))).toBe(true);
    expect(isBugNode(n({ id: 'e', tags: ['ui', 'type:bug'] }))).toBe(true);
  });

  it('does not match lookalike tags (exact match only)', () => {
    expect(isBugNode(n({ id: 'f', tags: [] }))).toBe(false);
    expect(isBugNode(n({ id: 'g', tags: ['debug'] }))).toBe(false);
    expect(isBugNode(n({ id: 'h', tags: ['bugfix'] }))).toBe(false);
    expect(isBugNode(n({ id: 'i', tags: ['type:bugfix'] }))).toBe(false);
    expect(isBugNode(n({ id: 'j', tags: ['type:tech-debt'] }))).toBe(false);
  });
});

describe('matchesDispatchGate', () => {
  const map = new Map([root, epic, leaf, bug, loose].map((x) => [x.id, x]));

  it('matches the inherited version, not only node.versionId', () => {
    expect(leaf.versionId).toBeNull();
    expect(matchesDispatchGate(leaf, ['version:v1'], map)).toBe(true);
    expect(matchesDispatchGate(loose, ['version:v1'], map)).toBe(false);
  });

  it('bug tag is case-insensitive and ANDs with a version entry', () => {
    expect(matchesDispatchGate(bug, ['type:bug'], map)).toBe(true);
    expect(matchesDispatchGate(bug, ['type:bug', 'version:v1'], map)).toBe(false);
  });

  it('a GitHub-mirrored "type:bug" tag passes the type:bug gate', () => {
    const mirrored = n({ id: 'mirrored', status: 'todo', tags: ['type:bug'] });
    expect(matchesDispatchGate(mirrored, ['type:bug'], map)).toBe(true);
  });

  it('empty gate is open; an unknown entry matches nothing (fail-closed)', () => {
    expect(matchesDispatchGate(loose, [], map)).toBe(true);
    expect(matchesDispatchGate(loose, ['priority:P0'], map)).toBe(false);
  });
});

describe('pullableNodes', () => {
  it('excludes the root, claimed nodes, non-todo statuses and blocked predecessors', () => {
    const claimed = n({ id: 'claimed', status: 'todo', claimedBySession: 's1' });
    const blocked = n({ id: 'blocked', status: 'blocked' });
    const waiting = n({ id: 'waiting', status: 'todo', dependencies: [{ targetNodeId: 'loose', type: 'FS' }] as never });
    const { pullable } = pullableNodes([root, epic, leaf, bug, loose, claimed, blocked, waiting], WORKFLOW);
    expect(pullable.map((x) => x.id).sort()).toEqual(['bug', 'leaf', 'loose']);
  });
});

describe('dispatchQueueSnapshot', () => {
  const all = [root, epic, leaf, bug, loose];

  it('hold beats everything when cap is 0', () => {
    const s = dispatchQueueSnapshot(all, { workflow: WORKFLOW, cap: 0, gate: [] });
    expect(s.state).toBe('hold');
    expect(s.pullable).toBe(3);
    expect(s.inGate).toBe(3);
  });

  it('full when active claims reach the cap', () => {
    const c1 = n({ id: 'c1', status: 'in_progress', claimedBySession: 'a' });
    const c2 = n({ id: 'c2', status: 'in_progress', claimedBySession: 'b' });
    const s = dispatchQueueSnapshot([...all, c1, c2], { workflow: WORKFLOW, cap: 2, gate: [] });
    expect(s.activeClaims).toBe(2);
    expect(s.state).toBe('full');
  });

  it('empty when the gate leaves nothing, and names an unknown entry as the cause', () => {
    const s = dispatchQueueSnapshot(all, { workflow: WORKFLOW, cap: 6, gate: ['version:nope'] });
    expect(s.state).toBe('empty');
    expect(s.inGate).toBe(0);
    expect(s.unknownGateEntries).toEqual([]);
    const typo = dispatchQueueSnapshot(all, { workflow: WORKFLOW, cap: 6, gate: ['verison:v1'] });
    expect(typo.state).toBe('empty');
    expect(typo.unknownGateEntries).toEqual(['verison:v1']);
  });

  it('counts what the gate hides: unversioned pullable tickets under a version gate', () => {
    const s = dispatchQueueSnapshot(all, { workflow: WORKFLOW, cap: 6, gate: ['version:v1'] });
    expect(s.state).toBe('running');
    expect(s.inGate).toBe(1);
    expect(s.inGateIds).toEqual(['leaf']);
    // bug + loose have no effective version → invisible to the fleet
    expect(s.unversionedOutsideGate).toBe(2);
    // No version gate → nothing is "hidden by the version fence"
    expect(dispatchQueueSnapshot(all, { workflow: WORKFLOW, cap: 6, gate: ['type:bug'] }).unversionedOutsideGate).toBe(0);
  });

  it('needs-brief is the PREDICATE (no description, no link), not the tag; briefless tickets are not grantable', () => {
    // Tagged on an earlier pull, but has a brief now → not counted.
    const tagged = n({ id: 'tagged', status: 'todo', tags: [NEEDS_BRIEF_TAG], effortEstimate: 2 });
    // Never pulled, no brief → counted, and excluded from inGate.
    const briefless = n({ id: 'briefless', status: 'todo', externalLinks: [], description: null });
    const s = dispatchQueueSnapshot([...all, tagged, briefless], { workflow: WORKFLOW, cap: 6, gate: [] });
    expect(s.needsBrief).toBe(1);
    expect(s.inGateIds).not.toContain('briefless');
    expect(s.inGateIds).toContain('tagged');
    expect(s.unestimated).toBe(3); // leaf, bug, loose — tagged is estimated, briefless is not grantable
    const gated = dispatchQueueSnapshot([...all, tagged, briefless], { workflow: WORKFLOW, cap: 6, gate: ['version:v1'] });
    expect(gated.needsBrief).toBe(0);
    expect(gated.unestimated).toBe(1);
  });

  it('a description counts as a brief; an all-briefless gate is "empty" with needsBrief set', () => {
    const described = n({ id: 'described', status: 'todo', externalLinks: [], description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'do it' }] }] } as never });
    const bare = n({ id: 'bare', status: 'todo', externalLinks: [] });
    expect(hasBrief(described)).toBe(true);
    expect(hasBrief(bare)).toBe(false);
    const s = dispatchQueueSnapshot([root, bare], { workflow: WORKFLOW, cap: 6, gate: [] });
    expect(s.state).toBe('empty');
    expect(s.needsBrief).toBe(1);
    expect(s.pullable).toBe(1);
  });
});

describe('planUnblock', () => {
  it("undoes the fleet's give-up: blocked (not a workflow status) → first todo, tag removed", () => {
    expect(planUnblock({ status: 'blocked', tags: ['app:fm', 'blocked'] }, WORKFLOW)).toEqual({ status: 'todo', tagsRemove: ['blocked'] });
  });

  it('re-queues in_progress (the worker is gone) and leaves the tag list alone when there is no blocked tag', () => {
    expect(planUnblock({ status: 'in_progress', tags: ['bug'] }, WORKFLOW)).toEqual({ status: 'todo', tagsRemove: [] });
  });

  it('never re-opens done work; matches status by name case-insensitively', () => {
    expect(planUnblock({ status: 'done', tags: ['blocked'] }, WORKFLOW)).toEqual({ tagsRemove: ['blocked'] });
    expect(planUnblock({ status: 'DONE', tags: [] }, WORKFLOW)).toEqual({ tagsRemove: [] });
  });

  it('is a status no-op when already todo / null, and falls back to null without a todo status', () => {
    expect(planUnblock({ status: 'todo', tags: ['blocked'] }, WORKFLOW)).toEqual({ tagsRemove: ['blocked'] });
    expect(planUnblock({ status: null, tags: [] }, WORKFLOW)).toEqual({ status: 'todo', tagsRemove: [] });
    const noTodo = WORKFLOW.filter((s) => s.category !== 'todo');
    expect(planUnblock({ status: 'blocked', tags: [] }, noTodo)).toEqual({ status: null, tagsRemove: [] });
    expect(planUnblock({ status: null, tags: [] }, noTodo)).toEqual({ tagsRemove: [] });
  });
});
