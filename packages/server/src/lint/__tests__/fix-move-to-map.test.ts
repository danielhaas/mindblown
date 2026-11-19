/**
 * plan_fix move-to-map (misfiled-repo): detection runs again at fix time,
 * the node goes to the map that plans the repo it names, a stale finding
 * is refused.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  node: null as Record<string, unknown> | null,
  detect: vi.fn(),
  move: vi.fn(),
}));

vi.mock('../../db/nodes.js', () => ({ getNode: vi.fn(async () => h.node), updateNode: vi.fn() }));
vi.mock('../../db/maps.js', () => ({ getStatusWorkflow: vi.fn(async () => []) }));
vi.mock('../../db/events.js', () => ({ recordFieldChanges: vi.fn(), recordClaimTransition: vi.fn(), recordEvent: vi.fn() }));
vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../routes/nodes.js', () => ({ syncNodeToGitHub: vi.fn(async () => {}) }));
vi.mock('../../lib/githubContext.js', () => ({ getGitHubContextForMap: vi.fn(async () => null) }));
vi.mock('../../services/unblock.js', () => ({ unblockNode: vi.fn(), UnblockNotFoundError: class extends Error {} }));
vi.mock('../../services/misfiled.js', () => ({ detectMisfiled: h.detect }));
vi.mock('../../services/moveToMap.js', () => ({ moveNodeToMap: h.move }));

import { applyLintFix } from '../fix.js';

beforeEach(() => {
  vi.clearAllMocks();
  h.node = { id: 'ticket', mapId: 'mb', text: 'fleet-worker (claude-fleet): x', childrenIds: [], tags: ['misfiled?'] };
});

describe('applyLintFix — move-to-map', () => {
  it('moves the node to the map that plans the repo it names', async () => {
    h.detect.mockResolvedValue({ repo: 'danielhaas/claude-fleet', suggestedMapId: 'cf', suggestedMapName: 'claude-fleet' });
    h.move.mockResolvedValue({ node: { ...h.node, mapId: 'cf' }, movedIds: ['ticket'], fromMapId: 'mb', toMapId: 'cf', toMapName: 'claude-fleet', notes: ['n'] });
    const r = await applyLintFix('mb', 'ticket', 'move-to-map', 'dan');
    expect(h.move).toHaveBeenCalledWith({ nodeId: 'ticket', fromMapId: 'mb', toMapId: 'cf', userId: 'dan' });
    expect(r).toMatchObject({ action: 'move-to-map', changedFields: ['mapId'], moved: { toMapId: 'cf', toMapName: 'claude-fleet', movedIds: ['ticket'], notes: ['n'] } });
    expect(r.node.mapId).toBe('cf');
  });

  it('refuses a stale finding: the node no longer names another map\'s repo', async () => {
    h.detect.mockResolvedValue(null);
    await expect(applyLintFix('mb', 'ticket', 'move-to-map', 'dan')).rejects.toMatchObject({ code: 'NOT_MISFILED' });
    expect(h.move).not.toHaveBeenCalled();
  });
});
