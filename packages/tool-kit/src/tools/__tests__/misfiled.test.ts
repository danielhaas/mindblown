/**
 * Wrong-map guard on the MCP surface: create_node says where a misfiled
 * ticket belongs, move_node_to_map moves it there.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createNodeTool, moveNodeToMapTool } from '../node.js';
import { allTools } from '../../index.js';
import type { ToolBackend } from '../../backend.js';
import type { NodeWithComputed } from '../../types.js';

const misfiled = { repo: 'danielhaas/claude-fleet', suggestedMapId: 'cf', suggestedMapName: 'claude-fleet' };

function backend(over: Partial<ToolBackend>): ToolBackend {
  return new Proxy(over as ToolBackend, {
    get: (target, key) => (key in target ? target[key as keyof ToolBackend] : async () => { throw new Error(`not used: ${String(key)}`); }),
  });
}

describe('create_node — misfiled warning', () => {
  it('prints where the ticket belongs and how to move it', async () => {
    const b = backend({ createNode: async (mapId, parentId, text) => ({ id: 'n1', mapId, parentId, text, misfiled }) as unknown as NodeWithComputed });
    const out = await createNodeTool.handler(b, { mapId: 'mb', parentId: 'root', text: 'fleet-worker (claude-fleet): x', effortEstimate: 1 } as never);
    expect(out).toContain('Created node');
    expect(out).toContain('This names danielhaas/claude-fleet, which map claude-fleet plans — move it with move_node_to_map');
  });

  it('says nothing extra for a ticket in the right map', async () => {
    const b = backend({ createNode: async (mapId, parentId, text) => ({ id: 'n1', mapId, parentId, text }) as unknown as NodeWithComputed });
    const out = await createNodeTool.handler(b, { mapId: 'mb', parentId: 'root', text: 'x', effortEstimate: 1 } as never);
    expect(out).not.toContain('move_node_to_map');
  });
});

describe('move_node_to_map tool', () => {
  it('is registered and validates its schema', () => {
    expect(allTools.some((t) => t.name === 'move_node_to_map')).toBe(true);
    const schema = z.object(moveNodeToMapTool.schema);
    expect(schema.safeParse({ nodeId: 'n', fromMapId: 'a', toMapId: 'b' }).success).toBe(true);
    expect(schema.safeParse({ nodeId: 'n', fromMapId: 'a' }).success).toBe(false);
  });

  it('round-trips the arguments to the backend and reports the notes', async () => {
    let call: unknown[] = [];
    const b = backend({
      moveNodeToMap: async (...args) => {
        call = args;
        return {
          node: { id: 'n', text: 'fleet-worker (claude-fleet): x', parentId: 'cf-root' } as NodeWithComputed,
          movedIds: ['n', 'c'],
          fromMapId: 'mb',
          toMapId: 'cf',
          toMapName: 'claude-fleet',
          notes: ['Issue link danielhaas/mindblown#1 dropped'],
        };
      },
    });
    const out = await moveNodeToMapTool.handler(b, { nodeId: 'n', fromMapId: 'mb', toMapId: 'cf', parentId: 'cf-root' });
    expect(call).toEqual(['mb', 'n', 'cf', 'cf-root']);
    expect(out).toContain('Moved "fleet-worker (claude-fleet): x" (id: n) with 1 node(s) below it to map claude-fleet (cf), under cf-root.');
    expect(out).toContain('- Issue link danielhaas/mindblown#1 dropped');
  });
});
