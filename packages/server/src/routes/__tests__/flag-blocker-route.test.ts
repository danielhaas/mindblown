/**
 * POST /api/maps/:id/nodes/:nodeId/flag-blocker — a blocker with a kind.
 *
 * The real node routes, the service mocked: what the route owns is the
 * body check (the four kinds, the kind's own fields), which service call
 * it makes and the error → status mapping. Where each kind lands is the
 * service's (services/__tests__/flagBlocker.pglite.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

vi.mock('../../db/permissions.js', () => ({ getPermission: async () => 'admin', hasPermission: () => true }));
vi.mock('../../db/nodes.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/nodes.js')>()),
  getNodeMapId: async () => null,
}));
vi.mock('../../db/maps.js', () => ({ updateMap: vi.fn(), getStatusWorkflow: vi.fn() }));
vi.mock('../../db/events.js', () => ({ recordEvent: vi.fn(async () => {}), recordFieldChanges: vi.fn(async () => {}) }));
vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../ai/embeddings.js', () => ({ scheduleEmbedNode: vi.fn() }));
vi.mock('@mindblown/integrations', () => ({ updateGitHubIssue: vi.fn(), getGitHubIssue: vi.fn() }));
vi.mock('../integrations.js', () => ({ getGitHubContextForMap: vi.fn(async () => null) }));

const flagBlockerMock = vi.hoisted(() => vi.fn());
vi.mock('../../services/flagBlocker.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/flagBlocker.js')>()),
  flagBlocker: (...args: unknown[]) => flagBlockerMock(...args),
}));

import { nodeRoutes } from '../nodes.js';
import { FlagBlockerError } from '../../services/flagBlocker.js';
import { DependencyValidationError } from '../../db/nodes.js';

const MAP_ID = 'mmmm-mmmm-mmmm-mmmm';
const NODE_ID = 'nnnn-nnnn-nnnn-nnnn';
const USER_ID = 'uuuu-uuuu-uuuu-uuuu';
const url = `/api/maps/${MAP_ID}/nodes/${NODE_ID}/flag-blocker`;

async function post(payload: unknown) {
  const app: FastifyInstance = Fastify({ logger: false });
  app.addHook('preHandler', async (req) => {
    req.userId = USER_ID;
    req.authSource = 'jwt';
  });
  await app.register(nodeRoutes);
  const res = await app.inject({ method: 'POST', url, payload: payload as object });
  await app.close();
  return res;
}

beforeEach(() => flagBlockerMock.mockReset());

describe('POST /api/maps/:id/nodes/:nodeId/flag-blocker', () => {
  it('passes the kind and its fields to the service and answers with the node', async () => {
    const node = { id: NODE_ID, blockedReason: 'Stripe or Adyen?', blockerInfo: { kind: 'question', answerer: 'Dan' } };
    flagBlockerMock.mockResolvedValueOnce({ node, kind: 'question', changedFields: ['blockedReason', 'blockerInfo'] });
    const res = await post({ kind: 'question', reason: 'Stripe or Adyen?', options: ['Stripe', 'Adyen'], answerer: 'Dan' });
    expect(res.statusCode).toBe(200);
    expect(flagBlockerMock).toHaveBeenCalledWith(MAP_ID, NODE_ID, { kind: 'question', reason: 'Stripe or Adyen?', options: ['Stripe', 'Adyen'], answerer: 'Dan' }, USER_ID);
    expect(res.json()).toEqual({ node, kind: 'question' });
  });

  it('waits-on needs no reason and returns the ticket it depends on', async () => {
    flagBlockerMock.mockResolvedValueOnce({ node: { id: NODE_ID }, kind: 'waits-on', changedFields: ['dependencies'], dependsOn: { id: 'dep', text: 'API' } });
    const res = await post({ kind: 'waits-on', waitsOn: '#62' });
    expect(res.statusCode).toBe(200);
    expect(flagBlockerMock).toHaveBeenCalledWith(MAP_ID, NODE_ID, { kind: 'waits-on', reason: '', waitsOn: '#62' }, USER_ID);
    expect(res.json().dependsOn).toEqual({ id: 'dep', text: 'API' });
  });

  it('no kind is the plain blocker (old clients)', async () => {
    flagBlockerMock.mockResolvedValueOnce({ node: { id: NODE_ID }, kind: null, changedFields: ['blockedReason'] });
    const res = await post({ reason: 'waiting on legal' });
    expect(res.statusCode).toBe(200);
    expect(flagBlockerMock).toHaveBeenCalledWith(MAP_ID, NODE_ID, { reason: 'waiting on legal' }, USER_ID);
  });

  it.each([
    [{ kind: 'vendor', reason: 'x' }, 'kind must be one of'],
    [{ kind: 'question' }, 'reason is required'],
    [{ kind: 'external', reason: 'x', recheckDays: -1 }, 'recheckDays'],
    [{ kind: 'question', reason: 'x', options: [1] }, 'options'],
  ])('refuses %j with 400', async (body, message) => {
    const res = await post(body);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain(message);
    expect(flagBlockerMock).not.toHaveBeenCalled();
  });

  it('maps the service errors: unknown node 404, no target 400, a dependency cycle 400', async () => {
    flagBlockerMock.mockRejectedValueOnce(new FlagBlockerError('NODE_NOT_FOUND', 'Node x not found'));
    expect((await post({ kind: 'question', reason: 'x' })).statusCode).toBe(404);
    flagBlockerMock.mockRejectedValueOnce(new FlagBlockerError('NO_TARGET', 'No node'));
    const noTarget = await post({ kind: 'waits-on', waitsOn: '#9' });
    expect(noTarget.statusCode).toBe(400);
    expect(noTarget.json().error.code).toBe('NO_TARGET');
    flagBlockerMock.mockRejectedValueOnce(new DependencyValidationError('cycle'));
    expect((await post({ kind: 'waits-on', waitsOn: '#9' })).json().error.code).toBe('DEPENDENCY_INVALID');
  });
});
