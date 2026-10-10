/**
 * Which map a connect may bind (#421): one of the workspace's own maps,
 * not one bound through the GitHub App.
 */
import { describe, it, expect, vi } from 'vitest';

let mapRow: Record<string, unknown> | undefined;
vi.mock('../../db/connection.js', () => ({
  db: { select: () => ({ from: () => ({ where: async () => (mapRow ? [mapRow] : []) }) }) },
}));
vi.mock('../giteaOAuth.js', () => ({ findGiteaIdentityById: vi.fn(), giteaAccessTokenFor: vi.fn() }));

import { mapBindableToWorkspaceForge } from '../forge.js';

describe('mapBindableToWorkspaceForge', () => {
  it('a map of the workspace without an App binding may be bound', async () => {
    mapRow = { workspaceId: 'ws', githubInstallationId: null };
    expect(await mapBindableToWorkspaceForge('m1', 'ws')).toEqual({ ok: true });
  });

  it('a map of another workspace, or none, is refused', async () => {
    mapRow = { workspaceId: 'other', githubInstallationId: null };
    expect(await mapBindableToWorkspaceForge('m1', 'ws')).toMatchObject({ ok: false });
    mapRow = undefined;
    expect(await mapBindableToWorkspaceForge('m1', 'ws')).toMatchObject({ ok: false });
  });

  it('an App-bound map is refused — its binding has its own repo and token', async () => {
    mapRow = { workspaceId: 'ws', githubInstallationId: 'inst' };
    expect(await mapBindableToWorkspaceForge('m1', 'ws')).toMatchObject({ ok: false, reason: expect.stringMatching(/GitHub App/) });
  });
});
