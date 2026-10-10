/**
 * handlePrClosed stamps the mirror with the PR's own close time when one
 * is passed (#423): a replayed close must not look newer than a done
 * claim made after the PR really died (livelock rule, core/linkedPr.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExternalLink, LinkedPrState } from '@mindblown/core';

const updateNode = vi.fn();
const mirror: LinkedPrState = {
  number: 9, repo: 'o/r', url: 'u', head: 'h', base: 'main', author: null, draft: false,
  state: 'open', mergeable: null, changedFiles: [], reviews: [], checks: { state: null, failures: [] },
  lastSyncedAt: '2026-10-01T00:00:00Z',
};
const link = { provider: 'gitea', externalId: 'o/r#5', url: 'u', syncEnabled: true, lastSyncedAt: null } as ExternalLink;

vi.mock('../../db/connection.js', () => ({
  db: { select: () => ({ from: () => ({ where: async () => [{ id: 'n1', externalLinks: [link], linkedPr: mirror }] }) }) },
}));
vi.mock('../../db/schema.js', () => ({ nodes: {} }));
vi.mock('../../db/nodes.js', () => ({
  updateNode: (...a: unknown[]) => updateNode(...a),
  notDeleted: {},
  onActiveMap: {},
}));

import { handlePrClosed } from '../prSync.js';

const pr = { number: 9, title: 't', body: 'Closes #5', state: 'closed', merged: false, draft: false, head: { ref: 'h', sha: 's' }, base: { ref: 'main' }, html_url: 'u', user: null, mergeable: null } as const;

beforeEach(() => updateNode.mockReset());

describe('handlePrClosed closedAt', () => {
  it('a replay stamps the PR\'s close time on the mirror', async () => {
    await handlePrClosed('o/r', { ...pr }, 'main', '2026-10-05T00:00:00Z');
    expect(updateNode).toHaveBeenCalledWith('n1', { linkedPr: expect.objectContaining({ state: 'closed', lastSyncedAt: '2026-10-05T00:00:00Z' }) });
  });

  it('the live webhook (no closedAt) stamps the delivery time, as before', async () => {
    const before = Date.now();
    await handlePrClosed('o/r', { ...pr }, 'main');
    const stamped = Date.parse((updateNode.mock.calls[0][1] as { linkedPr: LinkedPrState }).linkedPr.lastSyncedAt!);
    expect(stamped).toBeGreaterThanOrEqual(before - 1000);
  });
});
