/**
 * release_node — the optional `reason` reaches the backend.
 *
 * The client scripts release for several reasons (never started, dead
 * worker, resize reconcile, blocked.sh); the reason is the only thing
 * that distinguishes them in the node's claim trail, so the tool must
 * forward it verbatim and stay a plain release without it.
 */

import { describe, it, expect, vi } from 'vitest';
import { releaseNodeTool } from '../orchestration.js';
import type { ToolBackend } from '../../backend.js';

function backendWith(releaseNode: ToolBackend['releaseNode']): ToolBackend {
  const unimplemented = () => { throw new Error('not implemented'); };
  return { releaseNode, claimNode: unimplemented, getNextTicket: unimplemented } as unknown as ToolBackend;
}

describe('release_node reason', () => {
  it('forwards the reason as the fourth backend argument', async () => {
    const releaseNode = vi.fn(async () => ({ node: { id: 'n1', text: 'Ship it' }, released: true }));
    const out = await releaseNodeTool.handler(backendWith(releaseNode), {
      mapId: 'm1',
      nodeId: 'n1',
      sessionId: 'njoerd:worker-3:default',
      reason: 'dead worker',
    });
    expect(releaseNode).toHaveBeenCalledWith('m1', 'n1', 'njoerd:worker-3:default', 'dead worker');
    expect(out).toContain('Released claim on node n1');
  });

  it('is optional — an omitted reason is passed through as undefined', async () => {
    const releaseNode = vi.fn(async () => ({ node: { id: 'n1', text: 'Ship it' }, released: false, alreadyReleased: true }));
    const out = await releaseNodeTool.handler(backendWith(releaseNode), {
      mapId: 'm1',
      nodeId: 'n1',
      sessionId: 'njoerd:worker-3:default',
    });
    expect(releaseNode).toHaveBeenCalledWith('m1', 'n1', 'njoerd:worker-3:default', undefined);
    expect(out).toContain('was not claimed');
  });
});
