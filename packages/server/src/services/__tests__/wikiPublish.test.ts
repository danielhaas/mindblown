/**
 * Publish to wiki (#637): the first publish creates the Outline document and
 * stores its id on the map; the second updates that same document. Storage
 * is an in-memory stand-in for db/wiki.ts; Outline is a fake fetch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => ({
  config: null as null | { baseUrl: string; token: string; collectionId: string },
  docs: new Map<string, { mapId: string; provider: string; documentId: string; documentUrl: string; publishedAt: string }>(),
  ownerId: 'owner' as string | null,
}));

vi.mock('../../db/wiki.js', () => ({
  mapWorkspace: async (mapId: string) => (mapId === 'missing' ? null : { workspaceId: 'ws', ownerId: store.ownerId }),
  getOutlineConfig: async () => store.config,
  saveOutlineConfig: async (_ws: string, c: typeof store.config) => {
    store.config = c;
  },
  getWikiDocument: async (mapId: string) => store.docs.get(mapId) ?? null,
  saveWikiDocument: async (mapId: string, d: { documentId: string; documentUrl: string; publishedAt: Date }) => {
    store.docs.set(mapId, { mapId, provider: 'outline', documentId: d.documentId, documentUrl: d.documentUrl, publishedAt: d.publishedAt.toISOString() });
  },
}));

const statusWorkflow = [
  { id: 'todo', name: 'Todo', category: 'todo', color: '#ccc', position: 0 },
  { id: 'done', name: 'Done', category: 'done', color: '#0f0', position: 1 },
];
const n = (id: string, over: Record<string, unknown> = {}) => ({
  id, mapId: 'm1', parentId: null, childrenIds: [], text: id, description: null, effortEstimate: 1,
  percentComplete: null, status: null, blockedReason: null, tags: [], dependencies: [], externalLinks: [],
  startDate: null, dueDate: null, completedAt: null, priority: null, priorityRank: null, createdAt: '2026-01-01T00:00:00Z',
  ...over,
});
vi.mock('../../db/maps.js', () => ({
  getMap: async (mapId: string) =>
    mapId === 'missing'
      ? null
      : {
          map: {
            id: mapId, workspaceId: 'ws', name: 'Loke-Support', rootNodeId: 'root', effortUnit: 'days', hoursPerDay: 8,
            workerCount: 1, focusFactor: 1, projectStartDate: '2026-11-02', holidayJurisdiction: null,
            holidayOverrides: { add: [], remove: [] }, statusWorkflow,
          },
          nodes: [n('root', { text: 'Loke-Support', childrenIds: ['m1'] }), n('m1', { text: 'M1', parentId: 'root' })],
        },
}));

import { publishMapToWiki, saveWikiSettings, wikiStatus, WikiForbiddenError, WikiNotConfiguredError, WikiPublishError, WikiValidationError } from '../wikiPublish.js';

/** A fake Outline: documents by id, counting creates. */
function fakeOutline() {
  const docs = new Map<string, { title: string; text: string; collectionId: string }>();
  let seq = 0;
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const method = url.split('/api/')[1];
    calls.push(method);
    const body = JSON.parse(init.body as string);
    if (method === 'documents.create') {
      const id = `doc-${++seq}`;
      docs.set(id, { title: body.title, text: body.text, collectionId: body.collectionId });
      return new Response(JSON.stringify({ data: { id, url: `/doc/${id}` } }), { status: 200 });
    }
    if (method === 'documents.update') {
      const doc = docs.get(body.id);
      if (!doc) return new Response(JSON.stringify({ ok: false, error: 'not_found', message: 'Not found' }), { status: 404 });
      docs.set(body.id, { ...doc, title: body.title, text: body.text });
      return new Response(JSON.stringify({ data: { id: body.id, url: `/doc/${body.id}` } }), { status: 200 });
    }
    return new Response('{}', { status: 400 });
  });
  return { docs, calls, fetch: fetchImpl as unknown as typeof fetch };
}

beforeEach(() => {
  store.config = { baseUrl: 'https://wiki.example.com', token: 'ol_api_plain', collectionId: 'col-1' };
  store.docs.clear();
  store.ownerId = 'owner';
  delete process.env.ENCRYPTION_KEY;
  process.env.FRONTEND_URL = 'https://mind.example';
  delete process.env.PUBLIC_URL;
});

