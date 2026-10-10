/**
 * Trash GC closes a hard-deleted node's issue only through the close gate
 * (#311): not while a PR is in flight, never over an existing close, as
 * completed when the work landed, and only on the map's own repo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExternalLink, LinkedPrState } from '@mindblown/core';

const m = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  deleted: [] as string[][],
  close: vi.fn(),
  getIssue: vi.fn(),
  probe: vi.fn(),
}));

vi.mock('../../db/connection.js', () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => m.rows }) }),
    delete: () => ({
      where: async () => {
        m.deleted.push(m.rows.map((r) => r.id as string));
      },
    }),
  },
}));
vi.mock('../../db/schema.js', () => ({ nodes: { id: 'id', deletedAt: 'deleted_at' } }));
vi.mock('../../db/nodes.js', () => ({ onActiveMap: {} }));
vi.mock('../../lib/githubContext.js', () => ({
  getGitHubContextForMap: vi.fn(async () => ({ owner: 'o', repo: 'r', token: 't', forge: {} })),
}));
vi.mock('@mindblown/integrations', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@mindblown/integrations');
  return { ...actual, closeGitHubIssue: m.close, getGitHubIssue: m.getIssue, probeIssueLanded: m.probe };
});

import { runTrashGc } from '../trashGc.js';

const link = (externalId: string): ExternalLink =>
  ({ provider: 'gitea', externalId, url: 'u', syncEnabled: true, lastSyncedAt: null }) as ExternalLink;
const row = (id: string, externalId: string, linkedPr: Partial<LinkedPrState> | null = null) => ({
  id,
  mapId: 'map1',
  externalLinks: [link(externalId)],
  linkedPr,
});

beforeEach(() => {
  m.rows = [];
  m.deleted = [];
  m.close.mockReset();
  m.getIssue.mockReset();
  m.getIssue.mockResolvedValue({ number: 5, state: 'open' });
  m.probe.mockReset();
  m.probe.mockResolvedValue({ closingPrs: [], defaultBranch: 'main', landed: null, inFlight: false });
});

describe('runTrashGc close gate (#311)', () => {
  it('no PR, issue open: closed as not_planned, row hard-deleted', async () => {
    m.rows = [row('n1', 'o/r#5')];
    const s = await runTrashGc(30);
    expect(m.close).toHaveBeenCalledWith(expect.objectContaining({ externalId: 'o/r#5' }), {}, 'not_planned');
    expect(s).toMatchObject({ githubClosed: 1, githubSkipped: 0, hardDeleted: 1 });
  });

  it('the node\'s mirror says a PR is in flight: the issue is left open', async () => {
    m.rows = [row('n1', 'o/r#5', { state: 'open', number: 9 })];
    const s = await runTrashGc(30);
    expect(m.close).not.toHaveBeenCalled();
    expect(m.getIssue).not.toHaveBeenCalled();
    expect(s).toMatchObject({ githubSkipped: 1, hardDeleted: 1 });
  });

  it('the forge shows a PR in flight the mirror missed: left open', async () => {
    m.rows = [row('n1', 'o/r#5')];
    m.probe.mockResolvedValue({ closingPrs: [], defaultBranch: 'main', landed: null, inFlight: true });
    const s = await runTrashGc(30);
    expect(m.close).not.toHaveBeenCalled();
    expect(s.githubSkipped).toBe(1);
  });

  it('already closed (e.g. completed): its close is not rewritten to not_planned', async () => {
    m.rows = [row('n1', 'o/r#5')];
    m.getIssue.mockResolvedValue({ number: 5, state: 'closed' });
    const s = await runTrashGc(30);
    expect(m.close).not.toHaveBeenCalled();
    expect(m.probe).not.toHaveBeenCalled();
    expect(s.githubSkipped).toBe(1);
  });

  it('the work already landed: closed as completed, not as not_planned', async () => {
    m.rows = [row('n1', 'o/r#5')];
    m.probe.mockResolvedValue({ closingPrs: [], defaultBranch: 'main', inFlight: false, landed: { number: 9, mergeCommitSha: 'abc' } });
    await runTrashGc(30);
    expect(m.close).toHaveBeenCalledWith(expect.anything(), {}, 'completed');
  });

  it('a link to another repo than the map\'s: left alone (the map\'s client cannot speak for it)', async () => {
    m.rows = [row('n1', 'other/repo#5')];
    const s = await runTrashGc(30);
    expect(m.getIssue).not.toHaveBeenCalled();
    expect(m.close).not.toHaveBeenCalled();
    expect(s.githubSkipped).toBe(1);
  });

  it('a forge error leaves the issue as it is, counts a failure, and the row is still deleted', async () => {
    m.rows = [row('n1', 'o/r#5')];
    m.getIssue.mockRejectedValue(new Error('502'));
    const s = await runTrashGc(30);
    expect(m.close).not.toHaveBeenCalled();
    expect(s).toMatchObject({ githubFailed: 1, hardDeleted: 1 });
  });
});
