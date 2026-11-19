/**
 * POST /api/fleets/:id/repo-credentials carries `canEditCi` — the map's
 * `fleetCanEditCi` — on both forges, so a worker that pushes over SSH (or
 * with a token that can't be narrowed) enforces the CI rule itself.
 *
 * Real plugin, real fleetRepoAccess and githubContext; below them the DB
 * rows, the forge resolution and the App token mint are stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { TicketRepoCredentials } from '@mindblown/tool-kit';

const FLEET = '11111111-2222-4333-8444-555555555555';
const SVC = 'fleet-service-user';
const DAN = 'dan';
const GITHUB_MAP = 'map-github';
const GITEA_MAP = 'map-gitea';

const state = vi.hoisted(() => ({
  /** maps rows as loadMapBinding selects them, by map id. */
  mapRows: {} as Record<string, Record<string, unknown>>,
  currentMap: '' as string,
  integrationRows: [] as Array<Record<string, unknown>>,
  mints: [] as Array<{ installationId: string; repo: string; opts: unknown }>,
}));

vi.mock('../../db/connection.js', async () => {
  const schema = await vi.importActual<typeof import('../../db/schema.js')>('../../db/schema.js');
  return {
    db: {
      select: () => ({
        from: (t: unknown) => ({
          where: async () => {
            if (t === schema.maps) return state.mapRows[state.currentMap] ? [state.mapRows[state.currentMap]] : [];
            if (t === schema.integrations) return state.integrationRows;
            return [];
          },
        }),
      }),
    },
  };
});

vi.mock('../../db/fleets.js', () => ({
  fleetOfServiceUser: async (u: string) => (u === SVC ? { id: FLEET, name: 'big-blower' } : null),
  getMapFleetState: async (m: string) => {
    state.currentMap = m;
    return state.mapRows[m] ? { fleetId: FLEET, archivedAt: null, createdBy: DAN } : null;
  },
  getFleet: async (id: string) => (id === FLEET ? { id: FLEET, ownerId: DAN } : null),
}));
vi.mock('../../db/fleetRepoHandouts.js', () => ({ recordHandout: async () => {}, summarizeHandouts: async () => [] }));

vi.mock('../../lib/forge.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../lib/forge.js');
  return {
    ...actual,
    forgeFromIntegration: async () => ({
      token: 'gitea-token',
      endpoint: { kind: 'gitea', apiBaseUrl: 'https://git.test/api/v1', webBaseUrl: 'https://git.test' },
    }),
  };
});
vi.mock('@mindblown/integrations', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@mindblown/integrations');
  return {
    ...actual,
    mintScopedRepoToken: async (installationId: string, repo: string, opts: unknown) => {
      state.mints.push({ installationId, repo, opts });
      return { token: 'app-token' };
    },
  };
});

import { fleetEntityRoutes } from '../fleets.js';

async function fetchCredentials(mapId: string) {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (req) => {
    req.userId = SVC;
    Object.assign(req, { authSource: 'api-key' });
  });
  await app.register(fleetEntityRoutes);
  const res = await app.inject({ method: 'POST', url: `/api/fleets/${FLEET}/repo-credentials`, payload: { mapId } });
  await app.close();
  return res;
}

beforeEach(() => {
  state.mapRows = {
    [GITHUB_MAP]: { githubInstallationId: 'inst', githubRepoOwner: 'acme', githubRepoName: 'app', workspaceId: 'ws', fleetCanEditCi: false },
    [GITEA_MAP]: { githubInstallationId: null, githubRepoOwner: 'dan', githubRepoName: 'product', workspaceId: 'ws', fleetCanEditCi: false },
  };
  state.integrationRows = [
    {
      id: 'i1',
      enabled: true,
      provider: 'gitea',
      updatedAt: new Date(),
      config: { owner: 'dan', repo: 'product', token: 't', apiBaseUrl: 'https://git.test/api/v1' },
    },
  ];
  state.mints = [];
});

describe('repo credentials carry canEditCi on every forge', () => {
  for (const ci of [true, false]) {
    it(`GitHub App map with fleetCanEditCi ${ci}: canEditCi ${ci}, and the token matches`, async () => {
      state.mapRows[GITHUB_MAP].fleetCanEditCi = ci;
      const res = await fetchCredentials(GITHUB_MAP);
      expect(res.statusCode).toBe(200);
      const body = res.json() as TicketRepoCredentials;
      expect(body).toMatchObject({ forge: 'github', owner: 'acme', name: 'app', token: 'app-token', canEditCi: ci });
      expect(state.mints).toEqual([{ installationId: 'inst', repo: 'app', opts: { workflows: ci } }]);
    });

    it(`Gitea map with fleetCanEditCi ${ci}: canEditCi ${ci}`, async () => {
      state.mapRows[GITEA_MAP].fleetCanEditCi = ci;
      const res = await fetchCredentials(GITEA_MAP);
      expect(res.statusCode).toBe(200);
      const body = res.json() as TicketRepoCredentials;
      expect(body).toMatchObject({ forge: 'gitea', owner: 'dan', name: 'product', token: 'gitea-token', canEditCi: ci });
      expect(typeof body.canEditCi).toBe('boolean');
      expect(state.mints).toEqual([]);
    });
  }
});
