/**
 * ForgeClient contract — the behaviour every forge implementation must
 * share, expressed against a recording fake transport.
 *
 * A forge test calls `describeForgeContract({...})` with:
 *   - `create(fetchImpl)` → a client wired to the fake transport;
 *   - `wire` → raw JSON bodies *as that forge returns them* for one issue,
 *     one PR and one PR-files listing. The contract asserts that the client
 *     normalises them to the shared `ForgeIssue` / `ForgePullRequest` shape
 *     below, so downstream sync code can stay forge-blind.
 *
 * Per-forge wire details (exact paths, auth header format, label payload)
 * are NOT part of the contract — each forge's own test pins them.
 */

import { describe, expect, it } from 'vitest';
import {
  ForgeApiError,
  type ForgeClient,
  type ForgeFetch,
  type ForgeIssue,
  type ForgePullRequest,
  type ForgeResponse,
} from '../types.js';

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  signal: AbortSignal | undefined;
}

export interface QueuedResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface FakeTransport {
  fetchImpl: ForgeFetch;
  calls: RecordedRequest[];
  /** Queue the next response(s); each request consumes one. */
  respond: (...responses: QueuedResponse[]) => void;
}

/** A fetch-shaped double: `ok`, `status`, `headers`, `json()`, `text()`. */
export function fakeTransport(): FakeTransport {
  const calls: RecordedRequest[] = [];
  const queue: QueuedResponse[] = [];
  const fetchImpl: ForgeFetch = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: init.signal,
    });
    const next = queue.shift() ?? { status: 200, body: {} };
    const text =
      next.body === undefined ? '' : typeof next.body === 'string' ? next.body : JSON.stringify(next.body);
    const res: ForgeResponse = {
      status: next.status,
      ok: next.status >= 200 && next.status < 300,
      headers: new Headers(next.headers ?? {}),
      json: async () => (typeof next.body === 'string' ? JSON.parse(next.body) : next.body),
      text: async () => text,
    };
    return res;
  };
  return { fetchImpl, calls, respond: (...r) => queue.push(...r) };
}

/** The normalised shapes every forge must produce from its own wire format. */
export const EXPECTED_ISSUE: ForgeIssue = {
  id: 1001,
  number: 42,
  title: 'Contract issue',
  body: 'Body text',
  state: 'open',
  labels: [{ name: 'bug' }, { name: 'priority:P1' }],
  assignees: [{ login: 'octocat', id: 7 }],
  milestone: {
    id: 55,
    number: 3,
    title: 'V1: 2. Sync',
    description: null,
    state: 'open',
    due_on: '2026-10-01T00:00:00Z',
    created_at: '2026-09-01T00:00:00Z',
  },
  html_url: 'https://forge.example/o/r/issues/42',
  created_at: '2026-09-02T10:00:00Z',
  updated_at: '2026-09-03T10:00:00Z',
  closed_at: null,
};

export const EXPECTED_PR: ForgePullRequest = {
  number: 77,
  title: 'Fix the thing',
  body: 'Closes #42',
  state: 'closed',
  html_url: 'https://forge.example/o/r/pull/77',
  merged: true,
  merged_at: '2026-09-04T12:00:00Z',
  created_at: '2026-09-04T09:00:00Z',
  updated_at: '2026-09-04T12:00:00Z',
  base: { ref: 'master' },
};

export interface ForgeContractSpec {
  name: string;
  create: (fetchImpl: ForgeFetch) => ForgeClient;
  /** Raw wire bodies, in the forge's own format. */
  wire: {
    issue: unknown;
    pullRequest: unknown;
    pullRequestFiles: unknown;
  };
  /** What `issueWebUrl('o', 'r', 42)` must return for this client. */
  expectedIssueWebUrl: string;
}

function pathOf(url: string): string {
  const u = new URL(url);
  return u.pathname + u.search;
}

