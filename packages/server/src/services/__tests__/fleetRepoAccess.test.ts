/**
 * Repo credentials for a fleet (#507): only the fleet's own key, only for a
 * project connected to it right now and not archived, only with a forge
 * connection — and every handout recorded, never the token.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const FLEET = '11111111-2222-4333-8444-555555555555';
const OTHER_FLEET = '22222222-2222-4333-8444-555555555555';
const MAP = '33333333-2222-4333-8444-555555555555';
const SVC = 'svc-user';

const state = vi.hoisted(() => ({
  serviceOf: {} as Record<string, { id: string; name: string } | null>,
  maps: {} as Record<string, { fleetId: string | null; archivedAt: Date | null }>,
  ctx: null as null | { owner: string; repo: string; token: string; forge: { endpoint: { kind: string; apiBaseUrl: string; webBaseUrl: string } } },
  recorded: [] as Array<[string, string, string]>,
}));

vi.mock('../../db/fleets.js', () => ({
  fleetOfServiceUser: async (u: string) => state.serviceOf[u] ?? null,
  getMapFleetState: async (m: string) => state.maps[m] ?? null,
}));
vi.mock('../../db/fleetRepoHandouts.js', () => ({
  recordHandout: async (f: string, m: string, r: string) => {
    state.recorded.push([f, m, r]);
  },
}));
vi.mock('../../lib/githubContext.js', async () => {
  const actual = await vi.importActual<typeof import('../../lib/githubContext.js')>('../../lib/githubContext.js');
  return { ticketRepo: actual.ticketRepo, getForgeContextForMap: async () => state.ctx };
});

import { issueRepoCredentials } from '../fleetRepoAccess.js';

beforeEach(() => {
  state.serviceOf = { [SVC]: { id: FLEET, name: 'big-blower' }, person: null };
  state.maps = { [MAP]: { fleetId: FLEET, archivedAt: null } };
  state.ctx = {
    owner: 'dan',
    repo: 'crm2',
    token: 'gitea-token',
    forge: { endpoint: { kind: 'gitea', apiBaseUrl: 'https://git.example/api/v1', webBaseUrl: 'https://git.example/' } },
  };
  state.recorded = [];
});

describe('issueRepoCredentials (#507)', () => {
  it("hands the fleet's own key the project's repo and token, and records it", async () => {
    const r = await issueRepoCredentials(SVC, FLEET, MAP);
    expect(r).toEqual({
      forge: 'gitea',
      owner: 'dan',
      name: 'crm2',
      webUrl: 'https://git.example/dan/crm2',
      cloneUrl: 'https://git.example/dan/crm2.git',
      apiBaseUrl: 'https://git.example/api/v1',
      token: 'gitea-token',
      gitUsername: 'x-access-token',
    });
    expect(state.recorded).toEqual([[FLEET, MAP, 'dan/crm2']]);
  });

  it("refuses a person's session and another fleet's key", async () => {
    expect(await issueRepoCredentials('person', FLEET, MAP)).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    state.serviceOf.other = { id: OTHER_FLEET, name: 'x' };
    expect(await issueRepoCredentials('other', FLEET, MAP)).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(state.recorded).toEqual([]);
  });

  it('refuses a project not connected to this fleet — e.g. right after unpicking', async () => {
    state.maps[MAP] = { fleetId: null, archivedAt: null };
    expect(await issueRepoCredentials(SVC, FLEET, MAP)).toMatchObject({ status: 403, code: 'NOT_CONNECTED' });
    expect(await issueRepoCredentials(SVC, FLEET, 'no-such-map')).toMatchObject({ status: 403, code: 'NOT_CONNECTED' });
  });

  it('refuses an archived project and one without a repo', async () => {
    state.maps[MAP] = { fleetId: FLEET, archivedAt: new Date() };
    expect(await issueRepoCredentials(SVC, FLEET, MAP)).toMatchObject({ status: 409, code: 'MAP_ARCHIVED' });
    state.maps[MAP] = { fleetId: FLEET, archivedAt: null };
    state.ctx = null;
    expect(await issueRepoCredentials(SVC, FLEET, MAP)).toMatchObject({ status: 404, code: 'NO_REPO' });
    expect(state.recorded).toEqual([]);
  });

  it('needs a mapId', async () => {
    expect(await issueRepoCredentials(SVC, FLEET, undefined)).toMatchObject({ status: 400 });
  });
});
