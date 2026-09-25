/**
 * `POST …/attachments/file` — the inline (base64) door for callers that
 * cannot speak multipart, i.e. an MCP tool handler.
 *
 * Real temp directory, stubbed DB layer: what is worth pinning is the
 * plumbing between the two — that the bytes land on disk under our naming
 * rules, that the attachment points at them, and that a refused attach
 * takes the stored file with it. The attachment rules themselves live in
 * db/__tests__/attachments.test.ts; the naming rules in lib/media tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const MAP_ID = 'mmmm-mmmm';
const NODE_ID = 'nnnn-nnnn';
/** The DB layer answers "no such node" for this id. */
const MISSING_NODE_ID = 'gone-gone';

let stored: Array<Record<string, unknown>> = [];

const { AttachmentValidationError } = vi.hoisted(() => ({
  AttachmentValidationError: class extends Error {},
}));

const addAttachmentMock = vi.fn(
  async (nodeId: string, input: Record<string, unknown>, addedBy: string | null) => {
    if (nodeId === MISSING_NODE_ID) {
      throw new AttachmentValidationError(`Node ${nodeId} not found`);
    }
    stored.push({ id: `att-${stored.length + 1}`, ...input, addedBy });
    return { id: nodeId, mapId: MAP_ID, attachments: [...stored] };
  },
);

vi.mock('../../db/nodes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/nodes.js')>();
  return {
    ...actual,
    AttachmentValidationError,
    addAttachment: (...a: unknown[]) =>
      addAttachmentMock(a[0] as string, a[1] as Record<string, unknown>, a[2] as string | null),
    removeAttachment: vi.fn(),
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
let dir: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  stored = [];
  vi.clearAllMocks();
  dir = await mkdtemp(path.join(tmpdir(), 'mb-attach-file-'));
  for (const k of ['MEDIA_DIR', 'FRONTEND_URL', 'MEDIA_PUBLIC_BASE_URL']) savedEnv[k] = process.env[k];
  process.env.MEDIA_DIR = dir;
  process.env.FRONTEND_URL = 'https://mind.example';
  delete process.env.MEDIA_PUBLIC_BASE_URL;

  app = Fastify();
  app.addHook('preHandler', async (req) => {
    (req as { userId?: string }).userId = 'user-1';
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

const post = (nodeId: string, payload: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: `/api/maps/${MAP_ID}/nodes/${nodeId}/attachments/file`,
    payload,
  });

describe('POST .../attachments/file', () => {
  it('stores the bytes under our naming rules and hangs the URL on the node', async () => {
    const content = Buffer.from('%PDF-1.4 fake report');
    const res = await post(NODE_ID, {
      filename: 'Quartalsbericht Q3.pdf',
      contentType: 'application/pdf',
      contentBase64: content.toString('base64'),
    });

    expect(res.statusCode).toBe(201);
    const [att] = res.json().attachments;
    expect(att).toMatchObject({
      kind: 'file',
      mimeType: 'application/pdf',
      sizeBytes: content.length,
      addedBy: 'user-1',
    });
    // Inline type: our extension from the table, readable stem, absolute URL.
    expect(att.url).toMatch(/^https:\/\/mind\.example\/api\/media\/[0-9a-f]{40}\/Quartalsbericht-Q3\.pdf$/);
    expect(att.title).toBe('Quartalsbericht-Q3.pdf');

    const [id] = await readdir(dir);
    const [file] = await readdir(path.join(dir, id));
    expect(await readFile(path.join(dir, id, file))).toEqual(content);

    expect(broadcastMock).toHaveBeenCalledWith(
      MAP_ID,
      expect.objectContaining({ type: 'node:updated', nodeId: NODE_ID, fields: ['attachments'] }),
    );
  });

  it('stores a non-inline type as a download and shows the person the real name', async () => {
    const res = await post(NODE_ID, {
      filename: 'export.xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      contentBase64: Buffer.from('PK...').toString('base64'),
    });

    expect(res.statusCode).toBe(201);
    const [att] = res.json().attachments;
    expect(att.url).toMatch(/\/export\.xlsx\.bin$/);
    // The title is what the Files list shows — never the `.bin`.
    expect(att.title).toBe('export.xlsx');
  });

  it('defaults the type when the caller sends none', async () => {
    const res = await post(NODE_ID, {
      filename: 'notes.txt',
      contentBase64: Buffer.from('hi').toString('base64'),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().attachments[0].mimeType).toBe('application/octet-stream');
  });

  it('refuses an oversized file with the multipart alternative, and stores nothing', async () => {
    const big = Buffer.alloc(8 * 1024 * 1024 + 1, 1);
    const res = await post(NODE_ID, {
      filename: 'big.bin',
      contentType: 'application/octet-stream',
      contentBase64: big.toString('base64'),
    });

    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('FILE_TOO_LARGE');
    expect(res.json().error.message).toContain('/api/media');
    expect(await readdir(dir)).toEqual([]);
    expect(addAttachmentMock).not.toHaveBeenCalled();
  });

  it('removes the stored file again when the node refuses the attachment', async () => {
    const res = await post(MISSING_NODE_ID, {
      filename: 'orphan.pdf',
      contentType: 'application/pdf',
      contentBase64: Buffer.from('x').toString('base64'),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('ATTACHMENT_VALIDATION_ERROR');
    // Nothing under an id nobody points at.
    expect(await readdir(dir)).toEqual([]);
  });

  it('rejects what is not base64 instead of storing the few bytes the decoder salvages', async () => {
    const res = await post(NODE_ID, {
      filename: 'x.pdf',
      contentType: 'application/pdf',
      contentBase64: 'this is not base64 !!',
    });
    expect(res.statusCode).toBe(400);
    expect(await readdir(dir)).toEqual([]);
  });

  it('rejects a request without a filename or without content', async () => {
    expect((await post(NODE_ID, { contentBase64: 'aGk=' })).statusCode).toBe(400);
    expect((await post(NODE_ID, { filename: 'a.pdf' })).statusCode).toBe(400);
    expect((await post(NODE_ID, { filename: 'a.pdf', contentBase64: '' })).statusCode).toBe(400);
  });
});
