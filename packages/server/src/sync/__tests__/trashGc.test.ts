/**
 * Trash GC settles a hard-deleted node's issue through the close gate
 * (#311): never over an existing close, completed when the work shipped,
 * only on the map's own repo — and a row whose issue is still undecided
 * (PR in flight, release merge, forge error) stays in the Trash for the
 * next run instead of leaving an open issue with no node behind.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExternalLink, LinkedPrState } from '@mindblown/core';

const m = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  deletedIds: [] as string[],
  close: vi.fn(),
  getIssue: vi.fn(),
  probe: vi.fn(),
  ctx: vi.fn(),
}));

vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('drizzle-orm');
  return { ...actual, inArray: (_col: unknown, ids: string[]) => ({ __ids: ids }) };
});
vi.mock('../../db/connection.js', () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => m.rows }) }),
    delete: () => ({
      where: async (cond: { __ids: string[] }) => {
        m.deletedIds.push(...cond.__ids);
      },
    }),
  },
}));
vi.mock('../../db/schema.js', () => ({ nodes: { id: 'id', deletedAt: 'deleted_at' } }));
vi.mock('../../db/nodes.js', () => ({ onActiveMap: {} }));
vi.mock('../../lib/githubContext.js', () => ({ getGitHubContextForMap: m.ctx }));
vi.mock('@mindblown/integrations', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@mindblown/integrations');
  return { ...actual, closeGitHubIssue: m.close, getGitHubIssue: m.getIssue, probeIssueLanded: m.probe };
});

import { runTrashGc } from '../trashGc.js';

const link = (externalId: string, extra: Partial<ExternalLink> = {}): ExternalLink =>
  ({ provider: 'gitea', externalId, url: 'u', syncEnabled: true, lastSyncedAt: null, ...extra }) as ExternalLink;
const mirror = (over: Partial<LinkedPrState>): LinkedPrState =>
  ({
    number: 9, repo: 'o/r', url: 'u', head: 'h', base: 'main', author: null, draft: false, state: 'open',
    mergeable: null, changedFiles: [], reviews: [], checks: { state: null, failures: [] }, lastSyncedAt: '2026-09-01T00:00:00Z',
    ...over,
  }) as LinkedPrState;
const row = (id: string, links: ExternalLink[], linkedPr: LinkedPrState | null = null) => ({
  id, mapId: 'map1', externalLinks: links, linkedPr, completedAt: new Date('2026-08-01T00:00:00Z'),
});

beforeEach(() => {
  m.rows = [];
  m.deletedIds = [];
  for (const f of [m.close, m.getIssue, m.probe, m.ctx]) f.mockReset();
  m.ctx.mockResolvedValue({ owner: 'o', repo: 'r', token: 't', forge: {} });
  m.getIssue.mockResolvedValue({ number: 5, state: 'open' });
  m.probe.mockResolvedValue({ closingPrs: [], defaultBranch: 'main', landed: null, inFlight: false });
});

describe('runTrashGc (#311)', () => {
  it('nobody delivered it: closed as not_planned, row hard-deleted', async () => {
    m.rows = [row('n1', [link('o/r#5')])];
    const s = await runTrashGc(30);
    expect(m.close).toHaveBeenCalledWith(expect.objectContaining({ externalId: 'o/r#5' }), {}, 'not_planned');
    expect(m.deletedIds).toEqual(['n1']);
    expect(s).toMatchObject({ githubClosed: 1, hardDeleted: 1 });
  });

  it('a PR in flight on the mirror: issue untouched and the row STAYS in the Trash for the next run', async () => {
    m.rows = [row('n1', [link('o/r#5')], mirror({ state: 'open' }))];
    const s = await runTrashGc(30);
    expect(m.close).not.toHaveBeenCalled();
    expect(m.getIssue).not.toHaveBeenCalled();
    expect(m.deletedIds).toEqual([]);
    expect(s).toMatchObject({ githubHeld: 1, hardDeleted: 0 });
  });

  it('merged to a release branch (not landed on default): held, like the live close gate', async () => {
    m.rows = [row('n1', [link('o/r#5')], mirror({ state: 'merged', landedOnDefault: false }))];
    const s = await runTrashGc(30);
    expect(m.close).not.toHaveBeenCalled();
    expect(m.deletedIds).toEqual([]);
    expect(s.githubHeld).toBe(1);
  });

  it('merge evidence on the link: closed as completed without asking for PRs', async () => {
    m.rows = [row('n1', [link('o/r#5', { mergeCommitSha: 'abc' })])];
    await runTrashGc(30);
    expect(m.close).toHaveBeenCalledWith(expect.anything(), {}, 'completed');
    expect(m.probe).not.toHaveBeenCalled();
    expect(m.deletedIds).toEqual(['n1']);
  });

  it('a default-branch merge in the mirror (even without a Closes ref): completed', async () => {
    m.rows = [row('n1', [link('o/r#5')], mirror({ state: 'merged' }))];
    await runTrashGc(30);
    expect(m.close).toHaveBeenCalledWith(expect.anything(), {}, 'completed');
  });

  it('a PR in flight that only the forge knows of: held, row kept', async () => {
    m.rows = [row('n1', [link('o/r#5')])];
    m.probe.mockResolvedValue({ closingPrs: [], defaultBranch: 'main', landed: null, inFlight: true });
    const s = await runTrashGc(30);
    expect(m.close).not.toHaveBeenCalled();
    expect(m.deletedIds).toEqual([]);
    expect(s.githubHeld).toBe(1);
  });

  it('the work landed through a PR: completed', async () => {
    m.rows = [row('n1', [link('o/r#5')])];
    m.probe.mockResolvedValue({ closingPrs: [], defaultBranch: 'main', inFlight: false, landed: { number: 9, mergeCommitSha: 'abc' } });
    await runTrashGc(30);
    expect(m.close).toHaveBeenCalledWith(expect.anything(), {}, 'completed');
  });

  it('already closed (e.g. completed): its close stays, the row is deleted', async () => {
    m.rows = [row('n1', [link('o/r#5')])];
    m.getIssue.mockResolvedValue({ number: 5, state: 'closed' });
    const s = await runTrashGc(30);
    expect(m.close).not.toHaveBeenCalled();
    expect(m.deletedIds).toEqual(['n1']);
    expect(s.githubSkipped).toBe(1);
  });

  it('a link to another repo than the map\'s: left alone, row deleted', async () => {
    m.rows = [row('n1', [link('other/repo#5')])];
    const s = await runTrashGc(30);
    expect(m.getIssue).not.toHaveBeenCalled();
    expect(m.deletedIds).toEqual(['n1']);
    expect(s.githubSkipped).toBe(1);
  });

  it('a forge error: issue untouched, row kept for the next run', async () => {
    m.rows = [row('n1', [link('o/r#5')])];
    m.probe.mockRejectedValue(new Error('502'));
    const s = await runTrashGc(30);
    expect(m.close).not.toHaveBeenCalled();
    expect(m.deletedIds).toEqual([]);
    expect(s).toMatchObject({ githubFailed: 1, hardDeleted: 0 });
  });

  it('no forge client this run: rows kept; a map without a forge: rows deleted', async () => {
    m.rows = [row('n1', [link('o/r#5')])];
    m.ctx.mockRejectedValueOnce(new Error('mint failed'));
    expect((await runTrashGc(30)).hardDeleted).toBe(0);
    m.ctx.mockResolvedValueOnce(null);
    expect((await runTrashGc(30)).hardDeleted).toBe(1);
  });

  it('several links on one row: one settled, one held → the row is kept; other rows go', async () => {
    m.rows = [
      row('n1', [link('o/r#5'), link('o/r#6')]),
      row('n2', [link('o/r#7')]),
    ];
    m.probe.mockImplementation(async (_o: string, _r: string, n: number) =>
      ({ closingPrs: [], defaultBranch: 'main', landed: null, inFlight: n === 6 }));
    const s = await runTrashGc(30);
    expect(m.close).toHaveBeenCalledTimes(2); // #5 and #7
    expect(m.deletedIds).toEqual(['n2']);
    expect(s).toMatchObject({ githubClosed: 2, githubHeld: 1, hardDeleted: 1 });
  });
});
