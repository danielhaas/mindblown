/**
 * Tool-kit schema/handler regression tests for the Phase 3 (#96) triage
 * MCP tools.
 *
 * Coverage per tool:
 *   - Happy path: tool calls backend with the expected arguments,
 *     returns a human-readable message.
 *   - Error path: backend throws → handler propagates (the MCP wrapper
 *     in `packages/mcp` is responsible for catching, not the spec layer).
 *   - Auth pass-through: the tool layer doesn't authenticate — the
 *     server route does — so we assert the tool DOESN'T strip or
 *     mutate arguments before they reach the backend.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  listTriageDecisionsTool,
  overrideTriageTool,
  reclassifyTriageTool,
  confirmTriageTool,
} from '../triage.js';
import type {
  ToolBackend,
  TriageActionResult,
  TriageDecisionRow,
  TriageListResult,
} from '../../backend.js';

// ── Recording backend ────────────────────────────────────────────

interface Recorder {
  backend: ToolBackend;
  lastList: { mapId: string; filters: Record<string, unknown> } | null;
  lastOverride: {
    mapId: string;
    decisionId: string;
    body: Record<string, unknown>;
  } | null;
  lastReclassify: { mapId: string; decisionId: string } | null;
  lastConfirm: { mapId: string; decisionId: string } | null;
  listResult: TriageListResult;
  overrideResult: TriageActionResult;
  reclassifyResult: TriageActionResult;
  confirmResult: TriageActionResult;
  throwOn: Partial<Record<'list' | 'override' | 'reclassify' | 'confirm', Error>>;
}

function makeRecorder(): Recorder {
  const state: Recorder = {
    lastList: null,
    lastOverride: null,
    lastReclassify: null,
    lastConfirm: null,
    listResult: { mapId: 'm1', total: 0, decisions: [] },
    overrideResult: { decisionId: 'd1', status: 'placed', nodeId: 'n1' },
    reclassifyResult: {
      decisionId: 'd1',
      status: 'reclassified',
      decision: 'place',
      confidence: 88,
      reason: 'matches Frontend',
    },
    confirmResult: { decisionId: 'd1', status: 'confirmed', nodeId: 'n1' },
    throwOn: {},
    backend: {} as ToolBackend,
  };
  state.backend = {
    listMaps: async () => { throw new Error('not used'); },
    getMap: async () => { throw new Error('not used'); },
    createMap: async () => { throw new Error('not used'); },
    updateMap: async () => { throw new Error('not used'); },
    deleteMap: async () => { throw new Error('not used'); },
    createNode: async () => { throw new Error('not used'); },
    updateNode: async () => { throw new Error('not used'); },
    deleteNode: async () => { throw new Error('not used'); },
    moveNode: async () => { throw new Error('not used'); },
    listTriageDecisions: async (mapId, filters) => {
      if (state.throwOn.list) throw state.throwOn.list;
      state.lastList = { mapId, filters: filters as Record<string, unknown> };
      return state.listResult;
    },
    overrideTriage: async (mapId, decisionId, body) => {
      if (state.throwOn.override) throw state.throwOn.override;
      state.lastOverride = {
        mapId,
        decisionId,
        body: body as Record<string, unknown>,
      };
      return state.overrideResult;
    },
    reclassifyTriage: async (mapId, decisionId) => {
      if (state.throwOn.reclassify) throw state.throwOn.reclassify;
      state.lastReclassify = { mapId, decisionId };
      return state.reclassifyResult;
    },
    confirmTriage: async (mapId, decisionId) => {
      if (state.throwOn.confirm) throw state.throwOn.confirm;
      state.lastConfirm = { mapId, decisionId };
      return state.confirmResult;
    },
  };
  return state;
}

function fakeDecision(overrides: Partial<TriageDecisionRow> = {}): TriageDecisionRow {
  return {
    id: 'd1',
    mapId: 'm1',
    externalId: 'o/r#42',
    issueTitle: 'My issue',
    issueState: 'open',
    decision: 'uncertain',
    reason: 'unsure',
    confidence: 40,
    placedNodeId: null,
    decidedAt: new Date().toISOString(),
    decidedBy: 'auto',
    reviewed: false,
    reviewedAt: null,
    reviewedBy: null,
    ...overrides,
  };
}

// ── list_triage_decisions ────────────────────────────────────────

describe('list_triage_decisions tool', () => {
  it('accepts the full Phase 2 filter set in the schema', () => {
    const schema = z.object(listTriageDecisionsTool.schema);
    const parsed = schema.parse({
      mapId: 'm1',
      reviewed: false,
      decision: 'place',
      minConfidence: 70,
      maxConfidence: 100,
      issueState: 'open',
      since: '2026-01-01T00:00:00Z',
      limit: 50,
    });
    expect(parsed.reviewed).toBe(false);
    expect(parsed.decision).toBe('place');
    expect(parsed.minConfidence).toBe(70);
    expect(parsed.maxConfidence).toBe(100);
    expect(parsed.issueState).toBe('open');
    expect(parsed.limit).toBe(50);
  });

  it('rejects out-of-range confidence', () => {
    const schema = z.object(listTriageDecisionsTool.schema);
    expect(() =>
      schema.parse({ mapId: 'm1', minConfidence: -5 }),
    ).toThrow();
    expect(() =>
      schema.parse({ mapId: 'm1', maxConfidence: 200 }),
    ).toThrow();
  });

  it('rejects an out-of-range limit', () => {
    const schema = z.object(listTriageDecisionsTool.schema);
    expect(() => schema.parse({ mapId: 'm1', limit: 0 })).toThrow();
    expect(() => schema.parse({ mapId: 'm1', limit: 250 })).toThrow();
  });

  it('happy path: forwards filters to the backend and renders the result', async () => {
    const rec = makeRecorder();
    rec.listResult = {
      mapId: 'm1',
      total: 2,
      decisions: [
        fakeDecision({ id: 't1', decision: 'place', confidence: 92, reviewed: false }),
        fakeDecision({ id: 't2', decision: 'skip', confidence: 70, reviewed: true, decidedBy: 'operator' }),
      ],
    };
    const out = await listTriageDecisionsTool.handler(rec.backend, {
      mapId: 'm1',
      reviewed: false,
      minConfidence: 70,
    } as never);
    expect(rec.lastList).toEqual({
      mapId: 'm1',
      filters: {
        reviewed: false,
        decision: undefined,
        minConfidence: 70,
        maxConfidence: undefined,
        issueState: undefined,
        since: undefined,
        limit: undefined,
      },
    });
    expect(out).toContain('Found 2 triage decision(s) in map m1');
    expect(out).toContain('t1');
    expect(out).toContain('t2');
  });

  it('reports zero results in a human-readable way (no thrown error)', async () => {
    const rec = makeRecorder();
    const out = await listTriageDecisionsTool.handler(rec.backend, {
      mapId: 'empty-map',
    } as never);
    expect(out).toContain('No triage decisions found in map empty-map');
  });

  it('error path: backend throw propagates (MCP wrapper catches)', async () => {
    const rec = makeRecorder();
    rec.throwOn.list = new Error('API Error (403): forbidden');
    await expect(
      listTriageDecisionsTool.handler(rec.backend, { mapId: 'm1' } as never),
    ).rejects.toThrow('API Error (403)');
  });
});

// ── override_triage ──────────────────────────────────────────────

describe('override_triage tool', () => {
  it('accepts decision=place with parentNodeId in the schema', () => {
    const schema = z.object(overrideTriageTool.schema);
    const parsed = schema.parse({
      mapId: 'm1',
      decisionId: 'd1',
      decision: 'place',
      parentNodeId: 'epic-1',
      reason: 'I know better',
    });
    expect(parsed.decision).toBe('place');
    expect(parsed.parentNodeId).toBe('epic-1');
  });

  it('rejects unknown decision values', () => {
    const schema = z.object(overrideTriageTool.schema);
    expect(() =>
      schema.parse({ mapId: 'm1', decisionId: 'd1', decision: 'maybe' }),
    ).toThrow();
  });

  it('happy path: forwards decision/parent/reason to the backend', async () => {
    const rec = makeRecorder();
    const out = await overrideTriageTool.handler(rec.backend, {
      mapId: 'm1',
      decisionId: 'd1',
      decision: 'place',
      parentNodeId: 'epic-1',
      reason: 'I know better',
    } as never);
    expect(rec.lastOverride).toEqual({
      mapId: 'm1',
      decisionId: 'd1',
      body: { decision: 'place', parentNodeId: 'epic-1', reason: 'I know better' },
    });
    expect(out).toContain('Override applied on decision d1');
    expect(out).toContain('nodeId=n1');
  });

  it('auth pass-through: schema doesn\'t strip parentNodeId on a place decision', () => {
    // Defense: a future cleanup that drops "optional" fields client-side
    // would silently break the server's place-requires-parent gate. Pin
    // that parentNodeId rides through the parsed schema verbatim.
    const schema = z.object(overrideTriageTool.schema);
    const parsed = schema.parse({
      mapId: 'm1',
      decisionId: 'd1',
      decision: 'place',
      parentNodeId: 'epic-1',
    });
    expect(Object.keys(parsed)).toContain('parentNodeId');
    expect(parsed.parentNodeId).toBe('epic-1');
  });

  it('error path: backend SELF_LOOP_BLOCKED throw surfaces verbatim', async () => {
    const rec = makeRecorder();
    rec.throwOn.override = new Error(
      'API Error (400): parentNodeId must differ from the placed node',
    );
    await expect(
      overrideTriageTool.handler(rec.backend, {
        mapId: 'm1',
        decisionId: 'd1',
        decision: 'place',
        parentNodeId: 'self',
      } as never),
    ).rejects.toThrow(/parentNodeId must differ/);
  });
});

// ── reclassify_triage ────────────────────────────────────────────

describe('reclassify_triage tool', () => {
  it('schema requires mapId + decisionId, nothing else', () => {
    const schema = z.object(reclassifyTriageTool.schema);
    expect(() => schema.parse({})).toThrow();
    expect(() => schema.parse({ mapId: 'm1' })).toThrow();
    const parsed = schema.parse({ mapId: 'm1', decisionId: 'd1' });
    expect(parsed.mapId).toBe('m1');
    expect(parsed.decisionId).toBe('d1');
  });

  it('happy path: forwards to backend, renders the new decision + confidence', async () => {
    const rec = makeRecorder();
    const out = await reclassifyTriageTool.handler(rec.backend, {
      mapId: 'm1',
      decisionId: 'd1',
    } as never);
    expect(rec.lastReclassify).toEqual({ mapId: 'm1', decisionId: 'd1' });
    expect(out).toContain('Reclassified d1');
    expect(out).toContain('decision=place');
    expect(out).toContain('88%');
  });

  it('error path: backend 404 propagates', async () => {
    const rec = makeRecorder();
    rec.throwOn.reclassify = new Error('API Error (404): not found');
    await expect(
      reclassifyTriageTool.handler(rec.backend, {
        mapId: 'm1',
        decisionId: 'missing',
      } as never),
    ).rejects.toThrow('404');
  });
});

// ── confirm_triage ───────────────────────────────────────────────

describe('confirm_triage tool', () => {
  it('schema rejects parentNodeId (the #100 Round 2 fix — confirm has no parent input)', () => {
    const schema = z.object(confirmTriageTool.schema);
    // We don't enforce strictness on extra fields, but the schema
    // intentionally has no parentNodeId field so it can't be parsed
    // into the args object. Test: the parsed object never contains
    // parentNodeId even if supplied.
    const parsed = schema.parse({ mapId: 'm1', decisionId: 'd1' });
    expect('parentNodeId' in parsed).toBe(false);
  });

  it('happy path: forwards to backend, returns a confirmation message', async () => {
    const rec = makeRecorder();
    const out = await confirmTriageTool.handler(rec.backend, {
      mapId: 'm1',
      decisionId: 'd1',
    } as never);
    expect(rec.lastConfirm).toEqual({ mapId: 'm1', decisionId: 'd1' });
    expect(out).toContain('Confirmed d1');
    expect(out).toContain('confirmed');
  });

  it('renders nodeId when present, omits when null (skip rows)', async () => {
    const rec = makeRecorder();
    rec.confirmResult = { decisionId: 'd1', status: 'confirmed', nodeId: null };
    const out = await confirmTriageTool.handler(rec.backend, {
      mapId: 'm1',
      decisionId: 'd1',
    } as never);
    expect(out).not.toContain('nodeId=');
  });

  it('error path: backend 403 propagates (auth fail at the route layer)', async () => {
    const rec = makeRecorder();
    rec.throwOn.confirm = new Error(
      'API Error (403): API-key auth cannot access triage endpoints',
    );
    await expect(
      confirmTriageTool.handler(rec.backend, {
        mapId: 'm1',
        decisionId: 'd1',
      } as never),
    ).rejects.toThrow('API-key auth cannot access');
  });
});
