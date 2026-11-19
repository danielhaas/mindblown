/**
 * Ready work outside the dispatch gate on the MCP surface: create_node says
 * when a new ticket got the map's active version and takes versionId: null;
 * get_next_ticket prints gatedOut with `empty`.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createNodeTool } from '../node.js';
import { bulkCreateNodesTool } from '../bulk.js';
import { getNextTicketTool } from '../orchestration.js';
import type { GetNextTicketResult, ToolBackend } from '../../backend.js';
import type { NodeWithComputed } from '../../types.js';

function backend(over: Partial<ToolBackend>): ToolBackend {
  return new Proxy(over as ToolBackend, {
    get: (target, key) => (key in target ? target[key as keyof ToolBackend] : async () => { throw new Error(`not used: ${String(key)}`); }),
  });
}

describe('create_node — the gate default', () => {
  it('says the ticket went into the active version', async () => {
    const b = backend({ createNode: async (mapId, parentId, text) => ({ id: 'n1', mapId, parentId, text, versionDefault: { id: 'v1', name: 'V1' } }) as unknown as NodeWithComputed });
    const out = await createNodeTool.handler(b, { mapId: 'm', parentId: 'root', text: 'TeamSnap OAuth', effortEstimate: 1 } as never);
    expect(out).toContain('Added to V1 (versionId: v1)');
  });

  it('passes an explicit versionId: null through, and says nothing extra', async () => {
    let fields: Record<string, unknown> = {};
    const b = backend({ createNode: async (mapId, parentId, text, f) => { fields = f ?? {}; return { id: 'n1', mapId, parentId, text } as unknown as NodeWithComputed; } });
    expect(z.object(createNodeTool.schema).safeParse({ mapId: 'm', parentId: 'r', text: 't', versionId: null }).success).toBe(true);
    const out = await createNodeTool.handler(b, { mapId: 'm', parentId: 'root', text: 'x', versionId: null, effortEstimate: 1 } as never);
    expect(fields.versionId).toBeNull();
    expect(out).not.toContain('Added to');
  });

  it('bulk_create_nodes notes the default per row', async () => {
    const b = backend({ createNode: async (mapId, parentId, text) => ({ id: 'n1', mapId, parentId, text, versionDefault: { id: 'v1', name: 'V1' } }) as unknown as NodeWithComputed });
    const out = await bulkCreateNodesTool.handler(b, { mapId: 'm', nodes: [{ parentId: 'root', text: 'a' }] } as never);
    expect(out).toContain('added to V1, the active version');
  });
});

describe('get_next_ticket — gatedOut with empty', () => {
  const empty = (extra: Partial<GetNextTicketResult>): GetNextTicketResult => ({ granted: false, reason: 'empty', active: 0, cap: 2, skipped: [], ...extra });

  it('a map pull prints the gated-out count', async () => {
    const b = backend({ getNextTicket: async () => empty({ gatedOut: { count: 10, unversioned: 4 } }) });
    const out = await getNextTicketTool.handler(b, { mapId: 'm', sessionId: 's' } as never);
    expect(out).toContain('gatedOut: 10 ready ticket(s) outside the dispatch gate (4 unversioned)');
  });

  it('a fleet pull names it per map', async () => {
    const b = backend({
      pullFleetTicket: async () =>
        empty({ gatedOut: { count: 10, unversioned: 4 }, maps: [{ mapId: 'navy', name: 'Navy App', reason: 'empty', gatedOut: { count: 10, unversioned: 4 } }] }),
    });
    const out = await getNextTicketTool.handler(b, { fleetId: '11111111-2222-3333-4444-555555555555', sessionId: 's' } as never);
    expect(out).toContain('Navy App (mapId: navy): empty — 10 ready outside the gate (4 unversioned)');
  });

  it('no gatedOut → no line', async () => {
    const b = backend({ getNextTicket: async () => empty({}) });
    expect(await getNextTicketTool.handler(b, { mapId: 'm', sessionId: 's' } as never)).not.toContain('gatedOut');
  });
});
