/**
 * services/trustPolicy (#491): a map with no saved policy runs on the
 * defaults — the creator, the login the forge binding syncs as plus the
 * creator's own forge logins, safe knobs for both untrusted levels. A save
 * writes the column and journals the change.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TrustPolicy } from '@mindblown/core';

const mocks = vi.hoisted(() => ({
  selects: [] as unknown[][],
  updates: [] as Record<string, unknown>[],
  events: [] as Record<string, unknown>[],
  forgeRow: null as null | { config: { oauthIdentityId?: string | null } },
}));

vi.mock('../../db/connection.js', () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => mocks.selects.shift() ?? [] }) }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: async () => {
          mocks.updates.push(v);
        },
      }),
    }),
  },
}));
vi.mock('../../db/events.js', () => ({
  recordEvent: async (e: Record<string, unknown>) => {
    mocks.events.push(e);
  },
}));
vi.mock('../../lib/githubContext.js', () => ({ getForgeIntegration: async () => mocks.forgeRow }));

import { getTrustPolicy, setTrustPolicy } from '../trustPolicy.js';

const mapRow = (trustPolicy: TrustPolicy | null, repo = true) => ({
  trustPolicy,
  workspaceId: 'ws',
  createdBy: 'creator',
  githubRepoOwner: repo ? 'dan' : null,
  githubRepoName: repo ? 'app' : null,
});
const SAFE = { dispatch: 'approval', merge: 'pr-only' };

beforeEach(() => {
  mocks.selects = [];
  mocks.updates = [];
  mocks.events = [];
  mocks.forgeRow = null;
});

describe('getTrustPolicy', () => {
  it('defaults: creator, the OAuth binding login and the creator\'s own logins, safe levels', async () => {
    mocks.forgeRow = { config: { oauthIdentityId: 'ident-1' } };
    mocks.selects = [[mapRow(null)], [{ login: 'sync-bot' }], [{ login: 'dan' }, { login: 'sync-bot' }]];
    expect(await getTrustPolicy('m')).toEqual({
      isDefault: true,
      policy: {
        trustedUserIds: ['creator'],
        trustedForgeLogins: ['sync-bot', 'dan'],
        levels: { known: SAFE, external: SAFE },
      },
    });
  });

  it('a map without a repo trusts only the creator\'s logins', async () => {
    mocks.selects = [[mapRow(null, false)], [{ login: 'dan' }]];
    expect((await getTrustPolicy('m'))?.policy.trustedForgeLogins).toEqual(['dan']);
  });

  it('a saved policy wins, as is', async () => {
    const saved: TrustPolicy = { trustedUserIds: [], trustedForgeLogins: ['x'], levels: { known: SAFE, external: SAFE } } as TrustPolicy;
    mocks.selects = [[mapRow(saved)]];
    expect(await getTrustPolicy('m')).toEqual({ policy: saved, isDefault: false });
  });

  it('null for a map that does not exist', async () => {
    expect(await getTrustPolicy('nope')).toBeNull();
  });
});

describe('setTrustPolicy', () => {
  it('writes the column and journals old → new', async () => {
    const next: TrustPolicy = { trustedUserIds: ['a'], trustedForgeLogins: [], levels: { known: SAFE, external: SAFE } } as TrustPolicy;
    mocks.selects = [[mapRow(null, false)], [], [mapRow(next, false)]];
    const result = await setTrustPolicy('m', next, 'admin-1');
    expect(result).toEqual({ policy: next, isDefault: false });
    expect(mocks.updates[0]).toMatchObject({ trustPolicy: next });
    expect(mocks.events).toEqual([
      expect.objectContaining({ mapId: 'm', userId: 'admin-1', fieldName: 'trustPolicy', oldValue: null, newValue: next }),
    ]);
  });
});
