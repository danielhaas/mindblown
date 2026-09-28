/**
 * Acting on an existing ticket from intake (#409): comment = node comment
 * + forge comment as the person; reopen = todo/0 % + sync + comment; a
 * forge-only issue is reopened directly; unknown targets are refused.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getNodeMock = vi.fn();
const updateNodeMock = vi.fn();
const createCommentMock = vi.fn();
const recordFieldChangesMock = vi.fn(async (..._a: unknown[]) => {});
const getContextMock = vi.fn();
const userForgeMock = vi.fn();
const commentIssueMock = vi.fn();
const syncMock = vi.fn(async (..._a: unknown[]) => {});
const broadcastMock = vi.fn();
const updateIssueMock = vi.fn();

vi.mock('../../db/nodes.js', () => ({
  getNode: (...a: unknown[]) => getNodeMock(...a),
  updateNode: (...a: unknown[]) => updateNodeMock(...a),
}));
vi.mock('../../db/comments.js', () => ({ createComment: (...a: unknown[]) => createCommentMock(...a) }));
vi.mock('../../db/events.js', () => ({ recordFieldChanges: (...a: unknown[]) => recordFieldChangesMock(...a) }));
vi.mock('../../lib/githubContext.js', () => ({ getGitHubContextForMap: (...a: unknown[]) => getContextMock(...a) }));
vi.mock('../../ws.js', () => ({ broadcast: (...a: unknown[]) => broadcastMock(...a) }));
vi.mock('../../routes/nodes.js', () => ({ syncNodeToGitHub: (...a: unknown[]) => syncMock(...a) }));
vi.mock('../forgeIssue.js', () => ({ userForgeForMap: (...a: unknown[]) => userForgeMock(...a) }));
vi.mock('@mindblown/integrations', () => ({ commentOnGitHubIssue: (...a: unknown[]) => commentIssueMock(...a) }));

import { commentOnExisting, reopenExisting, ExistingNotFoundError } from '../intakeActions.js';

const BINDING = { name: 'binding', updateIssue: (...a: unknown[]) => updateIssueMock(...a) };
const USER = { name: 'user-forge' };
const map = { id: 'm1', statusWorkflow: [{ id: 'todo', label: 'To do', category: 'todo' }, { id: 'done', label: 'Done', category: 'done' }] } as never;
const linked = {
  id: 'n1', mapId: 'm1', text: 'Existing', status: 'done', percentComplete: 100, completedAt: '2026-09-01T00:00:00Z',
  externalLinks: [{ provider: 'github', externalId: 'o/r#42', url: 'https://x/42', syncEnabled: true, lastSyncedAt: null }],
};

beforeEach(() => {
  vi.clearAllMocks();
  getNodeMock.mockResolvedValue(linked);
  updateNodeMock.mockImplementation(async (id: string, f: Record<string, unknown>) => ({ ...linked, id, ...f }));
  createCommentMock.mockImplementation(async (i: { text: string }) => ({ id: 'c1', text: i.text }));
  getContextMock.mockResolvedValue({ owner: 'o', repo: 'r', token: 't', forge: BINDING });
  userForgeMock.mockResolvedValue({ forge: USER, login: 'dan' });
  commentIssueMock.mockResolvedValue({ id: 1, html_url: 'https://x/42#c1' });
});

describe('commentOnExisting', () => {
  it('writes the node comment and the issue comment as the person', async () => {
    const r = await commentOnExisting('m1', 'u1', { nodeId: 'n1' }, 'new info');
    expect(createCommentMock).toHaveBeenCalledWith({ nodeId: 'n1', userId: 'u1', text: 'new info' });
    expect(broadcastMock).toHaveBeenCalledWith('m1', expect.objectContaining({ type: 'comment:created', nodeId: 'n1' }));
    expect(commentIssueMock).toHaveBeenCalledWith('o', 'r', 42, 'new info', USER);
    expect(r).toMatchObject({ nodeId: 'n1', issueNumber: 42, commentUrl: 'https://x/42#c1', author: { as: 'user', login: 'dan' }, warnings: [] });
  });

  it('falls back to the binding when the personal token is refused', async () => {
    commentIssueMock.mockRejectedValueOnce(new Error('403'));
    const r = await commentOnExisting('m1', 'u1', { nodeId: 'n1' }, 'x');
    expect(commentIssueMock).toHaveBeenCalledTimes(2);
    expect(commentIssueMock.mock.calls[1][4]).toBe(BINDING);
    expect(r.author).toEqual({ as: 'binding', login: null, fallbackReason: '403' });
  });

  it('forge-only issue: no node comment, issue comment only', async () => {
    const r = await commentOnExisting('m1', 'u1', { issueNumber: 77 }, 'x');
    expect(getNodeMock).not.toHaveBeenCalled();
    expect(createCommentMock).not.toHaveBeenCalled();
    expect(commentIssueMock).toHaveBeenCalledWith('o', 'r', 77, 'x', USER);
    expect(r.nodeId).toBeNull();
  });

  it('node without an issue and no repo: node comment only, with a warning-free result', async () => {
    getNodeMock.mockResolvedValueOnce({ ...linked, externalLinks: [] });
    const r = await commentOnExisting('m1', 'u1', { nodeId: 'n1' }, 'x');
    expect(commentIssueMock).not.toHaveBeenCalled();
    expect(r).toMatchObject({ nodeId: 'n1', issueNumber: null, commentUrl: null });
  });

  it('refuses a node from another map and an empty target', async () => {
    getNodeMock.mockResolvedValueOnce({ ...linked, mapId: 'other' });
    await expect(commentOnExisting('m1', 'u1', { nodeId: 'n1' }, 'x')).rejects.toBeInstanceOf(ExistingNotFoundError);
    await expect(commentOnExisting('m1', 'u1', {}, 'x')).rejects.toBeInstanceOf(ExistingNotFoundError);
  });
});

describe('reopenExisting', () => {
  it('puts the node back to the first todo status, syncs, comments', async () => {
    const r = await reopenExisting('m1', 'u1', map, { nodeId: 'n1' }, 'it is back');
    expect(updateNodeMock).toHaveBeenCalledWith('n1', { status: 'todo', percentComplete: 0, completedAt: null });
    expect(recordFieldChangesMock).toHaveBeenCalled();
    expect(syncMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'todo' }), ['status', 'percentComplete']);
    expect(createCommentMock).toHaveBeenCalledWith({ nodeId: 'n1', userId: 'u1', text: 'it is back' });
    expect(commentIssueMock).toHaveBeenCalledWith('o', 'r', 42, 'it is back', USER);
    expect(r.node).toMatchObject({ status: 'todo', percentComplete: 0 });
  });

  it('reopens a forge-only issue directly through the binding', async () => {
    updateIssueMock.mockResolvedValueOnce({});
    const r = await reopenExisting('m1', 'u1', map, { issueNumber: 77 }, 'back');
    expect(updateNodeMock).not.toHaveBeenCalled();
    expect(updateIssueMock).toHaveBeenCalledWith('o', 'r', 77, { state: 'open', state_reason: 'reopened' });
    expect(commentIssueMock).toHaveBeenCalledWith('o', 'r', 77, 'back', USER);
    expect(r.issueNumber).toBe(77);
  });
});
