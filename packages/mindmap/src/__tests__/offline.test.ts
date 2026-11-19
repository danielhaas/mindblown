/**
 * Read-only offline mode (#572): a read that gets no response is answered
 * from the last copy and flips the app to offline; a write still fails; the
 * next response clears the flag; sign-out drops the copies.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

if (typeof globalThis.localStorage === 'undefined') {
  const mem = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
    key: () => null,
    get length() {
      return mem.size;
    },
  } as Storage;
}

// Minimal Cache Storage: one named cache of URL → Response.
const stores = new Map<string, Map<string, Response>>();
globalThis.caches = {
  open: async (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name)!;
    return {
      put: async (k: string, r: Response) => void m.set(k, r),
      match: async (k: string) => m.get(k)?.clone(),
    } as unknown as Cache;
  },
  delete: async (name: string) => stores.delete(name),
} as unknown as CacheStorage;

const api = await import('../api.js');
const { useOffline } = await import('../offline.js');

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const down = () => vi.fn(async () => {
  throw new TypeError('Failed to fetch');
});
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  stores.clear();
  useOffline.setState({ offline: false, servedFrom: null });
});
afterEach(() => vi.unstubAllGlobals());

describe('offline mode (#572)', () => {
  it('serves the last copy of a read when the server is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json([{ id: 'm1', name: 'Plan' }])));
    await api.fetchMaps();
    await flush();
    expect(useOffline.getState().offline).toBe(false);

    vi.stubGlobal('fetch', down());
    expect(await api.fetchMaps()).toEqual([{ id: 'm1', name: 'Plan' }]);
    expect(useOffline.getState().offline).toBe(true);
    expect(useOffline.getState().servedFrom).toMatch(/^\d{4}-/);
  });

  it('rethrows a read with no saved copy, but still marks offline', async () => {
    vi.stubGlobal('fetch', down());
    await expect(api.fetchMaps()).rejects.toBeInstanceOf(TypeError);
    expect(useOffline.getState().offline).toBe(true);
  });

  it('never answers a write from the cache', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ id: 'n1' })));
    await api.updateNode('m1', 'n1', { text: 'x' });
    await flush();
    vi.stubGlobal('fetch', down());
    await expect(api.updateNode('m1', 'n1', { text: 'x' })).rejects.toBeInstanceOf(TypeError);
    expect(useOffline.getState().offline).toBe(true);
  });

  it('clears offline on the next response, error or not', async () => {
    useOffline.setState({ offline: true, servedFrom: null });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    await expect(api.fetchMaps()).rejects.toBeInstanceOf(api.ApiError);
    expect(useOffline.getState().offline).toBe(false);
  });

  it('drops the saved copies on sign-out', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json([{ id: 'm1' }])));
    await api.fetchMaps();
    await flush();
    api.clearToken();
    await flush();
    vi.stubGlobal('fetch', down());
    await expect(api.fetchMaps()).rejects.toBeInstanceOf(TypeError);
  });
});
