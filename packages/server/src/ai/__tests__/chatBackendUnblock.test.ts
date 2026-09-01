/**
 * createChatBackend().unblockNode — the in-app chat's clear_blocker path.
 *
 * It is the one ToolBackend implementation that fans out the broadcast
 * itself (the REST route does it for the MCP/HTTP path), so pin: the
 * service is called with the chatting user, the node:updated broadcast
 * carries the changed fields, and the result shape is what clear_blocker
 * renders (status + claimedBySession + statusReset).
 */
import { describe, it, expect, vi } from 'vitest';

const unblockMock = vi.fn();
const broadcastMock = vi.fn();

vi.mock('../../db/maps.js', () => ({}));
vi.mock('../../db/nodes.js', () => ({}));
vi.mock('../../ws.js', () => ({ broadcast: (...args: unknown[]) => broadcastMock(...args) }));
vi.mock('../embeddings.js', () => ({ scheduleEmbedNode: vi.fn() }));
vi.mock('../../services/orchestration.js', () => ({}));
vi.mock('../../services/unblock.js', () => ({ unblockNode: (...args: unknown[]) => unblockMock(...args) }));
vi.mock('../../sync/closedIssueAudit.js', () => ({ auditClosedIssues: vi.fn() }));
vi.mock('../../lib/githubContext.js', () => ({ getGitHubContextForMap: vi.fn() }));

import { createChatBackend } from '../backend.js';

describe('chat backend — unblockNode', () => {
  it('attributes the write to the chatting user, broadcasts node:updated, returns the clear_blocker shape', async () => {
    const node = { id: 'n1', text: '#8755 FM relay', status: 'todo', claimedBySession: null, tags: [] };
    unblockMock.mockResolvedValueOnce({ node, statusReset: true, changedFields: ['blockedReason', 'tags', 'status'] });

    const result = await createChatBackend('user-42').unblockNode('map-1', 'n1');

    expect(unblockMock).toHaveBeenCalledWith('map-1', 'n1', 'user-42');
    expect(broadcastMock).toHaveBeenCalledWith('map-1', {
      type: 'node:updated',
      nodeId: 'n1',
      fields: ['blockedReason', 'tags', 'status'],
      node,
    });
    expect(result).toEqual({ node: { id: 'n1', text: '#8755 FM relay', status: 'todo', claimedBySession: null }, statusReset: true });
  });
});
