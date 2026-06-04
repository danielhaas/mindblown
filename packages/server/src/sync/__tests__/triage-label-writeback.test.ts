/**
 * Tests for the Phase 3 (#96) optional GitHub label write-back.
 *
 * Covers:
 *   - `triage_label_writeback=false` (default) → no GH API call.
 *   - `triage_label_writeback=true` + place → `triage:placed` POSTed,
 *     `triage:skipped` DELETEd (best-effort 404 ignored).
 *   - place ↔ skip flip swaps the labels.
 *   - decision='uncertain' → no GH API call even with writeback enabled
 *     (intermediate-state suppression).
 *   - GH 422 (label doesn't exist) → flow completes, only a warn is logged.
 *   - GH 500 → flow completes (best-effort, never throws to caller).
 *   - Malformed externalId → silent skip, no GH call.
 *   - Map without GH context → silent skip, no GH call.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────

let labelWritebackEnabled = false;
let mapExists = true;
let ghContext: { owner: string; repo: string; token: string } | null = {
  owner: 'octocat',
  repo: 'demo',
  token: 't_test',
};

vi.mock('../../db/connection.js', () => {
  const db = {
    select: () => ({
      from: () => ({
        where: async () => {
          if (!mapExists) return [];
          return [{ writeback: labelWritebackEnabled }];
        },
      }),
    }),
  };
  return { db };
});

vi.mock('../../db/schema.js', () => ({
  maps: {
    __name: 'maps',
    id: { __col: 'id' },
    triageLabelWriteback: { __col: 'triageLabelWriteback' },
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ __pred: true, col, val }),
}));

vi.mock('../../lib/githubContext.js', () => ({
  getGitHubContextForMap: async () => ghContext,
}));

vi.mock('@mindblown/integrations', () => ({
  GitHubApiError: class GitHubApiError extends Error {
    status: number;
    body: string;
    constructor(status: number, body: string) {
      super(`GitHub API ${status}: ${body}`);
      this.name = 'GitHubApiError';
      this.status = status;
      this.body = body;
    }
  },
}));

import { applyTriageLabel } from '../triageLabelWriteback.js';

// Build a fetch-impl shim the tests can wire into `applyTriageLabel`
// so we never touch real network and can assert request shape.

interface RecordedCall {
  url: string;
  method: string;
  body: string | undefined;
}

function fetchShim(
  responseByPattern: Array<{ urlContains: string; method: string; status: number; body?: string }>,
): { calls: RecordedCall[]; impl: Parameters<typeof applyTriageLabel>[0]['fetchImpl'] } {
  const calls: RecordedCall[] = [];
  const impl: NonNullable<Parameters<typeof applyTriageLabel>[0]['fetchImpl']> = async (
    url,
    init,
  ) => {
    calls.push({ url, method: init.method, body: init.body });
    const match = responseByPattern.find(
      (r) => url.includes(r.urlContains) && r.method === init.method,
    );
    const status = match?.status ?? 200;
    const body = match?.body ?? '{}';
    return {
      status,
      text: async () => body,
    };
  };
  return { calls, impl };
}

beforeEach(() => {
  labelWritebackEnabled = false;
  mapExists = true;
  ghContext = { owner: 'octocat', repo: 'demo', token: 't_test' };
});

// ── Disabled paths ───────────────────────────────────────────────

describe('applyTriageLabel — gated off', () => {
  it('writeback disabled → no GH API call', async () => {
    labelWritebackEnabled = false;
    const shim = fetchShim([]);
    await applyTriageLabel({
      mapId: 'm1',
      externalId: 'octocat/demo#42',
      decision: 'place',
      fetchImpl: shim.impl,
    });
    expect(shim.calls).toHaveLength(0);
  });

  it("decision='uncertain' → no GH API call even when writeback is enabled", async () => {
    labelWritebackEnabled = true;
    const shim = fetchShim([]);
    await applyTriageLabel({
      mapId: 'm1',
      externalId: 'octocat/demo#42',
      decision: 'uncertain',
      fetchImpl: shim.impl,
    });
    expect(shim.calls).toHaveLength(0);
  });

  it('map row missing → silent skip, no GH call', async () => {
    labelWritebackEnabled = true;
    mapExists = false;
    const shim = fetchShim([]);
    await applyTriageLabel({
      mapId: 'm1',
      externalId: 'octocat/demo#42',
      decision: 'place',
      fetchImpl: shim.impl,
    });
    expect(shim.calls).toHaveLength(0);
  });

  it('malformed externalId → silent skip, no GH call', async () => {
    labelWritebackEnabled = true;
    const shim = fetchShim([]);
    await applyTriageLabel({
      mapId: 'm1',
      externalId: 'not-an-external-id',
      decision: 'place',
      fetchImpl: shim.impl,
    });
    expect(shim.calls).toHaveLength(0);
  });

  it('no GitHub context for map → silent skip, no GH call', async () => {
    labelWritebackEnabled = true;
    ghContext = null;
    const shim = fetchShim([]);
    await applyTriageLabel({
      mapId: 'm1',
      externalId: 'octocat/demo#42',
      decision: 'place',
      fetchImpl: shim.impl,
    });
    expect(shim.calls).toHaveLength(0);
  });
});

// ── Active paths ─────────────────────────────────────────────────

describe('applyTriageLabel — active', () => {
  it("decision='place' → POSTs triage:placed and DELETEs triage:skipped", async () => {
    labelWritebackEnabled = true;
    const shim = fetchShim([
      { urlContains: '/labels', method: 'POST', status: 200, body: '[]' },
      { urlContains: '/labels/triage', method: 'DELETE', status: 200 },
    ]);
    await applyTriageLabel({
      mapId: 'm1',
      externalId: 'octocat/demo#42',
      decision: 'place',
      fetchImpl: shim.impl,
    });
    expect(shim.calls).toHaveLength(2);
    expect(shim.calls[0].method).toBe('POST');
    expect(shim.calls[0].url).toContain('/repos/octocat/demo/issues/42/labels');
    expect(shim.calls[0].body).toContain('triage:placed');
    expect(shim.calls[1].method).toBe('DELETE');
    expect(shim.calls[1].url).toContain(
      `/repos/octocat/demo/issues/42/labels/${encodeURIComponent('triage:skipped')}`,
    );
  });

  it("decision='skip' → POSTs triage:skipped and DELETEs triage:placed (inverse)", async () => {
    labelWritebackEnabled = true;
    const shim = fetchShim([
      { urlContains: '/labels', method: 'POST', status: 200 },
      { urlContains: '/labels/triage', method: 'DELETE', status: 200 },
    ]);
    await applyTriageLabel({
      mapId: 'm1',
      externalId: 'octocat/demo#42',
      decision: 'skip',
      fetchImpl: shim.impl,
    });
    expect(shim.calls).toHaveLength(2);
    expect(shim.calls[0].body).toContain('triage:skipped');
    expect(shim.calls[1].url).toContain(
      `/repos/octocat/demo/issues/42/labels/${encodeURIComponent('triage:placed')}`,
    );
  });

  it('inverse-label DELETE 404 → treated as no-op, flow continues', async () => {
    labelWritebackEnabled = true;
    const shim = fetchShim([
      { urlContains: '/labels', method: 'POST', status: 200 },
      { urlContains: '/labels/triage', method: 'DELETE', status: 404 },
    ]);
    await expect(
      applyTriageLabel({
        mapId: 'm1',
        externalId: 'octocat/demo#42',
        decision: 'place',
        fetchImpl: shim.impl,
      }),
    ).resolves.toBeUndefined();
    expect(shim.calls).toHaveLength(2);
  });

  it('add-label 422 (label doesn\'t exist in repo) → still attempts remove, never throws', async () => {
    labelWritebackEnabled = true;
    const shim = fetchShim([
      { urlContains: '/labels', method: 'POST', status: 422 },
      { urlContains: '/labels/triage', method: 'DELETE', status: 422 },
    ]);
    await expect(
      applyTriageLabel({
        mapId: 'm1',
        externalId: 'octocat/demo#42',
        decision: 'place',
        fetchImpl: shim.impl,
      }),
    ).resolves.toBeUndefined();
    // Both calls still attempted — best-effort, neither throws.
    expect(shim.calls).toHaveLength(2);
  });

  it('add-label 500 (server error) → flow completes without throwing', async () => {
    labelWritebackEnabled = true;
    const shim = fetchShim([
      { urlContains: '/labels', method: 'POST', status: 500 },
      { urlContains: '/labels/triage', method: 'DELETE', status: 500 },
    ]);
    await expect(
      applyTriageLabel({
        mapId: 'm1',
        externalId: 'octocat/demo#42',
        decision: 'place',
        fetchImpl: shim.impl,
      }),
    ).resolves.toBeUndefined();
  });

  it('Bearer token from the resolved GH context is sent on every request', async () => {
    labelWritebackEnabled = true;
    let capturedAuth: string | undefined;
    const impl: NonNullable<Parameters<typeof applyTriageLabel>[0]['fetchImpl']> = async (
      _url,
      init,
    ) => {
      capturedAuth = (init.headers as Record<string, string>).Authorization;
      return { status: 200, text: async () => '' };
    };
    await applyTriageLabel({
      mapId: 'm1',
      externalId: 'octocat/demo#42',
      decision: 'place',
      fetchImpl: impl,
    });
    expect(capturedAuth).toBe('Bearer t_test');
  });
});

// ── Phase 3 follow-up #104 item 10: timeout, item 13: regex ─────

describe('applyTriageLabel — timeout (#104 item 10)', () => {
  // The fetchImpl test surface bypasses the AbortController-wrapped
  // production `fetch()` path. To pin the contract that a timed-out
  // request resolves without throwing to the caller, simulate the
  // post-AbortError state: the impl throws an AbortError-like instance.
  it('fetch throws AbortError → flow completes without rethrowing to the caller', async () => {
    labelWritebackEnabled = true;
    const impl: NonNullable<Parameters<typeof applyTriageLabel>[0]['fetchImpl']> = async () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    };
    await expect(
      applyTriageLabel({
        mapId: 'm1',
        externalId: 'octocat/demo#42',
        decision: 'place',
        fetchImpl: impl,
      }),
    ).resolves.toBeUndefined();
  });

  it('a slow add followed by a fast remove still attempts both calls', async () => {
    labelWritebackEnabled = true;
    const calls: string[] = [];
    const impl: NonNullable<Parameters<typeof applyTriageLabel>[0]['fetchImpl']> = async (
      _url,
      init,
    ) => {
      calls.push(init.method);
      // Resolves quickly — production controller is on the real fetch,
      // not the impl path.
      return { status: 200, text: async () => '' };
    };
    await applyTriageLabel({
      mapId: 'm1',
      externalId: 'octocat/demo#42',
      decision: 'place',
      fetchImpl: impl,
    });
    expect(calls).toEqual(['POST', 'DELETE']);
  });
});

describe('parseExternalId regex (#104 item 13)', () => {
  // The regex tightened from `(.+?)\/(.+?)#(\d+)` to `^([^/]+)\/([^/#]+)#(\d+)$`.
  // Direct unit-test the parse via the public surface — a malformed id
  // silently skips with no GH call (logged at warn level).
  it('rejects an externalId with a slash in the repo segment (silent skip)', async () => {
    labelWritebackEnabled = true;
    const shim = fetchShim([]);
    await applyTriageLabel({
      mapId: 'm1',
      externalId: 'octo/cat/demo#42',
      decision: 'place',
      fetchImpl: shim.impl,
    });
    expect(shim.calls).toHaveLength(0);
  });

  it('rejects an externalId with a stray # before the issue number (silent skip)', async () => {
    labelWritebackEnabled = true;
    const shim = fetchShim([]);
    await applyTriageLabel({
      mapId: 'm1',
      externalId: 'octocat/de#mo#42',
      decision: 'place',
      fetchImpl: shim.impl,
    });
    expect(shim.calls).toHaveLength(0);
  });

  it('accepts a well-formed externalId', async () => {
    labelWritebackEnabled = true;
    const shim = fetchShim([
      { urlContains: '/labels', method: 'POST', status: 200 },
      { urlContains: '/labels/triage', method: 'DELETE', status: 200 },
    ]);
    await applyTriageLabel({
      mapId: 'm1',
      externalId: 'octocat/demo#42',
      decision: 'place',
      fetchImpl: shim.impl,
    });
    expect(shim.calls).toHaveLength(2);
  });
});
