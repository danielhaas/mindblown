/**
 * Tests the MCP route's per-request injector wiring (#68).
 *
 * The route's contract:
 *  - When `MINDBLOWN_INTERNAL_API_URL` is UNSET, `buildMcpInjector` returns
 *    a wrapper around `app.inject`. Each tool call runs the full Fastify
 *    request lifecycle in-process — no TCP roundtrip.
 *  - When `MINDBLOWN_INTERNAL_API_URL` IS SET, it returns `undefined`,
 *    which makes the @mindblown/mcp api client fall back to its existing
 *    `fetch(baseUrl + path)` codepath. That's the escape hatch.
 *
 * We verify both branches plus the property that the injector wrapper
 * forwards all four request fields (method, url, headers, payload) and
 * passes through the response shape unchanged.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { buildMcpInjector } from '../mcp.js';

describe('buildMcpInjector — env-var branching', () => {
  const prev = process.env.MINDBLOWN_INTERNAL_API_URL;

  beforeEach(() => {
    delete process.env.MINDBLOWN_INTERNAL_API_URL;
  });

  afterEach(() => {
    if (prev == null) delete process.env.MINDBLOWN_INTERNAL_API_URL;
    else process.env.MINDBLOWN_INTERNAL_API_URL = prev;
  });

  it('returns an injector function when MINDBLOWN_INTERNAL_API_URL is unset (default fast path)', async () => {
    const app = Fastify({ logger: false });
    const inj = buildMcpInjector(app);
    expect(typeof inj).toBe('function');
    await app.close();
  });

  it('returns undefined when MINDBLOWN_INTERNAL_API_URL is set (escape hatch)', async () => {
    process.env.MINDBLOWN_INTERNAL_API_URL = 'http://test-escape-hatch.invalid:9999';
    const app = Fastify({ logger: false });
    const inj = buildMcpInjector(app);
    expect(inj).toBeUndefined();
    await app.close();
  });
});

describe('buildMcpInjector — routes through app.inject when bound', () => {
  let app: FastifyInstance;
  const prev = process.env.MINDBLOWN_INTERNAL_API_URL;

  beforeEach(async () => {
    delete process.env.MINDBLOWN_INTERNAL_API_URL;
    app = Fastify({ logger: false });
    // A trivial GET route, and a POST that echoes its body — the inject
    // wrapper has to faithfully forward both.
    app.get('/api/maps', async (req, _reply) => {
      return [{ id: 'm1', name: 'Demo', auth: req.headers.authorization }];
    });
    app.post('/api/maps/:mapId/nodes', async (req, _reply) => {
      return {
        receivedParams: req.params,
        receivedBody: req.body,
        receivedAuth: req.headers.authorization,
      };
    });
    app.delete('/api/maps/:mapId', async (_req, reply) => {
      return reply.status(204).send();
    });
    app.get('/api/forbidden', async (_req, reply) => {
      return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'no soup' } });
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    if (prev == null) delete process.env.MINDBLOWN_INTERNAL_API_URL;
    else process.env.MINDBLOWN_INTERNAL_API_URL = prev;
  });

  it('forwards a GET through app.inject and returns the response shape the api client expects', async () => {
    const injector = buildMcpInjector(app)!;
    const res = await injector({
      method: 'GET',
      url: '/api/maps',
      headers: { Authorization: 'Bearer mb_fake' },
    });
    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed).toEqual([{ id: 'm1', name: 'Demo', auth: 'Bearer mb_fake' }]);
  });

  it('forwards a POST body and params through app.inject', async () => {
    const injector = buildMcpInjector(app)!;
    const res = await injector({
      method: 'POST',
      url: '/api/maps/map1/nodes',
      headers: {
        Authorization: 'Bearer mb_fake',
        'Content-Type': 'application/json',
      },
      payload: JSON.stringify({ parentId: 'parent1', text: 'hi' }),
    });
    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.receivedParams).toEqual({ mapId: 'map1' });
    expect(parsed.receivedBody).toEqual({ parentId: 'parent1', text: 'hi' });
    expect(parsed.receivedAuth).toBe('Bearer mb_fake');
  });

  it('preserves 204 No Content responses through the inject path', async () => {
    const injector = buildMcpInjector(app)!;
    const res = await injector({
      method: 'DELETE',
      url: '/api/maps/map1',
      headers: { Authorization: 'Bearer mb_fake' },
    });
    expect(res.statusCode).toBe(204);
    // body for 204 is an empty string (LightMyRequest's stringified body)
    expect(res.body === '' || res.body == null).toBe(true);
  });

  it('preserves a non-2xx response (status + body) for ApiError propagation', async () => {
    const injector = buildMcpInjector(app)!;
    const res = await injector({
      method: 'GET',
      url: '/api/forbidden',
      headers: { Authorization: 'Bearer mb_fake' },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({
      error: { code: 'FORBIDDEN', message: 'no soup' },
    });
  });
});
