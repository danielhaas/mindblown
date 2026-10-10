/**
 * A workspace's PAT/OAuth forge row binds only the maps that name its repo
 * (#421). Before, every map of the workspace inherited the row's repo, so
 * re-binding the row to another repo re-pointed every non-App map at it —
 * two maps imported a third map's issues by the hundred.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/schema.js', () => ({
  maps: { __t: 'maps', id: 'id', githubInstallationId: 'gi', githubRepoOwner: 'o', githubRepoName: 'n', workspaceId: 'w' },
  integrations: { __t: 'integrations', workspaceId: 'w', provider: 'p' },
}));

let mapRow: Record<string, unknown> | undefined;
let integrationRows: Array<Record<string, unknown>> = [];
vi.mock('../../db/connection.js', () => ({
  db: {
    select: () => ({
      from: (t: { __t: string }) => ({
        where: async () => (t.__t === 'maps' ? (mapRow ? [mapRow] : []) : integrationRows),
      }),
    }),
  },
}));

const fakeForge = { token: 'resolved', endpoint: { kind: 'gitea', apiBaseUrl: 'https://git.test/api/v1', webBaseUrl: 'https://git.test' } };
vi.mock('../forge.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../forge.js');
  return {
    ...actual,
    forgeFromIntegration: async () => fakeForge,
    forgeFromInstallation: async () => ({ token: 'app', endpoint: { kind: 'github' } }),
  };
});

import { getGitHubContextForMap, getMapForgeKind } from '../githubContext.js';

const giteaRow = {
  id: 'i1',
  enabled: true,
  provider: 'gitea',
  updatedAt: new Date(),
  config: { owner: 'dan', repo: 'product', token: 't', apiBaseUrl: 'https://git.test/api/v1' },
};

beforeEach(() => {
  integrationRows = [giteaRow];
});

describe('PAT/OAuth binding is per map (#421)', () => {
  it('a map that names the row\'s repo is bound to it', async () => {
    mapRow = { githubInstallationId: null, githubRepoOwner: 'dan', githubRepoName: 'product', workspaceId: 'ws' };
    expect(await getGitHubContextForMap('m1')).toMatchObject({ owner: 'dan', repo: 'product', token: 'resolved' });
    expect(await getMapForgeKind('m1')).toBe('gitea');
  });

  it('a map without a repo of its own is unbound — it does not inherit the workspace row\'s repo', async () => {
    mapRow = { githubInstallationId: null, githubRepoOwner: null, githubRepoName: null, workspaceId: 'ws' };
    expect(await getGitHubContextForMap('m2')).toBeNull();
    expect(await getMapForgeKind('m2')).toBeNull();
  });

  it('a map planning another repo is not re-pointed when the row is re-bound', async () => {
    mapRow = { githubInstallationId: null, githubRepoOwner: 'dan', githubRepoName: 'predecessor', workspaceId: 'ws' };
    expect(await getGitHubContextForMap('m3')).toBeNull();
    expect(await getMapForgeKind('m3')).toBeNull();
  });

  it('a GitHub App map keeps its own binding', async () => {
    mapRow = { githubInstallationId: 'inst', githubRepoOwner: 'acme', githubRepoName: 'app', workspaceId: 'ws' };
    expect(await getGitHubContextForMap('m4')).toMatchObject({ owner: 'acme', repo: 'app', token: 'app' });
    expect(await getMapForgeKind('m4')).toBe('github');
  });
});
