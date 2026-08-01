/**
 * Attachment routes — hanging a file or a link on a node.
 *
 * The interesting behaviour is not "does it store the thing" but the three
 * rules around it: a URL is validated as `http(s)` before it can reach a
 * renderer, adding one attachment doesn't rewrite the whole array (the
 * reason these are sub-resource routes at all), and a delete is scoped to
 * one id rather than a wholesale replace.
 *
 * DB layer stubbed in the mocked-helper style used by the other route
 * tests here — no Postgres needed to exercise wiring.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const MAP_ID = 'mmmm-mmmm';
const NODE_ID = 'nnnn-nnnn';

// The stub keeps a real array so "append, don't replace" is observable.
let stored: Array<Record<string, unknown>> = [];

// `vi.mock` factories are hoisted above every declaration in the file, so
// the error class the route does `instanceof` against has to be hoisted
// with them.
const { AttachmentValidationError } = vi.hoisted(() => ({
  AttachmentValidationError: class extends Error {},
}));

const addAttachmentMock = vi.fn(
  async (
    _nodeId: string,
    input: { kind: string; url: string; title?: string },
    addedBy: string | null,
  ) => {
    if (!/^https?:\/\//.test(input.url)) {
      throw new AttachmentValidationError('URL muss mit http:// oder https:// beginnen');
    }
    stored.push({ id: `att-${stored.length + 1}`, ...input, addedBy });
    return { id: NODE_ID, mapId: MAP_ID, attachments: [...stored] };
  },
);

const removeAttachmentMock = vi.fn(async (_nodeId: string, attachmentId: string) => {
  const next = stored.filter((a) => a.id !== attachmentId);
  if (next.length === stored.length) return null;
  stored = next;
  return { id: NODE_ID, mapId: MAP_ID, attachments: [...stored] };
});

vi.mock('../../db/nodes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/nodes.js')>();
  return {
    ...actual,
    AttachmentValidationError,
    addAttachment: (...a: unknown[]) =>
      addAttachmentMock(a[0] as string, a[1] as never, a[2] as string | null),
    removeAttachment: (...a: unknown[]) => removeAttachmentMock(a[0] as string, a[1] as string),
    getNode: async () => null,
    updateNode: vi.fn(),
    createNode: vi.fn(),
  };
});

vi.mock('../../db/maps.js', () => ({ updateMap: vi.fn() }));
vi.mock('../../db/events.js', () => ({
  recordEvent: vi.fn(async () => {}),
  recordFieldChanges: vi.fn(async () => {}),
}));
const broadcastMock = vi.fn();
vi.mock('../../ws.js', () => ({ broadcast: (...a: unknown[]) => broadcastMock(...a) }));
vi.mock('../../ai/embeddings.js', () => ({ scheduleEmbedNode: vi.fn() }));
vi.mock('@mindblown/integrations', () => ({ updateGitHubIssue: vi.fn(), getGitHubIssue: vi.fn() }));
vi.mock('../integrations.js', () => ({ getGitHubContextForMap: vi.fn(async () => null) }));

import { nodeRoutes } from '../nodes.js';

let app: FastifyInstance;

beforeEach(async () => {
  stored = [];
  vi.clearAllMocks();
  app = Fastify();
  app.addHook('preHandler', async (req) => {
    (req as { userId?: string }).userId = 'user-1';
  });
  await app.register(nodeRoutes);
  await app.ready();
});

const post = (payload: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: `/api/maps/${MAP_ID}/nodes/${NODE_ID}/attachments`,
    payload,
  });

describe('POST .../attachments', () => {
  it('hangs a file on the node and reports who did it', async () => {
    const res = await post({
      kind: 'file',
      url: 'https://mind.project.li/api/media/abc/bericht.xlsx.bin',
      title: 'Quartalsbericht.xlsx',
      mimeType: 'application/vnd.ms-excel',
      sizeBytes: 4096,
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().attachments).toHaveLength(1);
    expect(addAttachmentMock.mock.calls[0][2]).toBe('user-1');
  });

  it('hangs a plain link on the node', async () => {
    const res = await post({ kind: 'link', url: 'https://example.com/spec', title: 'Spec' });

    expect(res.statusCode).toBe(201);
    expect(res.json().attachments[0]).toMatchObject({ kind: 'link', title: 'Spec' });
  });

  it('appends rather than replacing — two adds leave two attachments', async () => {
    // The whole reason this is a sub-resource and not a field on PUT: a
    // client that had to send the array back would drop whatever another
    // client added between its read and its write.
    await post({ kind: 'link', url: 'https://example.com/a' });
    const res = await post({ kind: 'link', url: 'https://example.com/b' });

    expect(res.json().attachments).toHaveLength(2);
  });

  it('refuses a URL scheme a renderer must never be handed', async () => {
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox',
      '/relative/path',
    ]) {
      const res = await post({ kind: 'link', url });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('ATTACHMENT_VALIDATION_ERROR');
    }
    expect(stored).toHaveLength(0);
  });

  it('400s without kind or url instead of storing a half-formed row', async () => {
    expect((await post({ kind: 'link' })).statusCode).toBe(400);
    expect((await post({ url: 'https://example.com' })).statusCode).toBe(400);
    expect(stored).toHaveLength(0);
  });

  it('tells the other browser tabs, so an open map updates itself', async () => {
    await post({ kind: 'link', url: 'https://example.com/a' });

    expect(broadcastMock).toHaveBeenCalledWith(
      MAP_ID,
      expect.objectContaining({ type: 'node:updated', fields: ['attachments'] }),
    );
  });
});

describe('DELETE .../attachments/:attachmentId', () => {
  it('removes exactly the one named and leaves the rest', async () => {
    await post({ kind: 'link', url: 'https://example.com/a' });
    await post({ kind: 'link', url: 'https://example.com/b' });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/maps/${MAP_ID}/nodes/${NODE_ID}/attachments/att-1`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().attachments).toHaveLength(1);
    expect(res.json().attachments[0].url).toBe('https://example.com/b');
  });

  it('404s an id that is not on this node rather than reporting success', async () => {
    await post({ kind: 'link', url: 'https://example.com/a' });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/maps/${MAP_ID}/nodes/${NODE_ID}/attachments/att-does-not-exist`,
    });

    expect(res.statusCode).toBe(404);
    expect(stored).toHaveLength(1);
  });
});
