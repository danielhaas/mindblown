/**
 * The orchestration routes (#111) — mounted for real (#117).
 *
 * This file used to build an inline Fastify app that RE-IMPLEMENTED the
 * handlers and asserted against that copy: "26 tests passing", 0 lines of
 * routes/orchestration.ts covered. Now the real `orchestrationRoutes` is
 * registered over a mocked service layer, and the tests pin what the route
 * owns: parameter parsing, validation, which service call it makes, and how
 * service errors map to HTTP. The rules themselves (ready, claim, release,
 * conflict scan, stale-claim sweep) are tested on the real service in
 * services/__tests__/ and sync/__tests__/staleClaimSweeper.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

vi.mock('../../db/permissions.js', () => ({ getPermission: async () => 'admin', hasPermission: () => true }));
vi.mock('../../db/nodes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/nodes.js')>();
  return { ...actual, getNodeMapId: async () => 'm1' };
});
vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));

const svc = vi.hoisted(() => ({
  readyNodes: vi.fn(),
  claimNode: vi.fn(),
  releaseNode: vi.fn(),
  conflictScan: vi.fn(),
  getNextTicket: vi.fn(),
}));
vi.mock('../../services/orchestration.js', () => {
  class OrchestrationNotFoundError extends Error {}
  class ClaimOwnershipError extends Error {}
  return { ...svc, OrchestrationNotFoundError, ClaimOwnershipError };
});

import { orchestrationRoutes } from '../orchestration.js';
import { OrchestrationNotFoundError, ClaimOwnershipError } from '../../services/orchestration.js';

async function app(): Promise<FastifyInstance> {
  const a = Fastify({ logger: false });
  a.addHook('preHandler', async (req) => {
    req.userId = 'user-1';
  });
  await a.register(orchestrationRoutes);
  return a;
}
async function call(method: 'GET' | 'POST', url: string, payload?: unknown) {
  const a = await app();
  const res = await a.inject({ method, url, payload: payload as never });
  await a.close();
  return res;
}

beforeEach(() => {
  for (const f of Object.values(svc)) f.mockReset();
});

describe('GET /api/maps/:id/nodes/ready', () => {
  it('parses limit, scope (comma list) and sprint into the service call and returns its result', async () => {
    svc.readyNodes.mockResolvedValue({ mapId: 'm1', ready: [], total: 0, returned: 0 });
    const res = await call('GET', '/api/maps/m1/nodes/ready?limit=5&scope=apps/a,%20db&sprint=all');
    expect(res.statusCode).toBe(200);
    expect(svc.readyNodes).toHaveBeenCalledWith('m1', { limit: 5, scopeFilter: ['apps/a', 'db'], sprint: 'all' });
    expect(res.json()).toEqual({ mapId: 'm1', ready: [], total: 0, returned: 0 });
  });

  it('maps not-found errors to 404 with the matching code', async () => {
    for (const [message, code] of [
      ['Map m1 not found', 'MAP_NOT_FOUND'],
      ['Sprint s9 not found on map m1', 'SPRINT_NOT_FOUND'],
    ] as const) {
      svc.readyNodes.mockRejectedValueOnce(new OrchestrationNotFoundError(message));
      const res = await call('GET', '/api/maps/m1/nodes/ready');
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe(code);
    }
  });
});

describe('POST /api/maps/:id/nodes/:nodeId/claim', () => {
  it('400 without a sessionId — the service is never called', async () => {
    const res = await call('POST', '/api/maps/m1/nodes/n1/claim', {});
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(svc.claimNode).not.toHaveBeenCalled();
  });

  it('claims through the service and returns its result (incl. a soft warning)', async () => {
    const result = { node: { id: 'n1', text: 't', claimedBySession: 's1', claimedAt: 'x' }, claimed: true, warned: true, warning: 'was s0' };
    svc.claimNode.mockResolvedValue(result);
    const res = await call('POST', '/api/maps/m1/nodes/n1/claim', { sessionId: 's1' });
    expect(res.statusCode).toBe(200);
    expect(svc.claimNode).toHaveBeenCalledWith('m1', 'n1', 's1');
    expect(res.json()).toEqual(result);
  });

  it('an unknown node is a 404 NODE_NOT_FOUND', async () => {
    svc.claimNode.mockRejectedValue(new OrchestrationNotFoundError('Node n1 not found'));
    const res = await call('POST', '/api/maps/m1/nodes/n1/claim', { sessionId: 's1' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NODE_NOT_FOUND');
  });
});

describe('POST /api/maps/:id/nodes/:nodeId/release', () => {
  it('400 without a sessionId', async () => {
    expect((await call('POST', '/api/maps/m1/nodes/n1/release', { reason: 'x' })).statusCode).toBe(400);
    expect(svc.releaseNode).not.toHaveBeenCalled();
  });

  it('releasing another session\'s claim is a 403 CLAIM_OWNERSHIP_ERROR', async () => {
    svc.releaseNode.mockRejectedValue(new ClaimOwnershipError('claimed by s2'));
    const res = await call('POST', '/api/maps/m1/nodes/n1/release', { sessionId: 's1' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('CLAIM_OWNERSHIP_ERROR');
  });

  it('passes through a successful release', async () => {
    svc.releaseNode.mockResolvedValue({ node: { id: 'n1', text: 't' }, released: true, alreadyReleased: false });
    const res = await call('POST', '/api/maps/m1/nodes/n1/release', { sessionId: 's1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ released: true });
  });
});

describe('conflict scan', () => {
  it('per node: scans with the candidate; map-wide: without one', async () => {
    svc.conflictScan.mockResolvedValue({ candidateId: 'n1', candidateScopes: [], conflicts: [], duplicateLinks: [] });
    expect((await call('GET', '/api/maps/m1/nodes/n1/conflict-scan')).statusCode).toBe(200);
    expect(svc.conflictScan).toHaveBeenLastCalledWith('m1', 'n1');
    svc.conflictScan.mockResolvedValue({ candidateId: null, candidateScopes: [], conflicts: [], duplicateLinks: [] });
    expect((await call('GET', '/api/maps/m1/conflict-scan')).statusCode).toBe(200);
    expect(svc.conflictScan.mock.calls.at(-1)?.[1]).toBeUndefined();
  });

  it('an unknown candidate is a 404', async () => {
    svc.conflictScan.mockRejectedValue(new OrchestrationNotFoundError('Node n9 not found'));
    expect((await call('GET', '/api/maps/m1/nodes/n9/conflict-scan')).statusCode).toBe(404);
  });
});
