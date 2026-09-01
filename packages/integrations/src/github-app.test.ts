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
import { listInstallationRepositories } from './github-app.js';
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
