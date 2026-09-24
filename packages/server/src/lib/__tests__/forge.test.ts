import { describe, it, expect, vi } from 'vitest';

// The DB-backed helpers are not exercised here; the module imports the
// connection at load time, so stub it.
vi.mock('../../db/connection.js', () => ({ db: {} }));
vi.mock('../../db/schema.js', () => ({ integrations: {}, maps: {}, userGithubIdentities: {} }));

import { isServableIntegrationConfig, FORGE_PROVIDERS } from '../forge.js';

describe('isServableIntegrationConfig (#369)', () => {
  it('a PAT row is servable', () => {
    expect(isServableIntegrationConfig({ owner: 'o', repo: 'r', token: 'ghp_x' })).toBe(true);
  });
  it('an OAuth-bound row with an empty token is servable — the identity authenticates it', () => {
    expect(isServableIntegrationConfig({ owner: 'o', repo: 'r', token: '', oauthIdentityId: 'ident-1' })).toBe(true);
  });
  it('a row without owner/repo or without any credential is not', () => {
    expect(isServableIntegrationConfig({ owner: 'o', repo: 'r', token: '' })).toBe(false);
    expect(isServableIntegrationConfig({ owner: '', repo: 'r', token: 't' })).toBe(false);
    expect(isServableIntegrationConfig(null)).toBe(false);
  });
  it('forge providers are exactly github and gitea', () => {
    expect(FORGE_PROVIDERS).toEqual(['github', 'gitea']);
  });
});
