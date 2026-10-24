/**
 * `listInstallationRepositories` — pagination guards.
 *
 * This file exists because `github-app.ts` had no tests at all, and the
 * Link-header conversion quietly cost this loop its second stop
 * condition. The old code stopped on `repos.length >= total_count` OR on
 * a short page; the conversion kept only the first. With `total_count`
 * missing or wrong, the only remaining brake was the server eventually
 * not sending a `Link` — which a self-referential header never does.
 *
 * It is also the one of the five converted walks that cannot use
 * `paginateGitHub` (the endpoint returns an envelope, not a bare array),
 * so it does not inherit that function's ceiling or its origin guard.
 * Both have to be stated here, and therefore tested here.
 *
 * The App config is real rather than mocked: a throwaway RSA key lets
 * `mintAppJwt` sign for real, so these tests drive the production path
 * end to end instead of a stubbed shell of it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { listInstallationRepositories, mintScopedRepoToken, mintInstallationToken, createGitHubRepository, listUserInstallations } from './github-app.js';
import { GitHubCrossOriginPaginationError } from './github.js';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const REPOS_URL = 'https://api.github.com/installation/repositories';

function repo(id: number) {
  return { id, name: `repo-${id}`, full_name: `acme/repo-${id}` };
}

/**
 * Stubs the installation-token endpoint plus the repository listing.
 * `pageFor(index)` returns the envelope AND the `Link` header to send
 * with it, so a test can hand back a header that never terminates.
 */
function stubGitHub(
  pageFor: (index: number) => { body: unknown; link?: string },
) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (rawUrl: string) => {
      const url = String(rawUrl);
      calls.push(url);

      if (url.includes('/access_tokens')) {
        return {
          ok: true,
          status: 201,
          headers: new Headers(),
          json: async () => ({
            token: 'ghs_installation',
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
          }),
        };
      }

      const index = Number(new URL(url).searchParams.get('after') ?? '0');
      const { body, link } = pageFor(index);
      return {
        ok: true,
        status: 200,
        headers: new Headers(link ? { link } : {}),
        json: async () => body,
      };
    }),
  );
  return calls;
}

/** Requests to the listing endpoint only (the token call is not one). */
function listingCalls(calls: string[]): string[] {
  return calls.filter((c) => c.includes('/installation/repositories'));
}

beforeEach(() => {
  process.env.GITHUB_APP_ID = '12345';
  process.env.GITHUB_APP_PRIVATE_KEY = privateKey as string;
  process.env.GITHUB_APP_CLIENT_ID = 'Iv1.test';
  process.env.GITHUB_APP_CLIENT_SECRET = 'secret';
  process.env.GITHUB_APP_WEBHOOK_SECRET = 'whsec';
  process.env.GITHUB_APP_NAME = 'mindblown-by-project-li';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('listInstallationRepositories', () => {
  it('collects repositories across pages by following Link', async () => {
    const calls = stubGitHub((i) =>
      i === 0
        ? {
            body: { total_count: 3, repositories: [repo(1), repo(2)] },
            link: `<${REPOS_URL}?per_page=100&after=1>; rel="next"`,
          }
        : { body: { total_count: 3, repositories: [repo(3)] } },
    );

    const repos = await listInstallationRepositories('inst-1');

    expect(repos.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(listingCalls(calls)).toHaveLength(2);
  });

  it('stops on total_count even when a next Link is still offered', async () => {
    const calls = stubGitHub(() => ({
      body: { total_count: 2, repositories: [repo(1), repo(2)] },
      link: `<${REPOS_URL}?per_page=100&after=1>; rel="next"`,
    }));

    const repos = await listInstallationRepositories('inst-2');

    expect(repos).toHaveLength(2);
    expect(listingCalls(calls)).toHaveLength(1);
  });

  it('terminates on a self-referential Link when total_count never lands', async () => {
    // THE finding. `total_count` absent → every comparison against
    // `undefined` is false, and a header that keeps advertising a next
    // page keeps the loop going. Before the ceiling this did not
    // terminate; the assertion is simply that the call returns.
    const calls = stubGitHub(() => ({
      body: { repositories: [repo(1)] },
      link: `<${REPOS_URL}?per_page=100&after=1>; rel="next"`,
    }));

    const repos = await listInstallationRepositories('inst-3');

    expect(listingCalls(calls)).toHaveLength(100);
    expect(repos).toHaveLength(100);
  });

  it('stops when the server offers no next Link', async () => {
    const calls = stubGitHub(() => ({
      body: { total_count: 999, repositories: [repo(1)] },
    }));

    const repos = await listInstallationRepositories('inst-4');

    expect(repos).toHaveLength(1);
    expect(listingCalls(calls)).toHaveLength(1);
  });

  it('refuses to follow a Link to another origin', async () => {
    // Same guard as `paginateGitHub`, and it has to be stated separately
    // here because this loop is hand-written: the next request would
    // carry the installation token to that host.
    const calls = stubGitHub(() => ({
      body: { total_count: 999, repositories: [repo(1)] },
      link: '<http://evil.example/steal?after=1>; rel="next"',
    }));

    await expect(listInstallationRepositories('inst-5')).rejects.toBeInstanceOf(
      GitHubCrossOriginPaginationError,
    );

    expect(calls.some((c) => c.includes('evil.example'))).toBe(false);
  });
});

describe('mintScopedRepoToken (fleet worker, #507)', () => {
  /** Answers the token endpoint with `statusFor(permissions)`; records each request's permissions. */
  function stubMint(statusFor: (perms: Record<string, string>) => number) {
    const asked: Array<Record<string, string>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        const { permissions } = JSON.parse(init.body) as { permissions: Record<string, string> };
        asked.push(permissions);
        const status = statusFor(permissions);
        return {
          ok: status < 300,
          status,
          headers: new Headers(),
          text: async () => '{"message":"The permissions requested are not granted to this installation."}',
          json: async () => ({ token: 'ghs_scoped', expires_at: '2026-10-20T15:00:00Z' }),
        };
      }),
    );
    return asked;
  }

  it('asks for push + PR + CI read, scoped to the one repo', async () => {
    const asked = stubMint(() => 201);
    const t = await mintScopedRepoToken('inst-1', 'navy-app');
    expect(t.token).toBe('ghs_scoped');
    expect(asked).toEqual([{ contents: 'write', pull_requests: 'write', checks: 'read', statuses: 'read' }]);
  });

  it('an App without CI read (422) still gets a push + PR token', async () => {
    const asked = stubMint((p) => (p.checks ? 422 : 201));
    const t = await mintScopedRepoToken('inst-1', 'navy-app');
    expect(t.token).toBe('ghs_scoped');
    expect(asked).toEqual([
      { contents: 'write', pull_requests: 'write', checks: 'read', statuses: 'read' },
      { contents: 'write', pull_requests: 'write' },
    ]);
  });

  it('a map that lets the fleet change CI asks for workflows write too', async () => {
    const asked = stubMint(() => 201);
    await mintScopedRepoToken('inst-1', 'xmirror', { workflows: true });
    expect(asked).toEqual([{ contents: 'write', pull_requests: 'write', checks: 'read', statuses: 'read', workflows: 'write' }]);
  });

  it('an App without Workflows (422) gets the usual token', async () => {
    const asked = stubMint((p) => (p.workflows ? 422 : 201));
    const t = await mintScopedRepoToken('inst-1', 'xmirror', { workflows: true });
    expect(t.token).toBe('ghs_scoped');
    expect(asked).toEqual([
      { contents: 'write', pull_requests: 'write', checks: 'read', statuses: 'read', workflows: 'write' },
      { contents: 'write', pull_requests: 'write', checks: 'read', statuses: 'read' },
    ]);
  });

  it('an App without push rights fails clearly (422 on both)', async () => {
    stubMint(() => 422);
    await expect(mintScopedRepoToken('inst-1', 'navy-app')).rejects.toMatchObject({ status: 422 });
  });
});

