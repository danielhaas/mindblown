/**
 * Route tests for GET /api/maps/:mapId/members — the candidate list the
 * assignee picker reads.
 *
 * The interesting property is the permission gate. /permissions is
 * admin-only because it exposes the sharing surface; members answers a
 * different question ("who works on this map?") and must be readable by
 * anyone with view access, or an editor could never populate the picker
 * they are allowed to write to.
 *
 * Mock pattern mirrors phase-node-routes.test.ts — stub the DB layer,
 * exercise route wiring without Postgres.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const getPermissionMock = vi.fn();
const listPermissionsMock = vi.fn();

vi.mock('../../db/permissions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/permissions.js')>();
  return {
    ...actual,
    getPermission: (...args: unknown[]) => getPermissionMock(...args),
    listPermissions: (...args: unknown[]) => listPermissionsMock(...args),
  };
});
vi.mock('../../lib/email.js', () => ({ sendMapInvitationEmail: vi.fn() }));

import { permissionRoutes } from '../permissions.js';

const MAP_ID = 'mmmm-mmmm-mmmm-mmmm';
const CALLER = 'uuuu-uuuu-uuuu-uuuu';

async function buildApp(authed = true): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (req) => {
    if (authed) req.userId = CALLER;
  });
  await app.register(permissionRoutes);
  return app;
}

beforeEach(() => {
  getPermissionMock.mockReset();
  listPermissionsMock.mockReset();
  listPermissionsMock.mockResolvedValue([
    { mapId: MAP_ID, userId: 'u-dan', permission: 'admin', userName: 'Daniel Haas', userEmail: 'dan@example.com' },
    { mapId: MAP_ID, userId: 'u-tom', permission: 'edit', userName: 'Thomas', userEmail: 'tom@example.com' },
  ]);
});

describe('GET /api/maps/:mapId/members', () => {
  it('returns the assignable people, flattened for the picker', async () => {
    getPermissionMock.mockResolvedValueOnce('edit');
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/maps/${MAP_ID}/members` });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json().members).toEqual([
      { userId: 'u-dan', name: 'Daniel Haas', email: 'dan@example.com', permission: 'admin' },
      { userId: 'u-tom', name: 'Thomas', email: 'tom@example.com', permission: 'edit' },
    ]);
  });

  it('is readable with view access — not admin-gated like /permissions', async () => {
    getPermissionMock.mockResolvedValueOnce('view');
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/maps/${MAP_ID}/members` });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json().members).toHaveLength(2);
  });

  it('403s for a caller with no permission on the map', async () => {
    getPermissionMock.mockResolvedValueOnce(null);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/maps/${MAP_ID}/members` });
    await app.close();

    expect(res.statusCode).toBe(403);
    expect(listPermissionsMock).not.toHaveBeenCalled();
  });

  it('401s when unauthenticated', async () => {
    const app = await buildApp(false);
    const res = await app.inject({ method: 'GET', url: `/api/maps/${MAP_ID}/members` });
    await app.close();

    expect(res.statusCode).toBe(401);
  });
});
