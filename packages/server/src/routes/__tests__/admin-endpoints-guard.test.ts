/**
 * Route-level admin-guard tests (closes #69).
 *
 * Each admin endpoint must:
 *   1. 403 when called with a session-JWT-authed non-admin user.
 *   2. 200 (or normal flow) when called with a session-JWT-authed admin.
 *   3. 403 when called with an API-key-authed user — even if that user
 *      IS the admin.
 *
 * `requireAdmin` is mocked so we exercise route wiring (does the route
 * pass `req` through and short-circuit on falsy?) without standing up
 * Postgres. There's a separate `requireAdmin.test.ts` that locks down the
 * helper's own logic (the api-key rejection + DB lookup).
 *
 * Together: helper-level test proves the api-key short-circuit; this test
 * proves every admin route consults the helper and 403s correctly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// ── Mocks ─────────────────────────────────────────────────────────
// Toggle for the requireAdmin stub so we can flip admin/non-admin per test
// without re-registering the route handlers.
let requireAdminReturn = false;
const requireAdminMock = vi.fn(
  async (req: { userId?: string; authSource?: 'jwt' | 'api-key' }) => {
    // Mirror the real helper's contract so the test catches a route that
    // passes `userId` instead of `req` (regression for the original API):
    // if the stub ever sees `undefined` userId we'd be testing the wrong
    // wiring.
    if (!req || typeof req !== 'object') return false;
    if (req.authSource === 'api-key') return false;
    if (!req.userId) return false;
    return requireAdminReturn;
  },
);

vi.mock('../../auth.js', () => ({
  requireAdmin: (req: { userId?: string; authSource?: 'jwt' | 'api-key' }) =>
    requireAdminMock(req),
}));

// Settings store the routes mutate. Keep them as no-op stubs returning the
// input — the test only cares about the 403 gate, not what happens after.
vi.mock('../../db/settings.js', () => ({
  getRegistrationPolicy: vi.fn(async () => ({ mode: 'open', allowlist: [] })),
  setRegistrationPolicy: vi.fn(async (p: unknown) => p),
  getAiProviderSettings: vi.fn(async () => ({ preference: 'auto' })),
  setAiProviderSettings: vi.fn(async (s: unknown) => s),
}));

// Drift audit's downstream — used by the admin endpoint in integrations.ts.
vi.mock('../../sync/driftAudit.js', () => ({
  runDriftAudit: vi.fn(async () => ({
    reports: [],
    tokenErrors: [],
    autoBackfill: { totalImported: 0, totalManualPending: 0 },
  })),
}));

// The integrations route module imports a LOT of DB + GitHub helpers that
// we don't need for the admin-guard test. Stub everything the import graph
// touches to keep this test focused.
vi.mock('../../db/connection.js', () => ({ db: {} }));
vi.mock('../../db/schema.js', () => ({
  integrations: {},
  versions: {},
  nodes: {},
  maps: {},
}));
vi.mock('../../db/nodes.js', () => ({
  getNode: vi.fn(),
  createNode: vi.fn(),
  updateNode: vi.fn(),
}));
vi.mock('@mindblown/integrations', () => ({
  createGitHubIssue: vi.fn(),
  getGitHubIssue: vi.fn(),
  importGitHubIssues: vi.fn(),
  extractVersionFromMilestone: vi.fn(),
  processWebhook: vi.fn(),
  verifyWebhookSignature: vi.fn(),
  mintInstallationToken: vi.fn(),
  isGitHubAppConfigured: vi.fn(() => false),
}));
vi.mock('../../sync/githubCatchup.js', () => ({ reconcileRepo: vi.fn() }));
vi.mock('../../sync/parentEpicRollup.js', () => ({
  rollupParentsForChildTitle: vi.fn(),
}));
vi.mock('../../sync/githubIngest.js', () => ({
  ingestNewIssuesForRepo: vi.fn(),
  ensureInboxNode: vi.fn(),
  ensureNodeForIssue: vi.fn(),
  findNodesByExternalIds: vi.fn(),
}));
vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('drizzle-orm', () => ({ eq: vi.fn(), and: vi.fn() }));

import { systemRoutes } from '../system.js';
import { integrationRoutes } from '../integrations.js';

// ── Test harness ──────────────────────────────────────────────────

const ADMIN_UID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

async function buildApp(authSource: 'jwt' | 'api-key' | 'none'): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (req) => {
    if (authSource === 'none') return;
    req.userId = ADMIN_UID;
    req.authSource = authSource;
  });
  await app.register(systemRoutes);
  await app.register(integrationRoutes);
  return app;
}

beforeEach(() => {
  requireAdminReturn = false;
  requireAdminMock.mockClear();
});

// ── Cases ─────────────────────────────────────────────────────────

describe('admin endpoints — JWT admin (positive control)', () => {
  it('PUT /api/system/registration-policy → 200 for admin JWT', async () => {
    requireAdminReturn = true;
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'PUT',
      url: '/api/system/registration-policy',
      payload: { mode: 'open', allowlist: [] },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(requireAdminMock).toHaveBeenCalledOnce();
    const calledWith = requireAdminMock.mock.calls[0][0];
    expect(calledWith.userId).toBe(ADMIN_UID);
    expect(calledWith.authSource).toBe('jwt');
  });

  it('PUT /api/system/ai-provider → 200 for admin JWT', async () => {
    requireAdminReturn = true;
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'PUT',
      url: '/api/system/ai-provider',
      payload: { preference: 'auto' },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
  });

  it('POST /api/maps/sync/audit-drift → 200 for admin JWT', async () => {
    requireAdminReturn = true;
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/sync/audit-drift',
    });
    await app.close();
    expect(res.statusCode).toBe(200);
  });
});

describe('admin endpoints — non-admin JWT (negative control)', () => {
  it('PUT /api/system/registration-policy → 403 for non-admin JWT', async () => {
    requireAdminReturn = false;
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'PUT',
      url: '/api/system/registration-policy',
      payload: { mode: 'open', allowlist: [] },
    });
    await app.close();
    expect(res.statusCode).toBe(403);
    expect(res.json().error?.code).toBe('FORBIDDEN');
  });

  it('PUT /api/system/ai-provider → 403 for non-admin JWT', async () => {
    requireAdminReturn = false;
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'PUT',
      url: '/api/system/ai-provider',
      payload: { preference: 'auto' },
    });
    await app.close();
    expect(res.statusCode).toBe(403);
    expect(res.json().error?.code).toBe('FORBIDDEN');
  });

  it('POST /api/maps/sync/audit-drift → 403 for non-admin JWT', async () => {
    requireAdminReturn = false;
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/sync/audit-drift',
    });
    await app.close();
    expect(res.statusCode).toBe(403);
    expect(res.json().error?.code).toBe('FORBIDDEN');
  });
});

describe('admin endpoints — API-key auth (closes #69)', () => {
  // requireAdminReturn is `true` here — the user IS an admin in the DB.
  // The api-key short-circuit in requireAdmin still has to win, because
  // the routes pass `req` (which has authSource='api-key') and the helper
  // rejects api-key auth even for admin users.

  it('PUT /api/system/registration-policy → 403 even when user is admin', async () => {
    requireAdminReturn = true;
    const app = await buildApp('api-key');
    const res = await app.inject({
      method: 'PUT',
      url: '/api/system/registration-policy',
      payload: { mode: 'invite_only', allowlist: [] },
    });
    await app.close();
    expect(res.statusCode).toBe(403);
    expect(res.json().error?.code).toBe('FORBIDDEN');
    // The stub mirrors the real helper — it received the req object with
    // authSource='api-key' and returned false BEFORE checking is_admin.
    expect(requireAdminMock).toHaveBeenCalledOnce();
    expect(requireAdminMock.mock.calls[0][0].authSource).toBe('api-key');
  });

  it('PUT /api/system/ai-provider → 403 even when user is admin', async () => {
    requireAdminReturn = true;
    const app = await buildApp('api-key');
    const res = await app.inject({
      method: 'PUT',
      url: '/api/system/ai-provider',
      payload: { preference: 'anthropic' },
    });
    await app.close();
    expect(res.statusCode).toBe(403);
    expect(res.json().error?.code).toBe('FORBIDDEN');
  });

  it('POST /api/maps/sync/audit-drift → 403 even when user is admin', async () => {
    requireAdminReturn = true;
    const app = await buildApp('api-key');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/sync/audit-drift',
    });
    await app.close();
    expect(res.statusCode).toBe(403);
    expect(res.json().error?.code).toBe('FORBIDDEN');
  });
});

describe('admin endpoints — unauthenticated', () => {
  it('PUT /api/system/registration-policy → 403 (no userId)', async () => {
    const app = await buildApp('none');
    const res = await app.inject({
      method: 'PUT',
      url: '/api/system/registration-policy',
      payload: { mode: 'open', allowlist: [] },
    });
    await app.close();
    expect(res.statusCode).toBe(403);
  });

  it('POST /api/maps/sync/audit-drift → 401 (no userId)', async () => {
    // This route specifically pre-checks userId and returns 401 before the
    // requireAdmin call — a holdover from before #69 that's still correct.
    const app = await buildApp('none');
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/sync/audit-drift',
    });
    await app.close();
    expect(res.statusCode).toBe(401);
    expect(res.json().error?.code).toBe('UNAUTHORIZED');
  });
});