describe('publishMapToWiki', () => {
  it('publishing twice updates one document rather than creating two', async () => {
    const outline = fakeOutline();
    const first = await publishMapToWiki('m1', { fetch: outline.fetch, now: new Date('2026-11-19T08:00:00Z') });
    const second = await publishMapToWiki('m1', { fetch: outline.fetch, now: new Date('2026-11-20T08:00:00Z') });

    expect(first).toMatchObject({ documentId: 'doc-1', documentUrl: 'https://wiki.example.com/doc/doc-1', created: true });
    expect(second).toMatchObject({ documentId: 'doc-1', created: false, publishedAt: '2026-11-20T08:00:00.000Z' });
    expect(outline.calls).toEqual(['documents.create', 'documents.update']);
    expect(outline.docs.size).toBe(1);
    expect(store.docs.get('m1')?.documentId).toBe('doc-1');
  });

  it('the page is titled after the map, says it is read-only and links back to the map', async () => {
    const outline = fakeOutline();
    await publishMapToWiki('m1', { fetch: outline.fetch });
    const doc = outline.docs.get('doc-1')!;
    expect(doc.title).toBe('Loke-Support — timeline');
    expect(doc.collectionId).toBe('col-1');
    expect(doc.text).not.toMatch(/^# /);
    expect(doc.text).toMatch(/^> \*\*Generated from MindBlown — do not edit here\.\*\*/);
    expect(doc.text).toContain('(https://mind.example/?map=m1)');
    expect(doc.text).toContain('## M1');
  });

  it('creates a fresh page when the stored one was deleted in the wiki', async () => {
    const outline = fakeOutline();
    store.docs.set('m1', { mapId: 'm1', provider: 'outline', documentId: 'gone', documentUrl: 'x', publishedAt: '2026-01-01T00:00:00.000Z' });
    const r = await publishMapToWiki('m1', { fetch: outline.fetch });
    expect(outline.calls).toEqual(['documents.update', 'documents.create']);
    expect(r).toMatchObject({ documentId: 'doc-1', created: true });
    expect(store.docs.get('m1')?.documentId).toBe('doc-1');
  });

  it('says so when no wiki is connected; turns an Outline refusal into WikiPublishError', async () => {
    store.config = null;
    await expect(publishMapToWiki('m1', { fetch: fakeOutline().fetch })).rejects.toBeInstanceOf(WikiNotConfiguredError);

    store.config = { baseUrl: 'https://wiki.example.com', token: 'bad', collectionId: 'col-1' };
    const denied = vi.fn(async () => new Response(JSON.stringify({ message: 'Authentication required' }), { status: 401 }));
    const err = await publishMapToWiki('m1', { fetch: denied as unknown as typeof fetch }).catch((e) => e);
    expect(err).toBeInstanceOf(WikiPublishError);
    expect(err.message).toContain('Authentication required');
    expect(store.docs.size).toBe(0);
  });

  it('null for an unknown map', async () => {
    expect(await publishMapToWiki('missing', { fetch: fakeOutline().fetch })).toBeNull();
  });
});

describe('wiki settings', () => {
  it('only the workspace owner sets them; the token is never shown and kept when omitted', async () => {
    store.config = null;
    await expect(saveWikiSettings('m1', { baseUrl: 'https://w.example', token: 't', collectionId: 'c' }, 'someone-else')).rejects.toBeInstanceOf(WikiForbiddenError);
    await expect(saveWikiSettings('m1', { baseUrl: 'https://w.example', collectionId: 'c' }, 'owner')).rejects.toBeInstanceOf(WikiValidationError);
    await expect(saveWikiSettings('m1', { baseUrl: 'ftp://w.example', token: 't', collectionId: 'c' }, 'owner')).rejects.toBeInstanceOf(WikiValidationError);

    const status = await saveWikiSettings('m1', { baseUrl: 'https://w.example/', token: ' tok ', collectionId: 'c1' }, 'owner');
    expect(status).toEqual({ configured: true, provider: 'outline', baseUrl: 'https://w.example', collectionId: 'c1', document: null });
    expect(JSON.stringify(status)).not.toContain('tok');
    // (Re-read through a cast: TS narrowed store.config to null above.)
    expect((store.config as { token: string } | null)?.token).toBe('tok');

    await saveWikiSettings('m1', { baseUrl: 'https://w.example', collectionId: 'c2' }, 'owner');
    expect(store.config).toEqual({ baseUrl: 'https://w.example', token: 'tok', collectionId: 'c2' });
  });

  it('reports the published page', async () => {
    await publishMapToWiki('m1', { fetch: fakeOutline().fetch, now: new Date('2026-11-19T08:00:00Z') });
    expect((await wikiStatus('m1'))?.document).toEqual({ id: 'doc-1', url: 'https://wiki.example.com/doc/doc-1', publishedAt: '2026-11-19T08:00:00.000Z' });
  });
});