describe('user-token helpers', () => {
  function stubOnce(responses: Array<{ status: number; body: unknown; link?: string }>) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), init });
        const r = responses.shift()!;
        return {
          ok: r.status < 300,
          status: r.status,
          headers: new Headers(r.link ? { link: r.link } : {}),
          json: async () => r.body,
          text: async () => JSON.stringify(r.body),
        };
      }),
    );
    return calls;
  }

  it('createGitHubRepository posts to /user/repos, or /orgs/{org}/repos, with auto_init', async () => {
    const calls = stubOnce([
      { status: 201, body: { full_name: 'alice/a' } },
      { status: 201, body: { full_name: 'acme/b' } },
    ]);
    await createGitHubRepository('ut', { name: 'a', private: true });
    await createGitHubRepository('ut', { name: 'b', private: false, description: 'd', org: 'acme' });
    expect(calls.map((c) => [c.url, c.init.method])).toEqual([
      ['https://api.github.com/user/repos', 'POST'],
      ['https://api.github.com/orgs/acme/repos', 'POST'],
    ]);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ name: 'a', private: true, auto_init: true });
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ name: 'b', private: false, description: 'd', auto_init: true });
  });

  it('createGitHubRepository surfaces the status (422 = name taken)', async () => {
    stubOnce([{ status: 422, body: { message: 'name already exists' } }]);
    await expect(createGitHubRepository('ut', { name: 'a', private: true })).rejects.toMatchObject({ status: 422 });
  });

  it('listUserInstallations follows the next link', async () => {
    const next = 'https://api.github.com/user/installations?per_page=100&page=2';
    const calls = stubOnce([
      { status: 200, body: { total_count: 2, installations: [{ id: 1 }] }, link: `<${next}>; rel="next"` },
      { status: 200, body: { total_count: 2, installations: [{ id: 2 }] } },
    ]);
    expect((await listUserInstallations('ut')).map((i) => i.id)).toEqual([1, 2]);
    expect(calls.map((c) => c.url)).toEqual(['https://api.github.com/user/installations?per_page=100', next]);
  });

  it("the server's own installation token never carries Administration", async () => {
    const calls = stubOnce([
      { status: 422, body: { message: 'permissions not granted' } },
      { status: 201, body: { token: 'ghs_narrow', expires_at: new Date(Date.now() + 3600_000).toISOString() } },
    ]);
    expect(await mintInstallationToken('narrow-test-1')).toBe('ghs_narrow');
    const asked = calls.map((c) => JSON.parse(String(c.init.body)).permissions);
    expect(asked[0]).toEqual({ contents: 'write', issues: 'write', pull_requests: 'write', metadata: 'read', checks: 'read', statuses: 'read' });
    expect(asked[1]).toEqual({ contents: 'write', issues: 'write', pull_requests: 'write', metadata: 'read' });
  });

  it('falls back to an issues-only token for an installation without contents/PR rights', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const calls = stubOnce([
      { status: 422, body: {} },
      { status: 422, body: {} },
      { status: 201, body: { token: 'ghs_issues', expires_at: new Date(Date.now() + 3600_000).toISOString() } },
    ]);
    expect(await mintInstallationToken('narrow-test-2')).toBe('ghs_issues');
    expect(JSON.parse(String(calls[2].init.body)).permissions).toEqual({ issues: 'write', metadata: 'read' });
  });
});
