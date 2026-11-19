/**
 * Repo credentials for a fleet (#507): only the fleet's own key, only for a
 * project connected to it right now and not archived, only to a fleet owned
 * by the project's creator (the token is theirs), only with a forge
 * connection — and every handout recorded, never the token.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const FLEET = '11111111-2222-4333-8444-555555555555';
const OTHER_FLEET = '22222222-2222-4333-8444-555555555555';
const MAP = '33333333-2222-4333-8444-555555555555';
const SVC = 'svc-user';
const DAN = 'dan';
const EVE = 'eve';

const state = vi.hoisted(() => ({
  serviceOf: {} as Record<string, { id: string; name: string } | null>,
  fleets: {} as Record<string, { id: string; ownerId: string }>,
  maps: {} as Record<string, { fleetId: string | null; archivedAt: Date | null; createdBy: string }>,
  found: null as null | { repo: Record<string, string>; token: string },
  recorded: [] as Array<[string, string, string]>,
}));

vi.mock('../../db/fleets.js', () => ({
  fleetOfServiceUser: async (u: string) => state.serviceOf[u] ?? null,
  getMapFleetState: async (m: string) => state.maps[m] ?? null,
  getFleet: async (id: string) => state.fleets[id] ?? null,
}));
vi.mock('../../db/fleetRepoHandouts.js', () => ({
  recordHandout: async (f: string, m: string, r: string) => {
    state.recorded.push([f, m, r]);
  },
}));
vi.mock('../../lib/githubContext.js', () => ({ getFleetRepoCredentials: async () => state.found }));

import { issueRepoCredentials } from '../fleetRepoAccess.js';

const REPO = {
  forge: 'gitea',
  owner: 'dan',
  name: 'crm2',
  webUrl: 'https://git.example/dan/crm2',
  cloneUrl: 'https://git.example/dan/crm2.git',
  apiBaseUrl: 'https://git.example/api/v1',
};

beforeEach(() => {
  state.serviceOf = { [SVC]: { id: FLEET, name: 'big-blower' }, person: null };
  state.fleets = { [FLEET]: { id: FLEET, ownerId: DAN }, [OTHER_FLEET]: { id: OTHER_FLEET, ownerId: EVE } };
  state.maps = { [MAP]: { fleetId: FLEET, archivedAt: null, createdBy: DAN } };
  state.found = { repo: REPO, token: 'gitea-token' };
  state.recorded = [];
});

describe('issueRepoCredentials (#507)', () => {
  it("hands the fleet's own key the project's repo and token, and records it", async () => {
    expect(await issueRepoCredentials(SVC, FLEET, MAP)).toEqual({ ...REPO, token: 'gitea-token', gitUsername: 'x-access-token' });
    expect(state.recorded).toEqual([[FLEET, MAP, 'dan/crm2']]);
  });

  it("refuses a person's session and another fleet's key", async () => {
    expect(await issueRepoCredentials('person', FLEET, MAP)).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    state.serviceOf.other = { id: OTHER_FLEET, name: 'x' };
    expect(await issueRepoCredentials('other', FLEET, MAP)).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(state.recorded).toEqual([]);
  });

  it("a map admin who connects the creator's map to their own fleet gets no token", async () => {
    state.serviceOf.eveSvc = { id: OTHER_FLEET, name: 'eve-fleet' };
    state.maps[MAP] = { fleetId: OTHER_FLEET, archivedAt: null, createdBy: DAN };
    expect(await issueRepoCredentials('eveSvc', OTHER_FLEET, MAP)).toMatchObject({ status: 403, code: 'NOT_PROJECT_OWNER' });
    expect(state.recorded).toEqual([]);
  });

  it('refuses a project not connected to this fleet — e.g. right after unpicking', async () => {
    state.maps[MAP] = { fleetId: null, archivedAt: null, createdBy: DAN };
    expect(await issueRepoCredentials(SVC, FLEET, MAP)).toMatchObject({ status: 403, code: 'NOT_CONNECTED' });
    expect(await issueRepoCredentials(SVC, FLEET, 'no-such-map')).toMatchObject({ status: 403, code: 'NOT_CONNECTED' });
  });

  it('refuses an archived project and one without a repo', async () => {
    state.maps[MAP] = { fleetId: FLEET, archivedAt: new Date(), createdBy: DAN };
    expect(await issueRepoCredentials(SVC, FLEET, MAP)).toMatchObject({ status: 409, code: 'MAP_ARCHIVED' });
    state.maps[MAP] = { fleetId: FLEET, archivedAt: null, createdBy: DAN };
    state.found = null;
    expect(await issueRepoCredentials(SVC, FLEET, MAP)).toMatchObject({ status: 404, code: 'NO_REPO' });
    expect(state.recorded).toEqual([]);
  });

  it('needs a mapId', async () => {
    expect(await issueRepoCredentials(SVC, FLEET, undefined)).toMatchObject({ status: 400 });
  });
});
