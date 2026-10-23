/**
 * userInstallationRepos asks GitHub with the user's own token and maps the
 * answers onto the errors the routes send back.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const gh = vi.hoisted(() => ({
  identity: { id: 'ident-1' } as { id: string } | null,
  tokenFails: false,
  list: vi.fn(),
}));
vi.mock('../githubIdentity.js', () => ({
  findGithubIdentity: async () => gh.identity,
  githubAccessTokenFor: async () => {
    if (gh.tokenFails) throw new Error('expired');
    return 'user-token';
  },
}));
vi.mock('@mindblown/integrations', () => ({
  listUserInstallationRepositories: (...a: unknown[]) => gh.list(...a),
}));

import { userInstallationRepos } from '../githubInstallations.js';

const fail = (status: number) => Object.assign(new Error(`GitHub API ${status}`), { status });

beforeEach(() => {
  gh.identity = { id: 'ident-1' };
  gh.tokenFails = false;
  gh.list.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('userInstallationRepos', () => {
  it("lists with the user's token", async () => {
    gh.list.mockResolvedValue([{ full_name: 'a/b' }]);
    expect(await userInstallationRepos('u1', '111')).toEqual({ repos: [{ full_name: 'a/b' }] });
    expect(gh.list).toHaveBeenCalledWith('user-token', '111');
  });

  it('refuses without a GitHub identity, or with one that cannot refresh', async () => {
    gh.identity = null;
    expect(await userInstallationRepos('u1', '111')).toMatchObject({ status: 403, code: 'GITHUB_NOT_CONNECTED' });
    gh.identity = { id: 'ident-1' };
    gh.tokenFails = true;
    expect(await userInstallationRepos('u1', '111')).toMatchObject({ status: 403, code: 'GITHUB_NOT_CONNECTED' });
    expect(gh.list).not.toHaveBeenCalled();
  });

  it("maps GitHub's 403/404 to 'not yours', 401 to reconnect, anything else to 502", async () => {
    gh.list.mockRejectedValueOnce(fail(404));
    expect(await userInstallationRepos('u1', '999')).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    gh.list.mockRejectedValueOnce(fail(403));
    expect(await userInstallationRepos('u1', '999')).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    gh.list.mockRejectedValueOnce(fail(401));
    expect(await userInstallationRepos('u1', '111')).toMatchObject({ status: 403, code: 'GITHUB_NOT_CONNECTED' });
    gh.list.mockRejectedValueOnce(fail(500));
    expect(await userInstallationRepos('u1', '111')).toMatchObject({ status: 502 });
  });
});