export function describeForgeContract(spec: ForgeContractSpec): void {
  describe(`ForgeClient contract: ${spec.name}`, () => {
    it('request(): resolves a relative path against apiBaseUrl and authenticates it', async () => {
      const t = fakeTransport();
      const forge = spec.create(t.fetchImpl);
      t.respond({ status: 200, body: spec.wire.issue });
      const res = await forge.request('/repos/o/r/issues/42');
      expect(res.status).toBe(200);
      expect(t.calls).toHaveLength(1);
      expect(t.calls[0].method).toBe('GET');
      expect(t.calls[0].url).toBe(`${forge.endpoint.apiBaseUrl}/repos/o/r/issues/42`);
      expect(t.calls[0].headers.Authorization).toBeTruthy();
    });

    it('request(): passes an absolute URL through untouched (Link-header pagination)', async () => {
      const t = fakeTransport();
      const forge = spec.create(t.fetchImpl);
      const absolute = `${forge.endpoint.apiBaseUrl}/repos/o/r/issues?after=abc`;
      t.respond({ status: 200, body: [] });
      await forge.request(absolute);
      expect(t.calls[0].url).toBe(absolute);
    });

    it('request(): never throws on a non-2xx status', async () => {
      const t = fakeTransport();
      const forge = spec.create(t.fetchImpl);
      t.respond({ status: 404, body: { message: 'Not Found' } });
      const res = await forge.request('/repos/o/r/issues/1');
      expect(res.status).toBe(404);
      expect(res.ok).toBe(false);
    });

    it('request(): merges caller headers over the defaults and forwards method/body/signal', async () => {
      const t = fakeTransport();
      const forge = spec.create(t.fetchImpl);
      const controller = new AbortController();
      t.respond({ status: 200, body: {} });
      await forge.request('/repos/o/r/issues', {
        method: 'POST',
        body: '{"title":"x"}',
        headers: { Accept: 'application/custom+json' },
        signal: controller.signal,
      });
      expect(t.calls[0]).toMatchObject({
        method: 'POST',
        body: '{"title":"x"}',
        signal: controller.signal,
      });
      expect(t.calls[0].headers.Accept).toBe('application/custom+json');
      expect(t.calls[0].headers.Authorization).toBeTruthy();
    });

    it('requestJson(): parses 2xx, resolves undefined on 204, throws ForgeApiError otherwise', async () => {
      const t = fakeTransport();
      const forge = spec.create(t.fetchImpl);
      t.respond(
        { status: 200, body: spec.wire.issue },
        { status: 204 },
        { status: 401, body: { message: 'Bad credentials' } },
      );
      const issue = await forge.requestJson<ForgeIssue>('/repos/o/r/issues/42');
      expect(issue).toMatchObject({ number: 42 });
      await expect(forge.requestJson('/repos/o/r/x', { method: 'DELETE' })).resolves.toBeUndefined();
      const err = await forge.requestJson('/repos/o/r/issues/42').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForgeApiError);
      expect((err as ForgeApiError).status).toBe(401);
      expect((err as ForgeApiError).body).toContain('Bad credentials');
      expect((err as ForgeApiError).kind).toBe(forge.endpoint.kind);
    });

    it('requestJson(): serialises an object body', async () => {
      const t = fakeTransport();
      const forge = spec.create(t.fetchImpl);
      t.respond({ status: 200, body: {} });
      await forge.requestJson('/repos/o/r/issues', { method: 'POST', body: { title: 'x' } });
      expect(JSON.parse(t.calls[0].body ?? '{}')).toEqual({ title: 'x' });
    });

    it('createIssue(): sends title, body and labels and returns the normalised issue', async () => {
      const t = fakeTransport();
      const forge = spec.create(t.fetchImpl);
      t.respond({ status: 201, body: spec.wire.issue });
      const issue = await forge.createIssue('o', 'r', { title: 'Contract issue', body: 'Body text', labels: ['bug'] });
      expect(t.calls[0].method).toBe('POST');
      expect(pathOf(t.calls[0].url)).toMatch(/^\/repos\/o\/r\//);
      const sent = JSON.parse(t.calls[0].body ?? '{}');
      expect(sent.title).toBe('Contract issue');
      expect(sent.body).toBe('Body text');
      expect(issue).toMatchObject(EXPECTED_ISSUE);
    });

    it('label add/remove return the raw status instead of throwing on 404/422', async () => {
      const t = fakeTransport();
      const forge = spec.create(t.fetchImpl);
      t.respond({ status: 422, body: { message: 'Validation Failed' } }, { status: 404, body: {} });
      const added = await forge.addIssueLabels('o', 'r', 42, ['triage:placed']);
      const removed = await forge.removeIssueLabel('o', 'r', 42, 'triage:skipped');
      expect(added.status).toBe(422);
      expect(added.bodyText).toContain('Validation Failed');
      expect(removed.status).toBe(404);
      expect(t.calls[1].method).toBe('DELETE');
    });

    it('label calls pass an AbortSignal through to the transport', async () => {
      const t = fakeTransport();
      const forge = spec.create(t.fetchImpl);
      const controller = new AbortController();
      t.respond({ status: 200, body: [] });
      await forge.addIssueLabels('o', 'r', 42, ['x'], { signal: controller.signal });
      expect(t.calls[0].signal).toBe(controller.signal);
    });

    it('getPullRequest(): normalises to ForgePullRequest', async () => {
      const t = fakeTransport();
      const forge = spec.create(t.fetchImpl);
      t.respond({ status: 200, body: spec.wire.pullRequest });
      const pr = await forge.getPullRequest('o', 'r', 77);
      expect(pr).toMatchObject(EXPECTED_PR);
    });

    it('pullRequestsListPath(): a relative first page carrying state/sort/direction/per_page', () => {
      const t = fakeTransport();
      const forge = spec.create(t.fetchImpl);
      const path = forge.pullRequestsListPath('o', 'r', { state: 'closed', sort: 'updated', direction: 'desc', perPage: 100 });
      expect(path.startsWith('/repos/o/r/')).toBe(true);
      const q = new URL(`${forge.endpoint.apiBaseUrl}${path}`).searchParams;
      expect(q.get('state')).toBe('closed');
      expect(q.get('per_page')).toBe('100');
      // Never a `page` parameter: the walk follows the Link header.
      expect(q.get('page')).toBeNull();
    });

    it('listPullRequestFiles(): the file paths a PR touches', async () => {
      const t = fakeTransport();
      const forge = spec.create(t.fetchImpl);
      t.respond({ status: 200, body: spec.wire.pullRequestFiles });
      const files = await forge.listPullRequestFiles('o', 'r', 77);
      expect(files).toEqual(['packages/a.ts', 'packages/b.ts']);
    });

    it('issueWebUrl(): built from the endpoint', () => {
      const t = fakeTransport();
      const forge = spec.create(t.fetchImpl);
      expect(forge.issueWebUrl('o', 'r', 42)).toBe(spec.expectedIssueWebUrl);
    });
  });
}
