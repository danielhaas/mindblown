/**
 * Route tests for the verification fields on the node write surface.
 *
 * `verificationText` / `verificationUrl` / `verificationVideoUrl` are what
 * the Requirements view puts in front of a non-technical reviewer before he
 * presses ✓ or ✗ (the Abnahme card). They are plain nullable TEXT columns —
 * no validation, no GitHub sync — so the only thing that can break is the
 * wiring, and the wiring is exactly what silently drops a field.
 *
 * `verificationVideoUrl` is the newest of the three; these cases pin it to
 * the same behaviour as its two siblings on both write routes, including
 * the null-clears-it path (an omitted field and an explicit null mean
 * different things to db/nodes.ts `updateNode`).
 *
 * Mock pattern mirrors phase-node-routes.test.ts — stub the DB layer +
 * side-effect modules, exercise route wiring without Postgres.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// ── Mocks ─────────────────────────────────────────────────────────

const createNodeMock = vi.fn();
const updateNodeMock = vi.fn();
const getNodeMock = vi.fn(async () => null);

vi.mock('../../db/nodes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/nodes.js')>();
  return {
    ...actual,
    createNode: (...args: unknown[]) => createNodeMock(...args),
    updateNode: (...args: unknown[]) => updateNodeMock(...args),
    getNode: (...args: unknown[]) => getNodeMock(),
  };
});

vi.mock('../../db/maps.js', () => ({ updateMap: vi.fn() }));
vi.mock('../../db/events.js', () => ({
  recordEvent: vi.fn(async () => {}),
  recordFieldChanges: vi.fn(async () => {}),
}));
vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../ai/embeddings.js', () => ({ scheduleEmbedNode: vi.fn() }));
vi.mock('@mindblown/integrations', () => ({
  updateGitHubIssue: vi.fn(),
  getGitHubIssue: vi.fn(),
}));
vi.mock('../integrations.js', () => ({
  getGitHubContextForMap: vi.fn(async () => null),
}));

import { nodeRoutes } from '../nodes.js';

// ── Test harness ──────────────────────────────────────────────────

const MAP_ID = 'mmmm-mmmm-mmmm-mmmm';
const NODE_ID = 'nnnn-nnnn-nnnn-nnnn';

const ANLEITUNG = '1. Als Treuhänder einloggen\n2. Mandat öffnen\n\n**Erwartet:** Badge sichtbar';
const PRUEF_URL = 'https://staging.example.com/mandates/42';
const VIDEO_URL = 'https://videos.example.com/abnahme/man-14.mp4';

/** Minimal CoreNode-shaped stub the routes can broadcast/sync safely. */
function stubNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: NODE_ID,
    mapId: MAP_ID,
    parentId: 'pppp-pppp',
    childrenIds: [],
    text: 'stub node',
    externalLinks: [],
    verificationText: null,
    verificationUrl: null,
    verificationVideoUrl: null,
    ...overrides,
  };
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (req) => {
    req.userId = 'uuuu-uuuu-uuuu-uuuu';
  });
  await app.register(nodeRoutes);
  return app;
}

beforeEach(() => {
  createNodeMock.mockReset();
  updateNodeMock.mockReset();
  getNodeMock.mockReset();
  getNodeMock.mockResolvedValue(null as never);
});

// ── Cases ─────────────────────────────────────────────────────────

describe('PUT /api/maps/:id/nodes/:nodeId — verification fields round-trip', () => {
  it('forwards all three verification fields and returns them on the node', async () => {
    updateNodeMock.mockResolvedValueOnce(
      stubNode({
        verificationText: ANLEITUNG,
        verificationUrl: PRUEF_URL,
        verificationVideoUrl: VIDEO_URL,
      }),
    );
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: `/api/maps/${MAP_ID}/nodes/${NODE_ID}`,
      payload: {
        verificationText: ANLEITUNG,
        verificationUrl: PRUEF_URL,
        verificationVideoUrl: VIDEO_URL,
      },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(updateNodeMock).toHaveBeenCalledOnce();
    expect(updateNodeMock.mock.calls[0][0]).toBe(NODE_ID);
    expect(updateNodeMock.mock.calls[0][1]).toEqual({
      verificationText: ANLEITUNG,
      verificationUrl: PRUEF_URL,
      verificationVideoUrl: VIDEO_URL,
    });
    expect(res.json().verificationVideoUrl).toBe(VIDEO_URL);
    expect(res.json().verificationUrl).toBe(PRUEF_URL);
    expect(res.json().verificationText).toBe(ANLEITUNG);
  });

  it('forwards verificationVideoUrl on its own — no sibling field required', async () => {
    updateNodeMock.mockResolvedValueOnce(stubNode({ verificationVideoUrl: VIDEO_URL }));
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: `/api/maps/${MAP_ID}/nodes/${NODE_ID}`,
      payload: { verificationVideoUrl: VIDEO_URL },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(updateNodeMock.mock.calls[0][1]).toEqual({ verificationVideoUrl: VIDEO_URL });
    expect(res.json().verificationVideoUrl).toBe(VIDEO_URL);
  });

  it('forwards verificationVideoUrl: null (clear) — null survives as a value, not an omission', async () => {
    updateNodeMock.mockResolvedValueOnce(stubNode({ verificationVideoUrl: null }));
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: `/api/maps/${MAP_ID}/nodes/${NODE_ID}`,
      payload: { verificationVideoUrl: null },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(updateNodeMock.mock.calls[0][1]).toEqual({ verificationVideoUrl: null });
    expect(res.json().verificationVideoUrl).toBeNull();
  });

  it('leaves verificationVideoUrl untouched when the update is about something else', async () => {
    updateNodeMock.mockResolvedValueOnce(stubNode({ text: 'renamed' }));
    const app = await buildApp();
    await app.inject({
      method: 'PUT',
      url: `/api/maps/${MAP_ID}/nodes/${NODE_ID}`,
      payload: { text: 'renamed' },
    });
    await app.close();

    expect('verificationVideoUrl' in (updateNodeMock.mock.calls[0][1] as object)).toBe(false);
  });
});

describe('POST /api/maps/:id/nodes — verification fields on create', () => {
  it('forwards all three verification fields to createNode', async () => {
    createNodeMock.mockResolvedValueOnce(
      stubNode({
        text: 'Neue Anforderung',
        verificationText: ANLEITUNG,
        verificationUrl: PRUEF_URL,
        verificationVideoUrl: VIDEO_URL,
      }),
    );
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/maps/${MAP_ID}/nodes`,
      payload: {
        parentId: 'pppp-pppp',
        text: 'Neue Anforderung',
        verificationText: ANLEITUNG,
        verificationUrl: PRUEF_URL,
        verificationVideoUrl: VIDEO_URL,
      },
    });
    await app.close();

    expect(res.statusCode).toBe(201);
    expect(createNodeMock).toHaveBeenCalledOnce();
    expect(createNodeMock.mock.calls[0][0]).toMatchObject({
      mapId: MAP_ID,
      parentId: 'pppp-pppp',
      text: 'Neue Anforderung',
      verificationText: ANLEITUNG,
      verificationUrl: PRUEF_URL,
      verificationVideoUrl: VIDEO_URL,
    });
    expect(res.json().verificationVideoUrl).toBe(VIDEO_URL);
  });
});
