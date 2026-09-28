/**
 * applyLintFix — each action's write, and that every node-side fix fans
 * out like a hand edit (change events, broadcast, outbound sync).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Node } from '@mindblown/core';

const nodes = new Map<string, Node>();
const updateNode = vi.fn(async (id: string, input: Record<string, unknown>) => {
  const cur = nodes.get(id);
  if (!cur) return null;
  const { tagsAppend, ...rest } = input as { tagsAppend?: string[] } & Record<string, unknown>;
  const next = { ...cur, ...rest, tags: [...new Set([...cur.tags, ...(tagsAppend ?? [])])] } as Node;
  nodes.set(id, next);
  return next;
});
const setExternalLinkState = vi.fn(async (id: string, externalId: string, state: 'open' | 'closed') => {
  const cur = nodes.get(id);
  if (!cur) return false;
  nodes.set(id, {
    ...cur,
    externalLinks: cur.externalLinks.map((l) => (l.externalId === externalId ? { ...l, state } : l)),
  });
  return true;
});
vi.mock('../../db/nodes.js', () => ({
  getNode: vi.fn(async (id: string) => nodes.get(id) ?? null),
  updateNode: (...a: unknown[]) => updateNode(...(a as [string, Record<string, unknown>])),
  setExternalLinkState: (...a: unknown[]) => setExternalLinkState(...(a as [string, string, 'open' | 'closed'])),
}));

vi.mock('../../db/maps.js', () => ({
  getStatusWorkflow: vi.fn(async () => [
    { id: 'todo', name: 'Todo', category: 'todo' },
    { id: 'wip', name: 'In progress', category: 'in_progress' },
    { id: 'shipped', name: 'Shipped', category: 'done' },
  ]),
}));

const recordFieldChanges = vi.fn(async () => {});
vi.mock('../../db/events.js', () => ({ recordFieldChanges: (...a: unknown[]) => recordFieldChanges(...(a as [])) }));

const broadcast = vi.fn();
vi.mock('../../ws.js', () => ({ broadcast: (...a: unknown[]) => broadcast(...(a as [])) }));

const syncNodeToGitHub = vi.fn(async () => {});
vi.mock('../../routes/nodes.js', () => ({ syncNodeToGitHub: (...a: unknown[]) => syncNodeToGitHub(...(a as [])) }));

const updateIssue = vi.fn(async () => ({}));
let forgeCtx: { owner: string; repo: string; forge: { updateIssue: typeof updateIssue } } | null = null;
vi.mock('../../lib/githubContext.js', () => ({ getGitHubContextForMap: vi.fn(async () => forgeCtx) }));

const unblockNode = vi.fn(async (_mapId: string, nodeId: string) => {
  const cur = nodes.get(nodeId)!;
  const next = { ...cur, blockedReason: null, tags: cur.tags.filter((t) => t !== 'blocked') } as Node;
  nodes.set(nodeId, next);
  return { node: next, statusReset: false, changedFields: ['blockedReason', 'tags'] };
});
vi.mock('../../services/unblock.js', () => ({
  unblockNode: (...a: unknown[]) => unblockNode(...(a as [string, string])),
  UnblockNotFoundError: class extends Error {},
}));

import { applyLintFix, LintFixError } from '../fix.js';

function seed(overrides: Partial<Node> & { id: string }): Node {
  const n = {
    mapId: 'm1',
    parentId: 'root',
    childrenIds: [],
    text: overrides.id,
    status: 'todo',
    percentComplete: 0,
    blockedReason: null,
    tags: [],
    externalLinks: [],
    claimedBySession: null,
    ...overrides,
  } as unknown as Node;
  nodes.set(n.id, n);
  return n;
}

beforeEach(() => {
  nodes.clear();
  forgeCtx = null;
  vi.clearAllMocks();
});

describe('applyLintFix — node-side actions', () => {
  it('mark-done writes the workflow done status and 100 %, then fans out', async () => {
    seed({ id: 'a', status: 'shipped', percentComplete: 0 });
    const r = await applyLintFix('m1', 'a', 'mark-done', 'u1');
    expect(updateNode).toHaveBeenCalledWith('a', { status: 'shipped', percentComplete: 100 });
    expect(r.node.percentComplete).toBe(100);
    expect(r.changedFields).toEqual(['status', 'percentComplete']);
    expect(recordFieldChanges).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith('m1', expect.objectContaining({ type: 'node:updated', nodeId: 'a' }));
    expect(syncNodeToGitHub).toHaveBeenCalledWith(r.node, ['status', 'percentComplete']);
  });

  it('reopen writes the first todo status, 0 % and clears completedAt', async () => {
    seed({ id: 'a', status: 'shipped', percentComplete: 100 });
    await applyLintFix('m1', 'a', 'reopen', 'u1');
    expect(updateNode).toHaveBeenCalledWith('a', { status: 'todo', percentComplete: 0, completedAt: null });
  });

  it('park mirrors blocked.sh: status blocked, reason, tag, claim released; keeps an existing reason', async () => {
    seed({ id: 'a', status: 'todo', claimedBySession: 'w1' });
    const r = await applyLintFix('m1', 'a', 'park', 'u1', { note: '715 pickups in 24 h' });
    expect(updateNode).toHaveBeenCalledWith('a', {
      status: 'blocked',
      blockedReason: 'Parked from Plan health: 715 pickups in 24 h',
      tagsAppend: ['blocked'],
      claimedBySession: null,
    });
    expect(r.node.tags).toEqual(['blocked']);

    seed({ id: 'b', status: 'todo', blockedReason: 'waiting on Dan' });
    await applyLintFix('m1', 'b', 'park', 'u1');
    expect(updateNode).toHaveBeenLastCalledWith('b', expect.objectContaining({ blockedReason: 'waiting on Dan' }));
  });

  it('clear-blocker delegates to the unblock service and fans out its changed fields', async () => {
    seed({ id: 'a', status: 'shipped', blockedReason: 'swept', tags: ['blocked'] });
    const r = await applyLintFix('m1', 'a', 'clear-blocker', 'u1');
    expect(unblockNode).toHaveBeenCalledWith('m1', 'a', 'u1');
    expect(r.node.blockedReason).toBeNull();
    expect(syncNodeToGitHub).toHaveBeenCalledWith(r.node, ['blockedReason', 'tags']);
  });

  it('refuses a node from another map', async () => {
    seed({ id: 'a', mapId: 'other' });
    await expect(applyLintFix('m1', 'a', 'mark-done', 'u1')).rejects.toBeInstanceOf(LintFixError);
    expect(updateNode).not.toHaveBeenCalled();
  });
});

describe('applyLintFix — issue-side actions', () => {
  const link = { provider: 'gitea', externalId: 'dan/jiso#7', url: 'u', syncEnabled: true, lastSyncedAt: null, state: 'open' as const };

  it('close-issue patches the forge, stamps the link state, and does not touch node status', async () => {
    seed({ id: 'a', status: 'shipped', externalLinks: [link] });
    forgeCtx = { owner: 'dan', repo: 'jiso', forge: { updateIssue } };
    const r = await applyLintFix('m1', 'a', 'close-issue', 'u1');
    expect(updateIssue).toHaveBeenCalledWith('dan', 'jiso', 7, { state: 'closed', state_reason: 'completed' });
    expect(setExternalLinkState).toHaveBeenCalledWith('a', 'dan/jiso#7', 'closed');
    expect(r.issue).toEqual({ externalId: 'dan/jiso#7', state: 'closed' });
    expect(r.node.externalLinks[0].state).toBe('closed');
    expect(updateNode).not.toHaveBeenCalled();
    expect(syncNodeToGitHub).not.toHaveBeenCalled();
  });

  it('reopen-issue sends state open / reopened', async () => {
    seed({ id: 'a', status: 'todo', externalLinks: [{ ...link, state: 'closed' }] });
    forgeCtx = { owner: 'dan', repo: 'jiso', forge: { updateIssue } };
    await applyLintFix('m1', 'a', 'reopen-issue', 'u1');
    expect(updateIssue).toHaveBeenCalledWith('dan', 'jiso', 7, { state: 'open', state_reason: 'reopened' });
  });

  it('fails cleanly without a link or without a forge', async () => {
    seed({ id: 'nolink', status: 'shipped' });
    await expect(applyLintFix('m1', 'nolink', 'close-issue', 'u1')).rejects.toMatchObject({ code: 'NO_FORGE_LINK' });
    seed({ id: 'a', status: 'shipped', externalLinks: [link] });
    await expect(applyLintFix('m1', 'a', 'close-issue', 'u1')).rejects.toMatchObject({ code: 'NO_FORGE' });
    expect(updateIssue).not.toHaveBeenCalled();
  });
});
