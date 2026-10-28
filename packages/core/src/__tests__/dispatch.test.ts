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
  gateVersionIds,
  parseMixBugs,
  matchesDispatchGate,
  pullableNodes,
  dispatchQueueSnapshot,
  hasBrief,
  isBugNode,
  planUnblock,
  MIX_BUGS_PREFIX,
  NEEDS_BRIEF_TAG,
} from '../dispatch.js';

const APPROVED = { state: 'approved', merge: 'auto', by: null, at: '2026-10-28T00:00:00.000Z' } as const;

function n(p: Partial<Node> & { id: string }): Node {
  return {
    approval: APPROVED,
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
// A parent is never pullable (leaves only); `epic` is in_progress besides.
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

  it('reads "|" as any-of its terms; one unreadable term makes the whole entry unknown (#265)', () => {
    expect(parseGateEntry('type:bug|version:v1')).toEqual({
      kind: 'any',
      raw: 'type:bug|version:v1',
      options: [
        { kind: 'bugs', raw: 'type:bug' },
        { kind: 'version', raw: 'version:v1', versionId: 'v1' },
      ],
    });
    expect(parseGateEntry('type:bug|priority:P0').kind).toBe('unknown');
    expect(parseGateEntry('type:bug|').kind).toBe('unknown');
    expect(gateVersionIds(['type:bug|version:v1', 'version:v2', 'type:bug'])).toEqual(['v1', 'v2']);
  });
});

