/**
 * answerAsk — the server-side leidang-asks-apply. Pins that one answer
 * writes the ticket comment, the node (decision on top of the description,
 * blockedReason null, tag off, blocked → todo) and flags the worker note,
 * that a done node stays done, that later/delegate only record, and that
 * a failed GitHub call is recorded on the row instead of aborting the node
 * write.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getAskMock = vi.fn();
const setAnswerMock = vi.fn(async (_m: string, _id: string, patch: unknown) => ({ ask: {}, ...(patch as object) }));
const getNodeMock = vi.fn();
const updateNodeMock = vi.fn();
const getStatusWorkflowMock = vi.fn(async () => [
  { id: 'todo', name: 'Todo', category: 'todo' },
  { id: 'in_progress', name: 'In progress', category: 'in_progress' },
  { id: 'done', name: 'Done', category: 'done' },
]);
const recordFieldChangesMock = vi.fn(async () => {});
const ghCtxMock = vi.fn(async () => ({ owner: 'FulcrumCRM', repo: 'crm', token: 't' }));
const commentMock = vi.fn(async () => ({ id: 1, html_url: 'u' }));
const milestoneMock = vi.fn(async () => ({ milestoneNumber: 3 }));

vi.mock('../../db/asks.js', () => ({ getAsk: (...a: unknown[]) => getAskMock(...a), setAnswer: (...a: unknown[]) => setAnswerMock(...(a as [string, string, unknown])) }));
vi.mock('../../db/nodes.js', () => ({ getNode: (...a: unknown[]) => getNodeMock(...a), updateNode: (...a: unknown[]) => updateNodeMock(...a) }));
vi.mock('../../db/maps.js', () => ({ getStatusWorkflow: (...a: unknown[]) => getStatusWorkflowMock(...(a as [])) }));
vi.mock('../../db/events.js', () => ({ recordFieldChanges: (...a: unknown[]) => recordFieldChangesMock(...(a as [])) }));
vi.mock('../../lib/githubContext.js', () => ({ getGitHubContextForMap: (...a: unknown[]) => ghCtxMock(...(a as [])) }));
vi.mock('@mindblown/integrations', () => ({
  commentOnGitHubIssue: (...a: unknown[]) => commentMock(...(a as [])),
  setGitHubIssueMilestone: (...a: unknown[]) => milestoneMock(...(a as [])),
}));

import { answerAsk, AskNotFoundError, AskValidationError } from '../asks.js';

const MAP = 'map-1';
const NODE = 'n1n1n1n1-2222-3333-4444-555555555555';

function askRow(over: Record<string, unknown> = {}, unblocks: Record<string, unknown> = {}) {
  return {
    ask: {
      id: '#6823', ticket: 6823, requirement: null, title: '#6823 Avione', url: null, sources: ['tick:decision'],
      question: 'skip / keep?', question_author: 'worker', options: ['skip', 'keep'], answerer: 'Dan', hint: 'decision',
      priority: 'P1', milestone: null, needs_version: false, idle_hours: 10,
      unblocks: { node_id: NODE, node_title: 'Avione', node_status: 'blocked', claimed_by: null, worker: null, pr: null, pr_state: null, ...unblocks },
      moot: false, ...over,
    },
    status: 'open', pushedAt: 'p', firstSeenAt: 'p', answer: null, answeredBy: null, answeredAt: null, writes: [], workerPending: false,
  };
}

function node(over: Record<string, unknown> = {}) {
  return { id: NODE, mapId: MAP, status: 'blocked', tags: ['blocked'], claimedBySession: null, blockedReason: 'needs Dan', description: 'old body', externalLinks: [], ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  getAskMock.mockResolvedValue(askRow());
  getNodeMock.mockResolvedValue(node());
  updateNodeMock.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({ ...node(), ...patch, tags: [] }));
});

const today = new Date().toISOString().slice(0, 10);

describe('answerAsk — answered', () => {
  it('comments the ticket, rewrites the node like apply, records the writes', async () => {
    const out = await answerAsk(MAP, '#6823', { action: 'answered', decision: 'skip' }, 'u1');
    expect(commentMock).toHaveBeenCalledWith('FulcrumCRM', 'crm', 6823, `**Entscheid (Dan, ${today}): skip**\n\n_via /leidang-asks_`, 't');
    expect(milestoneMock).not.toHaveBeenCalled();
    expect(updateNodeMock).toHaveBeenCalledWith(NODE, {
      blockedReason: null,
      description: `**Entscheid (Dan, ${today}): skip**\n\nold body`,
      tagsRemove: ['blocked'],
      status: 'todo',
    });
    expect(recordFieldChangesMock).toHaveBeenCalledWith(MAP, NODE, 'u1', expect.objectContaining({ status: 'blocked' }), expect.objectContaining({ status: 'todo' }));
    expect(out.ok).toBe(true);
    expect(out.changedFields).toEqual(['blockedReason', 'description', 'tags', 'status']);
    const patch = setAnswerMock.mock.calls[0][2] as { status: string; answeredBy: string; writes: { kind: string; done: boolean }[]; workerPending: boolean };
    expect(patch.status).toBe('answered');
    expect(patch.answeredBy).toBe('Dan');
    expect(patch.writes.map((w) => [w.kind, w.done])).toEqual([['gh-comment', true], ['mb-put', true]]);
    expect(patch.workerPending).toBe(false);
  });

  it('sets the milestone and drops NEEDS-VERSION when that was the question', async () => {
    getAskMock.mockResolvedValue(askRow({ needs_version: true }));
    await answerAsk(MAP, '#6823', { action: 'answered', decision: 'V1.5', milestone: 'V1.5' }, 'u1');
    expect(milestoneMock).toHaveBeenCalledWith('FulcrumCRM', 'crm', 6823, 'V1.5', 'NEEDS-VERSION', 't');
  });

  it('keeps a claimed node\'s status, and honours noRequeue', async () => {
    getNodeMock.mockResolvedValue(node({ status: 'in_progress', claimedBySession: 'sat3:worker-2' }));
    await answerAsk(MAP, '#6823', { action: 'answered', decision: 'skip' }, 'u1');
    expect(updateNodeMock.mock.calls[0][1]).not.toHaveProperty('status');
    getNodeMock.mockResolvedValue(node());
    await answerAsk(MAP, '#6823', { action: 'answered', decision: 'skip', noRequeue: true }, 'u1');
    expect(updateNodeMock.mock.calls[1][1]).not.toHaveProperty('status');
    expect(updateNodeMock.mock.calls[1][1]).toMatchObject({ blockedReason: null, tagsRemove: ['blocked'] });
  });

  it('never touches a done node', async () => {
    getNodeMock.mockResolvedValue(node({ status: 'done', tags: [] }));
    const out = await answerAsk(MAP, '#6823', { action: 'answered', decision: 'skip' }, 'u1');
    expect(updateNodeMock).not.toHaveBeenCalled();
    expect(out.node).toBeNull();
    const patch = setAnswerMock.mock.calls[0][2] as { writes: { kind: string; detail: string }[] };
    expect(patch.writes.find((w) => w.kind === 'mb-skip')!.detail).toContain('done');
  });

  it('flags a worker note for the next tick instead of writing it', async () => {
    getAskMock.mockResolvedValue(askRow({ ticket: null, id: 'q:x' }, { node_id: null, worker: 'sat3:worker-2' }));
    const out = await answerAsk(MAP, 'q:x', { action: 'answered', decision: 'go', by: 'Dan' }, 'u1');
    expect(commentMock).not.toHaveBeenCalled();
    expect(updateNodeMock).not.toHaveBeenCalled();
    const patch = setAnswerMock.mock.calls[0][2] as { workerPending: boolean; writes: { kind: string; done: boolean }[] };
    expect(patch.workerPending).toBe(true);
    expect(patch.writes).toEqual([expect.objectContaining({ kind: 'worker-note', target: 'sat3:worker-2', done: false })]);
    expect(out.ok).toBe(true); // a pending worker note is not a failure
  });

  it('a moot ask writes nothing', async () => {
    getAskMock.mockResolvedValue(askRow({ moot: true }, { worker: 'sat3:worker-1', pr: 6869, pr_state: 'MERGED' }));
    const out = await answerAsk(MAP, '#6823', { action: 'answered', decision: 'x' }, 'u1');
    expect(commentMock).not.toHaveBeenCalled();
    expect(updateNodeMock).not.toHaveBeenCalled();
    const patch = setAnswerMock.mock.calls[0][2] as { status: string; workerPending: boolean; writes: { kind: string }[] };
    expect(patch.status).toBe('answered');
    expect(patch.workerPending).toBe(false);
    expect(patch.writes.map((w) => w.kind)).toEqual(['moot-skip']);
    expect(out.ok).toBe(true);
  });

  it('records a failed GitHub call and still writes the node', async () => {
    commentMock.mockRejectedValueOnce(new Error('GitHub API 502'));
    const out = await answerAsk(MAP, '#6823', { action: 'answered', decision: 'skip' }, 'u1');
    expect(updateNodeMock).toHaveBeenCalled();
    expect(out.ok).toBe(false);
    const patch = setAnswerMock.mock.calls[0][2] as { writes: { kind: string; done: boolean; error?: string }[] };
    expect(patch.writes[0]).toMatchObject({ kind: 'gh-comment', done: false, error: 'GitHub API 502' });
    expect(patch.writes[1]).toMatchObject({ kind: 'mb-put', done: true });
  });

  it('says so when the map has no GitHub integration', async () => {
    ghCtxMock.mockResolvedValueOnce(null as never);
    const out = await answerAsk(MAP, '#6823', { action: 'answered', decision: 'skip' }, 'u1');
    expect(commentMock).not.toHaveBeenCalled();
    expect(out.ok).toBe(false);
    const patch = setAnswerMock.mock.calls[0][2] as { writes: { error?: string }[] };
    expect(patch.writes[0].error).toContain('no GitHub integration');
  });
});

describe('answerAsk — later / delegate / validation', () => {
  it('later and delegate only record', async () => {
    await answerAsk(MAP, '#6823', { action: 'later' }, 'u1');
    await answerAsk(MAP, '#6823', { action: 'delegate', delegateTo: 'Rita' }, 'u1');
    expect(commentMock).not.toHaveBeenCalled();
    expect(updateNodeMock).not.toHaveBeenCalled();
    expect((setAnswerMock.mock.calls[0][2] as { status: string }).status).toBe('later');
    expect(setAnswerMock.mock.calls[1][2]).toMatchObject({ status: 'delegated', writes: [expect.objectContaining({ kind: 'ledger-only', detail: 'delegate → Rita' })] });
  });

  it('refuses an empty decision, a delegate without target, an unknown ask', async () => {
    await expect(answerAsk(MAP, '#6823', { action: 'answered', decision: '  ' }, 'u1')).rejects.toBeInstanceOf(AskValidationError);
    await expect(answerAsk(MAP, '#6823', { action: 'delegate' }, 'u1')).rejects.toBeInstanceOf(AskValidationError);
    getAskMock.mockResolvedValueOnce(null);
    await expect(answerAsk(MAP, 'nope', { action: 'later' }, 'u1')).rejects.toBeInstanceOf(AskNotFoundError);
    expect(setAnswerMock).not.toHaveBeenCalled();
  });
});
