/**
 * POST /api/maps/:id/pull-next — route wiring for get_next_ticket.
 *
 * The decision logic is covered in services/__tests__/pull-queue.test.ts;
 * this file pins the HTTP adapter: body validation, pass-through of
 * sessionId/profile, and error translation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const mocks = vi.hoisted(() => ({
  getNextTicket: vi.fn(),
}));

vi.mock('../../services/orchestration.js', () => {
  class OrchestrationNotFoundError extends Error {}
  class ClaimOwnershipError extends Error {}
  return {
    readyNodes: vi.fn(),
    claimNode: vi.fn(),
    releaseNode: vi.fn(),
    conflictScan: vi.fn(),
    getNextTicket: mocks.getNextTicket,
    OrchestrationNotFoundError,
    ClaimOwnershipError,
  };
});

import { orchestrationRoutes } from '../orchestration.js';
import { OrchestrationNotFoundError } from '../../services/orchestration.js';

let app: FastifyInstance;

beforeEach(async () => {
  mocks.getNextTicket.mockReset();
  app = Fastify();
  await app.register(orchestrationRoutes);
  await app.ready();
});

describe('POST /api/maps/:id/pull-next', () => {
  it('400s without a sessionId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/pull-next',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(mocks.getNextTicket).not.toHaveBeenCalled();
  });

  it('forwards mapId, sessionId, and the profile to the service', async () => {
    const result = {
      granted: true,
      active: 1,
      cap: 12,
      ticket: { id: 'n1', text: 'Fix it' },
      skipped: [],
    };
    mocks.getNextTicket.mockResolvedValue(result);
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/pull-next',
      payload: { sessionId: 'claudia:worker-3:acct1', profile: 'standard' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(result);
    expect(mocks.getNextTicket).toHaveBeenCalledWith(
      'map-1',
      'claudia:worker-3:acct1',
      'standard',
    );
  });

  it('passes refusals through as 200s (a refusal is a normal answer)', async () => {
    mocks.getNextTicket.mockResolvedValue({
      granted: false,
      reason: 'hold',
      active: 0,
      cap: 0,
      skipped: [],
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-1/pull-next',
      payload: { sessionId: 'w1' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reason).toBe('hold');
  });

  it('404s when the service reports the map missing', async () => {
    mocks.getNextTicket.mockRejectedValue(new OrchestrationNotFoundError('Map map-x not found'));
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/map-x/pull-next',
      payload: { sessionId: 'w1' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('MAP_NOT_FOUND');
  });
});
