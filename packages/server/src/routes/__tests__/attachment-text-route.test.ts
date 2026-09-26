/**
 * `GET …/attachments/:attachmentId/text` — the read path behind
 * `read_attachment`.
 *
 * Wiring only: the attachment is looked up on the node, paging query
 * parameters reach the reader, a readable file answers 200 with the page,
 * a file with no text answers 200 with `readable: false` and its URL, and
 * a missing node or attachment is a 404. What counts as text, and how a
 * PDF is read, is pinned in lib/__tests__/attachmentText.test.ts against
 * the same temp-directory layout used here.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const MAP_ID = 'mmmm-mmmm';
const NODE_ID = 'nnnn-nnnn';
/** A node that exists but belongs to another map. */
const FOREIGN_NODE_ID = 'ffff-ffff';
const MEDIA_ID = 'b'.repeat(40);
const BASE = 'https://mind.example';

const TEXT_ATT = {
  id: 'att-text',
  kind: 'file',
  url: `${BASE}/api/media/${MEDIA_ID}/spec.md.bin`,
  title: 'spec.md',
  mimeType: 'text/markdown',
  sizeBytes: 26,
  addedAt: '2026-09-26T00:00:00Z',
};
const LINK_ATT = {
  id: 'att-link',
  kind: 'link',
  url: 'https://example.com/design',
  title: 'design',
  addedAt: '2026-09-26T00:00:00Z',
};

vi.mock('../../db/nodes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/nodes.js')>();
  return {
    ...actual,
    getNode: async (nodeId: string) => {
      if (nodeId === NODE_ID) return { id: NODE_ID, mapId: MAP_ID, attachments: [TEXT_ATT, LINK_ATT] };
      if (nodeId === FOREIGN_NODE_ID) return { id: FOREIGN_NODE_ID, mapId: 'other-map', attachments: [TEXT_ATT] };
      return null;
    },
    addAttachment: vi.fn(),
    removeAttachment: vi.fn(),
    updateNode: vi.fn(),
    createNode: vi.fn(),
  };
});
vi.mock('../../db/maps.js', () => ({ updateMap: vi.fn() }));
// The route checks the map, not just the node: only `member` can view MAP_ID.
vi.mock('../../db/permissions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/permissions.js')>();
  return {
    ...actual,
    getPermission: async (mapId: string, userId: string) =>
      mapId === MAP_ID && userId === 'member' ? 'view' : null,
  };
});
vi.mock('../../db/events.js', () => ({
  recordEvent: vi.fn(async () => {}),
  recordFieldChanges: vi.fn(async () => {}),
}));
vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../ai/embeddings.js', () => ({ scheduleEmbedNode: vi.fn() }));
vi.mock('@mindblown/integrations', () => ({ updateGitHubIssue: vi.fn(), getGitHubIssue: vi.fn() }));
vi.mock('../integrations.js', () => ({ getGitHubContextForMap: vi.fn(async () => null) }));

import { nodeRoutes } from '../nodes.js';

let app: FastifyInstance;
let dir: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'mb-attach-text-'));
  for (const k of ['MEDIA_DIR', 'FRONTEND_URL', 'MEDIA_PUBLIC_BASE_URL']) savedEnv[k] = process.env[k];
  process.env.MEDIA_DIR = dir;
  process.env.FRONTEND_URL = BASE;
  delete process.env.MEDIA_PUBLIC_BASE_URL;

  await mkdir(path.join(dir, MEDIA_ID), { recursive: true });
  await writeFile(path.join(dir, MEDIA_ID, 'spec.md.bin'), '# Spec\n\nRead me from a tool.\n');

  app = Fastify();
  app.addHook('preHandler', async (req) => {
    (req as { userId?: string }).userId = (req.headers['x-test-user'] as string | undefined) ?? 'member';
  });
  await app.register(nodeRoutes);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const get = (nodeId: string, attachmentId: string, query = '', opts: { mapId?: string; user?: string } = {}) =>
  app.inject({
    method: 'GET',
    url: `/api/maps/${opts.mapId ?? MAP_ID}/nodes/${nodeId}/attachments/${attachmentId}/text${query}`,
    headers: opts.user ? { 'x-test-user': opts.user } : {},
  });

describe('GET .../attachments/:attachmentId/text', () => {
  it('answers the stored text with its metadata', async () => {
    const res = await get(NODE_ID, 'att-text');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      readable: true,
      attachmentId: 'att-text',
      filename: 'spec.md',
      contentType: 'text/markdown',
      sizeBytes: 29,
      pages: null,
      totalChars: 29,
      offset: 0,
      text: '# Spec\n\nRead me from a tool.\n',
      truncated: false,
    });
  });

  it('pages by offset and limit from the query string', async () => {
    const res = await get(NODE_ID, 'att-text', '?offset=8&limit=7');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ offset: 8, text: 'Read me', truncated: true, totalChars: 29 });
  });

  it('ignores unparsable paging values', async () => {
    const res = await get(NODE_ID, 'att-text', '?offset=abc&limit=');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ offset: 0, truncated: false });
  });

  it('answers 200 readable:false with the URL for a link', async () => {
    const res = await get(NODE_ID, 'att-link');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      readable: false,
      attachmentId: 'att-link',
      reason: 'link',
      message: expect.stringContaining('link'),
      url: 'https://example.com/design',
    });
  });

  it('404s for an unknown attachment and for an unknown node', async () => {
    expect((await get(NODE_ID, 'att-nope')).statusCode).toBe(404);
    expect((await get('gone-gone', 'att-text')).statusCode).toBe(404);
  });

  it('403s a user who cannot view the map, before looking at the node', async () => {
    const res = await get(NODE_ID, 'att-text', '', { user: 'stranger' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('404s a node from another map asked for under a map the caller can view', async () => {
    // `member` may view MAP_ID. A node id from another map, guessed or
    // remembered, must not answer that map's file through MAP_ID's URL.
    const res = await get(FOREIGN_NODE_ID, 'att-text', '', { user: 'member' });
    expect(res.statusCode).toBe(404);
  });
});
