/**
 * store.stopFleetTicket (#549): the Stop button's write. One PUT of the
 * blocker and nothing else — no expectedRevision, since the worker writes
 * progress and ETA to the same node meanwhile — and the server's node is
 * applied. A failure leaves the node alone and says so.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

const { useMindmapStore } = await import('../store.js');

const node = (id: string) =>
  ({ id, mapId: 'm1', parentId: null, childrenIds: [], text: id, blockedReason: null, revision: 3, dependencies: [], externalLinks: [], tags: [] }) as never;

const blocker = (id: string) => (useMindmapStore.getState().nodes as Record<string, { blockedReason: string | null }>)[id].blockedReason;

beforeEach(() => {
  useMindmapStore.setState({ currentMapId: 'm1', nodes: { a: node('a') }, error: null } as never);
});

describe('stopFleetTicket (#549)', () => {
  it('PUTs only the blocker, without a revision, and applies the server node', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ...(node('a') as object), blockedReason: 'Stopped by Dan: x', revision: 5 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    expect(await useMindmapStore.getState().stopFleetTicket('a', 'Stopped by Dan: x')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/api/maps/m1/nodes/a');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ blockedReason: 'Stopped by Dan: x' });
    expect(blocker('a')).toBe('Stopped by Dan: x');
  });

  it('a failed write leaves the node unblocked and sets the error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'No edit access' } }), { status: 403 })));
    expect(await useMindmapStore.getState().stopFleetTicket('a', 'Stopped by Dan')).toBe(false);
    expect(blocker('a')).toBeNull();
    expect(useMindmapStore.getState().error).toBeTruthy();
  });

  it('a ticket no longer on the map writes nothing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await useMindmapStore.getState().stopFleetTicket('gone', 'Stopped by Dan')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
