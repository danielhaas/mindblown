/**
 * Verifies the in-process Fastify `inject` fast path for the api client.
 *
 * Two acceptance criteria for the #68 perf change:
 *  1. When the bound `ApiContext` carries an `injector`, every
 *     `api.*` call goes through it — not through `fetch`. That's
 *     the whole point of the change (skips a localhost TCP hop).
 *  2. When no injector is bound (stdio MCP, escape-hatch case in the
 *     HTTP route), `request()` falls back to the existing fetch
 *     codepath unchanged — so nothing breaks for unmigrated callers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runWithApiContext, type Injector } from '../api.js';
import * as api from '../api.js';

describe('api client — in-process injector fast path', () => {
  // Stash the real fetch so we can restore it between tests.
  const realFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Stub global fetch so an accidental network call would be loud
    // (and so the no-injector branch can be asserted against).
    fetchMock = vi.fn(async () =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('routes every api call through the bound injector when one is provided (fetch is never called)', async () => {
    const injector = vi.fn(async () => ({
      statusCode: 200,
      body: JSON.stringify([{ id: 'm1', name: 'Demo' }]),
      headers: { 'content-type': 'application/json' },
    }));

    const maps = await runWithApiContext(
      { baseUrl: 'http://unused.invalid', token: 'mb_test', injector },
      () => api.listMaps(),
    );

    expect(maps).toEqual([{ id: 'm1', name: 'Demo' }]);
    expect(injector).toHaveBeenCalledTimes(1);
    expect(injector).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        url: '/api/maps',
        headers: expect.objectContaining({ Authorization: 'Bearer mb_test' }),
      }),
    );
    // Critical perf invariant: NO network call.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards POST body + Content-Type through the injector unchanged', async () => {
    const injector: Injector = vi.fn(async () => ({
      statusCode: 200,
      body: JSON.stringify({ id: 'n1', text: 'hi' }),
      headers: {},
    }));
    const injectorMock = injector as unknown as ReturnType<typeof vi.fn>;

    await runWithApiContext(
      { baseUrl: 'http://unused.invalid', token: 'mb_test', injector },
      () => api.createNode('map1', 'parent1', 'hi'),
    );

    expect(injectorMock).toHaveBeenCalledTimes(1);
    const calls = injectorMock.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const call = calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call.method).toBe('POST');
    expect(call.url).toBe('/api/maps/map1/nodes');
    expect(call.headers['Content-Type']).toBe('application/json');
    expect(call.headers['Authorization']).toBe('Bearer mb_test');
    expect(typeof call.payload).toBe('string');
    expect(JSON.parse(call.payload)).toEqual({ parentId: 'parent1', text: 'hi' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps non-2xx injector responses to ApiError with the server-side error code', async () => {
    const injector = vi.fn(async () => ({
      statusCode: 403,
      body: JSON.stringify({ error: { code: 'FORBIDDEN', message: 'no soup for you' } }),
      headers: {},
    }));

    await expect(
      runWithApiContext(
        { baseUrl: 'http://unused.invalid', token: 'mb_test', injector },
        () => api.listMaps(),
      ),
    ).rejects.toMatchObject({
      name: 'ApiError',
      status: 403,
      code: 'FORBIDDEN',
      message: 'no soup for you',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns undefined on a 204 No Content injector response', async () => {
    const injector = vi.fn(async () => ({
      statusCode: 204,
      body: '',
      headers: {},
    }));

    const result = await runWithApiContext(
      { baseUrl: 'http://unused.invalid', token: 'mb_test', injector },
      () => api.deleteMap('map1'),
    );
    expect(result).toBeUndefined();
    expect(injector).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'DELETE', url: '/api/maps/map1' }),
    );
  });

  it('falls back to fetch when no injector is bound (escape hatch / stdio path)', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify([{ id: 'm2', name: 'Stdio' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    // No injector field on the context — same as the legacy/stdio config
    // and the same as the HTTP route's escape-hatch branch.
    const maps = await runWithApiContext(
      { baseUrl: 'http://escape-hatch.invalid', token: 'mb_escape' },
      () => api.listMaps(),
    );

    expect(maps).toEqual([{ id: 'm2', name: 'Stdio' }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://escape-hatch.invalid/api/maps');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer mb_escape');
  });
});
