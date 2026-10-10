/**
 * store.bulkUpdateNodes (#115): a Gantt renumber is ONE optimistic batch
 * and ONE request; failures are per item (conflict → server version,
 * anything else → revert), a failed request reverts the batch.
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

const node = (id: string, rank: number) =>
  ({ id, mapId: 'm1', parentId: null, childrenIds: [], text: id, priorityRank: rank, revision: 3, dependencies: [], externalLinks: [], tags: [] }) as never;

const respond = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

const ranks = () => {
  const n = useMindmapStore.getState().nodes as Record<string, { priorityRank: number }>;
  return ['a', 'b', 'c'].map((id) => n[id].priorityRank);
};
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  useMindmapStore.setState({ currentMapId: 'm1', nodes: { a: node('a', 1), b: node('b', 1), c: node('c', 1) }, error: null } as never);
});

describe('bulkUpdateNodes (#115)', () => {
  it('applies the batch optimistically and sends exactly one PATCH with every item and its revision', async () => {
    const fetchMock = respond({ results: [], updated: 3, failed: 0 });
    vi.stubGlobal('fetch', fetchMock);
    useMindmapStore.getState().bulkUpdateNodes(['a', 'b', 'c'].map((id, i) => ({ id, updates: { priorityRank: (i + 1) * 65536 } })));
    expect(ranks()).toEqual([65536, 131072, 196608]);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/api/maps/m1/nodes/bulk');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body)).updates).toEqual([
      { id: 'a', fields: { priorityRank: 65536 }, expectedRevision: 3 },
      { id: 'b', fields: { priorityRank: 131072 }, expectedRevision: 3 },
      { id: 'c', fields: { priorityRank: 196608 }, expectedRevision: 3 },
    ]);
  });

  it('per-item failure: a conflict takes the server version, another error reverts that node only', async () => {
    vi.stubGlobal(
      'fetch',
      respond({
        results: [
          { id: 'a', ok: true, node: node('a', 65536) },
          { id: 'b', ok: false, status: 409, error: { code: 'REVISION_CONFLICT', message: 'x', current: node('b', 42) } },
          { id: 'c', ok: false, status: 400, error: { code: 'VALIDATION_ERROR', message: 'x' } },
        ],
        updated: 1,
        failed: 2,
      }),
    );
    useMindmapStore.getState().bulkUpdateNodes(['a', 'b', 'c'].map((id, i) => ({ id, updates: { priorityRank: (i + 1) * 65536 } })));
    await flush();
    await flush();
    expect(ranks()).toEqual([65536, 42, 1]);
    expect(useMindmapStore.getState().error).toContain('2 of 3 updates failed');
  });

  it('a failed request reverts the whole batch', async () => {
    vi.stubGlobal('fetch', respond({ error: { code: 'X', message: 'down' } }, 500));
    useMindmapStore.getState().bulkUpdateNodes(['a', 'b'].map((id) => ({ id, updates: { priorityRank: 99 } })));
    await flush();
    await flush();
    expect(ranks()).toEqual([1, 1, 1]);
  });
});