describe('parseMixBugs', () => {
  it('parses the full 0–100 range, anywhere in the policy', () => {
    expect(parseMixBugs(['mix:bugs=0'])).toEqual({ ratio: 0 });
    expect(parseMixBugs(['priority', 'mix:bugs=40', 'age'])).toEqual({ ratio: 40 });
    expect(parseMixBugs(['mix:bugs=100'])).toEqual({ ratio: 100 });
    expect(MIX_BUGS_PREFIX).toBe('mix:bugs=');
  });

  it('returns the FIRST valid entry; invalid ones are skipped over', () => {
    expect(parseMixBugs(['mix:bugs=30', 'mix:bugs=70'])).toEqual({ ratio: 30 });
    expect(parseMixBugs(['mix:bugs=101', 'mix:bugs=25'])).toEqual({ ratio: 25 });
  });

  it('treats invalid shapes as absent — unknown-key semantics', () => {
    for (const bad of [
      'mix:bugs=101',
      'mix:bugs=-1',
      'mix:bugs=x',
      'mix:bugs=',
      'mix:bugs=040',
      'mix:bugs=4.5',
      'MIX:BUGS=40',
      'mix:bugs= 40',
      'mix:bugs=40 ',
    ]) {
      expect(parseMixBugs([bad]), bad).toBeNull();
    }
    expect(parseMixBugs([])).toBeNull();
    expect(parseMixBugs(['bugs', 'priority', 'size', 'age'])).toBeNull();
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

  it('"bugs or the release" admits both sets and nothing else (#265)', () => {
    const gate = ['type:bug|version:v1'];
    expect(matchesDispatchGate(bug, gate, map)).toBe(true); // a bug outside the release
    expect(matchesDispatchGate(leaf, gate, map)).toBe(true); // release work, not a bug
    expect(matchesDispatchGate(loose, gate, map)).toBe(false); // neither — the fence holds
    expect(matchesDispatchGate(loose, ['type:bug|priority:P0'], map)).toBe(false); // fail-closed
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

  it('never yields a container — no epic tag, no "Epic:" title, its children are the work', () => {
    // "Phase 2.5: Make it fun" (25.10.2026): a todo parent was handed out,
    // its worker's blocker then held all ten children.
    const phase = n({ id: 'phase', parentId: 'root', text: 'Phase 2.5: Make it fun', status: 'todo' });
    const c1 = n({ id: 'c1', parentId: 'phase', status: 'todo' });
    const c2 = n({ id: 'c2', parentId: 'phase', status: null });
    const { pullable } = pullableNodes([root, phase, c1, c2], WORKFLOW);
    expect(pullable.map((x) => x.id).sort()).toEqual(['c1', 'c2']);
    // A child missing from the list (deleted) does not keep its parent a container.
    expect(pullableNodes([root, phase], WORKFLOW).pullable.map((x) => x.id)).toEqual(['phase']);
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

  it('a claimed ticket with the worker\'s PR wait note does not count toward full', () => {
    const c1 = n({ id: 'c1', status: 'in_progress', claimedBySession: 'a' });
    const c2 = n({ id: 'c2', status: 'in_progress', claimedBySession: 'b', blockedReason: 'Fleet worker b: CI failed on PR #3 (abc).' });
    const s = dispatchQueueSnapshot([...all, c1, c2], { workflow: WORKFLOW, cap: 2, gate: [] });
    expect(s.activeClaims).toBe(1);
    expect(s.state).toBe('running');
  });

  it('an "or" gate counts both sides in the gate, and only the rest as outside (#265)', () => {
    const or = dispatchQueueSnapshot(all, { workflow: WORKFLOW, cap: 6, gate: ['type:bug|version:v1'] });
    expect(or.inGateIds.sort()).toEqual(['bug', 'leaf']);
    expect(or.unversionedOutsideGate).toBe(1); // loose — the unversioned bug is inside
    const plain = dispatchQueueSnapshot(all, { workflow: WORKFLOW, cap: 6, gate: ['version:v1'] });
    expect(plain.unversionedOutsideGate).toBe(2);
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

  it('an ?omit=description,externalLinks payload is UNSAFE input for hasBrief/dispatchQueueSnapshot', () => {
    // Mirrors the server's omit handling verbatim (packages/server/src/
    // routes/maps.ts GET /api/maps/:id): `delete node[f]` per omitted
    // field — the fields are ABSENT, not null/undefined defaults.
    const stripped = n({ id: 'stripped', status: 'todo' }) as unknown as Record<string, unknown>;
    delete stripped.description;
    delete stripped.externalLinks;

    expect(() => hasBrief(stripped as unknown as Node)).toThrow(TypeError);
    expect(() =>
      dispatchQueueSnapshot([root, stripped as unknown as Node], { workflow: WORKFLOW, cap: 6, gate: [] }),
    ).toThrow(TypeError);

    // This is the documented contract, not a bug to silence: a caller
    // that null-guards `externalLinks ?? []` instead of fetching an
    // un-stripped payload makes every gated ticket read as brief-less —
    // the queue then reports "Empty" forever while the server keeps
    // granting tickets, a control surface that lies about what it
    // controls (found in PR #356 review, mobile Fleet tab). Any consumer
    // of an omit-stripped map (e.g. `MobileFleetView.tsx` in
    // `@mindblown/mindmap`) MUST fetch its own un-stripped nodes before
    // calling `dispatchQueueSnapshot` — this test is the tripwire for the
    // next such consumer.
  });
});

describe('planUnblock', () => {
  const u = (p: { status: string | null; tags: string[]; claimedBySession?: string | null }, wf = WORKFLOW) =>
    planUnblock({ claimedBySession: null, ...p }, wf);

  it("undoes the fleet's give-up: blocked (not a workflow status) → first todo, tag removed", () => {
    expect(u({ status: 'blocked', tags: ['app:fm', 'blocked'] })).toEqual({ status: 'todo', tagsRemove: ['blocked'] });
  });

  it('re-queues in_progress (the worker is gone) and leaves the tag list alone when there is no blocked tag', () => {
    expect(u({ status: 'in_progress', tags: ['bug'] })).toEqual({ status: 'todo', tagsRemove: [] });
  });

  it('never re-opens done work; matches status by name case-insensitively', () => {
    expect(u({ status: 'done', tags: ['blocked'] })).toEqual({ tagsRemove: ['blocked'] });
    expect(u({ status: 'DONE', tags: [] })).toEqual({ tagsRemove: [] });
  });

  it('leaves a still-claimed node alone (not pullable anyway; never pull a ticket from under a worker)', () => {
    expect(u({ status: 'in_progress', tags: ['blocked'], claimedBySession: 'sat2:worker-1' })).toEqual({ tagsRemove: ['blocked'] });
    expect(u({ status: 'blocked', tags: [], claimedBySession: 'x' })).toEqual({ tagsRemove: [] });
  });

  it('does not guess for a status id the workflow does not know, other than blocked', () => {
    // e.g. a legacy `cancelled` on a map whose workflow lacks it
    expect(u({ status: 'cancelled', tags: ['blocked'] })).toEqual({ tagsRemove: ['blocked'] });
  });

  it('is a status no-op when already todo, normalises null, and falls back to null without a todo status', () => {
    expect(u({ status: 'todo', tags: ['blocked'] })).toEqual({ tagsRemove: ['blocked'] });
    expect(u({ status: null, tags: [] })).toEqual({ status: 'todo', tagsRemove: [] });
    const noTodo = WORKFLOW.filter((s) => s.category !== 'todo');
    expect(u({ status: 'blocked', tags: [] }, noTodo)).toEqual({ status: null, tagsRemove: [] });
    expect(u({ status: null, tags: [] }, noTodo)).toEqual({ tagsRemove: [] });
  });
});

describe('human-only tickets in the dispatch snapshot (#266)', () => {
  it('counted apart, never grantable; only human-only left reads as empty', async () => {
    const { dispatchQueueSnapshot, dispatchSkipTag } = await import('../dispatch.js');
    const node = (id: string, tags: string[]) =>
      ({ id, parentId: 'root', status: null, claimedBySession: null, approval: APPROVED, dependencies: [], tags, description: 'brief', externalLinks: [], versionId: null, effortEstimate: 1, childrenIds: [] }) as never;
    const root = { id: 'root', parentId: null, status: null, claimedBySession: null, approval: APPROVED, dependencies: [], tags: [], description: null, externalLinks: [], versionId: null, effortEstimate: null, childrenIds: ['a', 'b'] } as never;
    const snap = dispatchQueueSnapshot([root, node('a', ['needs-human']), node('b', ['kira-skip'])], { workflow: [], cap: 3, gate: [] });
    expect(snap).toMatchObject({ inGate: 0, humanOnly: 2, needsBrief: 0, state: 'empty' });
    expect(dispatchSkipTag({ tags: ['x', 'NEEDS-RITA-REVIEW'] })).toBe('NEEDS-RITA-REVIEW');
    expect(dispatchSkipTag({ tags: ['needs-brief'] })).toBeNull();
  });

  it('a manual blocker holds a ticket like a skip tag', async () => {
    const { dispatchQueueSnapshot, dispatchHold } = await import('../dispatch.js');
    const node = (id: string, blockedReason: string | null) =>
      ({ id, parentId: 'root', status: null, claimedBySession: null, approval: APPROVED, dependencies: [], tags: [], blockedReason, description: 'brief', externalLinks: [], versionId: null, effortEstimate: 1, childrenIds: [] }) as never;
    const root = { id: 'root', parentId: null, status: null, claimedBySession: null, approval: APPROVED, dependencies: [], tags: [], blockedReason: null, description: null, externalLinks: [], versionId: null, effortEstimate: null, childrenIds: ['a', 'b'] } as never;
    const snap = dispatchQueueSnapshot([root, node('a', 'Waiting on Dan'), node('b', null)], { workflow: [], cap: 3, gate: [] });
    expect(snap).toMatchObject({ inGate: 1, humanOnly: 1, inGateIds: ['b'], state: 'running' });
    const approval = APPROVED;
    expect(dispatchHold({ tags: [], blockedReason: 'x', approval })).toEqual({ tag: null, blockedReason: 'x', approval: null, heldBy: null });
    expect(dispatchHold({ tags: ['kira-skip'], blockedReason: null, approval })).toEqual({ tag: 'kira-skip', blockedReason: null, approval: null, heldBy: null });
    expect(dispatchHold({ tags: [], blockedReason: ' ', approval })).toBeNull();
  });

  it("an open ancestor's hold covers its subtree; a done ancestor's leftover text does not", async () => {
    const { dispatchQueueSnapshot, dispatchHold } = await import('../dispatch.js');
    const n = (id: string, parentId: string | null, extra: Record<string, unknown> = {}) =>
      ({ id, text: id, parentId, status: null, claimedBySession: null, approval: APPROVED, dependencies: [], tags: [], blockedReason: null, description: 'brief', externalLinks: [], versionId: null, effortEstimate: 1, childrenIds: [], ...extra }) as never;
    const workflow = [{ id: 'todo', name: 'Todo', category: 'todo' }, { id: 'done', name: 'Done', category: 'done' }] as never;
    const nodes = [
      n('root', null, { childrenIds: ['epic', 'old'] }),
      n('epic', 'root', { blockedReason: 'Waiting on Dan', childrenIds: ['mid'] }),
      n('mid', 'epic', { childrenIds: ['leaf'] }),
      n('leaf', 'mid'),
      n('old', 'root', { status: 'done', tags: ['needs-human'], childrenIds: ['fresh'] }),
      n('fresh', 'old'),
    ];
    const snap = dispatchQueueSnapshot(nodes, { workflow, cap: 3, gate: [] });
    expect(snap.inGateIds).toEqual(['fresh']);
    expect(snap.humanOnly).toBe(1); // leaf — epic and mid are containers, never pullable
    const nodeMap = new Map((nodes as { id: string }[]).map((x) => [x.id, x])) as never;
    const isDone = (st: string | null) => st === 'done';
    expect(dispatchHold(nodes[3] as never, { nodeMap, isDone })).toEqual({ tag: null, blockedReason: 'Waiting on Dan', approval: null, heldBy: { id: 'epic', text: 'epic' } });
    expect(dispatchHold(nodes[3] as never)).toBeNull(); // without ancestors only the ticket itself counts
  });

  it('an epic leaf is held under `epic`; an epic parent does not hold its sub-tickets', async () => {
    const { dispatchQueueSnapshot, dispatchHold, isEpicLeaf } = await import('../dispatch.js');
    const n = (id: string, text: string, parentId: string | null, extra: Record<string, unknown> = {}) =>
      ({ id, text, parentId, status: null, claimedBySession: null, approval: APPROVED, dependencies: [], tags: [], blockedReason: null, description: 'brief', externalLinks: [], versionId: null, effortEstimate: 1, childrenIds: [], ...extra }) as never;
    const nodes = [
      n('root', 'root', null, { childrenIds: ['e1', 'e2', 'e3', 'e4', 'big', 'repo'] }),
      n('e1', '#482 Epic: fleets as their own entity', 'root'),
      n('e2', '[EPIC] Source & Ingestion', 'root'),
      n('e3', 'Epic – billing', 'root'),
      n('e4', 'Rework sync', 'root', { tags: ['type:epic'] }),
      n('big', 'Epic: sprint automation', 'root', { childrenIds: ['sub'] }),
      n('sub', 'Rollover job', 'big'),
      n('repo', 'epic (danielhaas/epic) — Universal Triage Inbox', 'root'),
    ];
    const snap = dispatchQueueSnapshot(nodes, { workflow: [], cap: 5, gate: [] });
    expect([...snap.inGateIds].sort()).toEqual(['repo', 'sub']);
    // e1–e4; `big` has a child, so it is a container and not pullable at all.
    expect(snap.humanOnly).toBe(4);
    expect(dispatchHold(nodes[1] as never)).toEqual({ tag: 'epic', blockedReason: null, approval: null, heldBy: null });
    const nodeMap = new Map((nodes as { id: string }[]).map((x) => [x.id, x])) as never;
    expect(dispatchHold(nodes[6] as never, { nodeMap, isDone: () => false })).toBeNull();
    expect(isEpicLeaf({ text: 'Epics are fun', tags: [] })).toBe(false);
    expect(isEpicLeaf({ text: 'Fix the epic import', tags: ['EPIC'] })).toBe(true);
  });

  it('names the parents that hold tickets through their subtree, most first (the Navy audit umbrella)', async () => {
    const { dispatchQueueSnapshot, parentHolds } = await import('../dispatch.js');
    const n = (id: string, parentId: string | null, extra: Record<string, unknown> = {}) =>
      ({ id, text: id, parentId, status: null, claimedBySession: null, approval: APPROVED, dependencies: [], tags: [], blockedReason: null, description: 'brief', externalLinks: [], versionId: null, effortEstimate: 1, childrenIds: [], ...extra }) as never;
    const nodes = [
      n('root', null, { childrenIds: ['audit', 'epic', 'own'] }),
      n('audit', 'root', { tags: ['needs-human'], status: 'in_progress', childrenIds: ['f1', 'f2', 'f3'] }),
      n('f1', 'audit'),
      n('f2', 'audit'),
      n('f3', 'audit'),
      n('epic', 'root', { blockedReason: 'Waiting on Dan', status: 'in_progress', childrenIds: ['s1'] }),
      n('s1', 'epic'),
      n('own', 'root', { tags: ['needs-human'] }), // held by its own tag, not a parent
    ];
    const snap = dispatchQueueSnapshot(nodes, { workflow: [], cap: 3, gate: [] });
    expect(snap.heldByParents).toEqual([
      { id: 'audit', text: 'audit', tag: 'needs-human', blockedReason: null, approval: null, count: 3 },
      { id: 'epic', text: 'epic', tag: null, blockedReason: 'Waiting on Dan', approval: null, count: 1 },
    ]);
    const nodeMap = new Map((nodes as { id: string }[]).map((x) => [x.id, x])) as never;
    expect(parentHolds([nodes[2], nodes[7]] as never, { nodeMap, isDone: () => false }).map((h) => [h.id, h.count])).toEqual([['audit', 1]]);
  });

  it('the approval gate (#492): only an approved stamp runs; a proposed or rejected open parent holds its subtree', async () => {
    const { dispatchQueueSnapshot, dispatchHold } = await import('../dispatch.js');
    const proposed = { ...APPROVED, state: 'proposed' } as const;
    const rejected = { ...APPROVED, state: 'rejected' } as const;
    const n = (id: string, parentId: string | null, extra: Record<string, unknown> = {}) =>
      ({ id, text: id, parentId, status: null, claimedBySession: null, approval: APPROVED, dependencies: [], tags: [], blockedReason: null, description: 'brief', externalLinks: [], versionId: null, effortEstimate: 1, childrenIds: [], ...extra }) as never;
    const nodes = [
      // The root carries no stamp and holds nothing.
      n('root', null, { approval: null, childrenIds: ['ok', 'unstamped', 'prop', 'rej', 'epic', 'done'] }),
      n('ok', 'root'),
      n('unstamped', 'root', { approval: null }),
      n('prop', 'root', { approval: proposed }),
      n('rej', 'root', { approval: rejected }),
      n('epic', 'root', { approval: proposed, childrenIds: ['child'] }),
      n('child', 'epic'),
      n('done', 'root', { approval: proposed, status: 'done', childrenIds: ['late'] }),
      n('late', 'done'),
    ];
    const workflow = [{ id: 'todo', name: 'Todo', category: 'todo' }, { id: 'done', name: 'Done', category: 'done' }] as never;
    const snap = dispatchQueueSnapshot(nodes, { workflow, cap: 5, gate: [] });
    expect([...snap.inGateIds].sort()).toEqual(['late', 'ok']);
    expect(snap.humanOnly).toBe(4);
    expect(snap.heldByParents).toEqual([{ id: 'epic', text: 'epic', tag: null, blockedReason: null, approval: 'proposed', count: 1 }]);
    // No stamp on the ticket waits like proposed (fail-closed).
    expect(dispatchHold(nodes[2] as never)).toEqual({ tag: null, blockedReason: null, approval: 'proposed', heldBy: null });
    expect(dispatchHold(nodes[4] as never)?.approval).toBe('rejected');
  });
});
