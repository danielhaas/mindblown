/**
 * Route wiring for ticket intake (#387): the accept step writes exactly
 * the reviewed draft (description, version, phase, tags, estimate,
 * finish-to-start dependencies), files the issue only when asked and
 * reports a missing forge instead of failing the node, and the turn
 * route refuses cleanly (validation, expired session, small model).
 *
 * Same mock pattern as phase-node-routes.test.ts: DB layer and side
 * effects stubbed, real Fastify, no Postgres and no LLM.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const createNodeMock = vi.fn();
const addDependencyMock = vi.fn();
const getNodeMock = vi.fn();
const getMapMock = vi.fn();
const createIssueMock = vi.fn();
const resolveProviderMock = vi.fn();

vi.mock('../../db/nodes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/nodes.js')>();
  return {
    ...actual,
    createNode: (...args: unknown[]) => createNodeMock(...args),
    addDependency: (...args: unknown[]) => addDependencyMock(...args),
    getNode: (...args: unknown[]) => getNodeMock(...args),
  };
});
vi.mock('../../db/maps.js', () => ({ getMap: (...args: unknown[]) => getMapMock(...args) }));
vi.mock('../../db/versions.js', () => ({ listVersions: vi.fn(async () => []) }));
vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../ai/embeddings.js', () => ({
  scheduleEmbedNode: vi.fn(),
  semanticSearch: vi.fn(async () => []),
  backfillMapEmbeddings: vi.fn(),
}));
vi.mock('../../ai/policy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ai/policy.js')>();
  return {
    ...actual,
    capabilitiesForMap: vi.fn(async () => ({
      enabled: true,
      chat: true,
      structured: true,
      embeddings: false,
      triage: false,
    })),
    getMapAiPolicy: vi.fn(async () => 'any'),
    resolveProviderForMap: (...args: unknown[]) => resolveProviderMock(...args),
  };
});
vi.mock('../../services/forgeIssue.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/forgeIssue.js')>();
  return {
    ...actual,
    createForgeIssueForNode: (...args: unknown[]) => createIssueMock(...args),
  };
});
vi.mock('../../lib/githubContext.js', () => ({
  getMapForgeKind: vi.fn(async () => 'github'),
}));
// The route file's catch-all answers AI_NOT_CONFIGURED whenever the server
// has no backend configured (true in the test env) — declare one.
vi.mock('../../ai/capabilities.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ai/capabilities.js')>();
  return {
    ...actual,
    aiCapabilities: () => ({ enabled: true, chat: true, structured: true, embeddings: false, triage: false }),
  };
});

import { aiRoutes } from '../ai.js';
import { NoForgeIntegrationError } from '../../services/forgeIssue.js';

const MAP_ID = 'map-1';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (req) => {
    (req as { userId?: string }).userId = 'user-1';
  });
  await app.register(aiRoutes);
  await app.ready();
  return app;
}

function stubNode(overrides: Record<string, unknown> = {}) {
  return {
    id: 'n-new',
    mapId: MAP_ID,
    parentId: 'p1',
    text: 'Created ticket',
    externalLinks: [],
    dependencies: [],
    ...overrides,
  };
}

beforeEach(() => {
  createNodeMock.mockReset();
  addDependencyMock.mockReset();
  getNodeMock.mockReset();
  getMapMock.mockReset();
  createIssueMock.mockReset();
  resolveProviderMock.mockReset();
  getNodeMock.mockResolvedValue({ id: 'p1', mapId: MAP_ID, text: 'Parent' });
  createNodeMock.mockImplementation(async (input: Record<string, unknown>) => stubNode({ text: input.text }));
  addDependencyMock.mockImplementation(async (nodeId: string, target: string) =>
    stubNode({ id: nodeId, dependencies: [{ targetNodeId: target, type: 'FS', lag: 0 }] }),
  );
});

describe('POST /api/ai/intake/accept', () => {
  it('writes the reviewed draft and its dependencies', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/intake/accept',
      payload: {
        mapId: MAP_ID,
        draft: {
          title: '  Close issue only when no PR is open ',
          description: '## Why\nbecause',
          parentId: 'p1',
          priority: 'P1',
          versionId: 'v1',
          phaseId: 'ph1',
          tags: ['sync', ' '],
          effortEstimate: 1.5,
          dependencies: [{ nodeId: 'dep-1' }],
        },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(createNodeMock).toHaveBeenCalledWith({
      mapId: MAP_ID,
      parentId: 'p1',
      text: 'Close issue only when no PR is open',
      createdBy: 'user-1',
      description: '## Why\nbecause',
      priority: 'P1',
      versionId: 'v1',
      phaseId: 'ph1',
      tags: ['sync'],
      effortEstimate: 1.5,
    });
    expect(addDependencyMock).toHaveBeenCalledWith('n-new', 'dep-1', 'FS', 0);
    const body = res.json();
    expect(body.issue).toBeNull();
    expect(body.node.dependencies).toEqual([{ targetNodeId: 'dep-1', type: 'FS', lag: 0 }]);
    expect(createIssueMock).not.toHaveBeenCalled();
  });

  it('leaves the estimate off when the client did not keep it', async () => {
    const app = await buildApp();
    await app.inject({
      method: 'POST',
      url: '/api/ai/intake/accept',
      payload: { mapId: MAP_ID, draft: { title: 't', description: 'd', parentId: 'p1' } },
    });
    const input = createNodeMock.mock.calls[0][0] as Record<string, unknown>;
    expect(input.effortEstimate).toBeUndefined();
    expect(input.versionId).toBeUndefined();
  });

  it('files the issue on request and reports a missing forge without losing the node', async () => {
    const app = await buildApp();
    createIssueMock.mockResolvedValueOnce({
      node: stubNode({ externalLinks: [{ provider: 'github' }] }),
      issue: { number: 42, html_url: 'https://x/42', title: 't' },
    });
    const ok = await app.inject({
      method: 'POST',
      url: '/api/ai/intake/accept',
      payload: { mapId: MAP_ID, createIssue: true, draft: { title: 't', description: 'd', parentId: 'p1' } },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().issue).toEqual({ number: 42, html_url: 'https://x/42' });

    createIssueMock.mockRejectedValueOnce(new NoForgeIntegrationError());
    const noForge = await app.inject({
      method: 'POST',
      url: '/api/ai/intake/accept',
      payload: { mapId: MAP_ID, createIssue: true, draft: { title: 't', description: 'd', parentId: 'p1' } },
    });
    expect(noForge.statusCode).toBe(201);
    expect(noForge.json().issue).toBeNull();
    expect(noForge.json().issueError).toContain('not configured');
  });

  it('rejects a parent from another map', async () => {
    const app = await buildApp();
    getNodeMock.mockResolvedValueOnce({ id: 'p1', mapId: 'other-map' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/intake/accept',
      payload: { mapId: MAP_ID, draft: { title: 't', description: 'd', parentId: 'p1' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('PARENT_NOT_FOUND');
    expect(createNodeMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/ai/intake', () => {
  it('validates the body', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/ai/intake', payload: { mapId: MAP_ID, message: ' ' } });
    expect(res.statusCode).toBe(400);
  });

  it('answers 410 for an unknown session so the client can restart', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/intake',
      payload: { mapId: MAP_ID, message: 'x', intakeId: 'gone' },
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().error.code).toBe('INTAKE_EXPIRED');
  });

  it('runs the JSON-mode path for a local model and reports the provider', async () => {
    const app = await buildApp();
    getMapMock.mockResolvedValueOnce({
      map: { id: MAP_ID, name: 'M', effortUnit: 'days', phases: [] },
      nodes: [{ id: 'r1', mapId: MAP_ID, parentId: null, childrenIds: [], text: 'Root' }],
    });
    const completions: string[] = [];
    resolveProviderMock.mockResolvedValueOnce({
      name: 'ollama',
      model: 'qwen2.5:14b',
      async *runTurn() {
        throw new Error('tool loop must not run for a local model');
      },
      async complete(o: { systemPrompt: string }) {
        completions.push(o.systemPrompt);
        // First call = the intake turn, second = the estimator.
        return completions.length === 1
          ? '```json\n{"text":"ok","draft":{"title":"T","description":"D","parentId":"r1","parentReason":"root"},"questions":[{"id":"q","question":"Q?"}]}\n```'
          : '{"estimate": 1, "confidence": "low"}';
      },
    });
    const res = await app.inject({ method: 'POST', url: '/api/ai/intake', payload: { mapId: MAP_ID, message: 'x' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.draft).toMatchObject({ title: 'T', parentText: 'Root', estimate: { estimate: 1 } });
    expect(body.questions).toEqual([{ id: 'q', question: 'Q?', options: [], why: null }]);
    expect(body.provider).toEqual({ name: 'ollama', model: 'qwen2.5:14b' });
    expect(completions[0]).toContain('Return ONLY one JSON object');
  });

  it('answers 502 AI_BAD_RESPONSE when the local model returns no JSON', async () => {
    const app = await buildApp();
    getMapMock.mockResolvedValueOnce({ map: { id: MAP_ID, name: 'M', phases: [] }, nodes: [] });
    resolveProviderMock.mockResolvedValueOnce({
      name: 'ollama',
      model: 'qwen2.5:14b',
      async *runTurn() {},
      async complete() {
        return 'Sure! Here is your ticket: ...';
      },
    });
    const res = await app.inject({ method: 'POST', url: '/api/ai/intake', payload: { mapId: MAP_ID, message: 'x' } });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('AI_BAD_RESPONSE');
  });

  it('runs a turn and returns the draft with the session id', async () => {
    const app = await buildApp();
    getMapMock.mockResolvedValueOnce({
      map: { id: MAP_ID, name: 'M', effortUnit: 'days', phases: [] },
      nodes: [{ id: 'r1', mapId: MAP_ID, parentId: null, childrenIds: [], text: 'Root' }],
    });
    resolveProviderMock.mockResolvedValueOnce({
      name: 'anthropic',
      model: 'claude-test',
      async *runTurn() {
        yield {
          type: 'tool_call',
          toolCall: {
            id: 'c1',
            name: 'propose_ticket',
            args: { title: 'T', description: 'D', parentId: 'r1', parentReason: 'root' },
          },
        };
        yield { type: 'turn_end', reason: 'stop' };
      },
      async complete() {
        return '{"estimate": 3, "confidence": "high", "notes": "n"}';
      },
    });
    const res = await app.inject({ method: 'POST', url: '/api/ai/intake', payload: { mapId: MAP_ID, message: 'x' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.intakeId).toBe('string');
    expect(body.draft).toMatchObject({ title: 'T', parentText: 'Root', estimate: { estimate: 3, confidence: 'high' } });
    expect(body.repoConnected).toBe(true);
  });
});
