import { describe, it, expect, vi } from 'vitest';

// The DB-backed helpers are not exercised here; the module imports the
// connection at load time, so stub it.
vi.mock('../../db/connection.js', () => ({ db: {} }));
vi.mock('../../db/schema.js', () => ({ integrations: {}, maps: {}, userGithubIdentities: {} }));

import { isServableIntegrationConfig, pickForgeRow, FORGE_PROVIDERS } from '../forge.js';

describe('pickForgeRow — one row per repo', () => {
  const row = (id: string, repo: string, enabled: boolean, at: number) => ({ id, enabled, updatedAt: new Date(at), config: { owner: 'dan', repo } });
  const rows = [row('sonar', 'Sonarpipe', true, 1), row('crm2', 'crm2', true, 2), row('old', 'Sonarpipe', false, 3)];

  it("finds a repo's row even when another repo's row is newer", () => {
    expect(pickForgeRow(rows, { owner: 'dan', repo: 'Sonarpipe' })?.id).toBe('sonar');
  });
  it('without a repo: the newest enabled row', () => {
    expect(pickForgeRow(rows)?.id).toBe('crm2');
  });
  it('an unknown repo finds nothing', () => {
    expect(pickForgeRow(rows, { owner: 'dan', repo: 'other' })).toBeUndefined();
  });
  it('includeDisabled still prefers the enabled row, then falls back to a disabled one', () => {
    expect(pickForgeRow(rows, { owner: 'dan', repo: 'Sonarpipe', includeDisabled: true })?.id).toBe('sonar');
    expect(pickForgeRow([row('old', 'x', false, 1)], { owner: 'dan', repo: 'x', includeDisabled: true })?.id).toBe('old');
    expect(pickForgeRow([row('old', 'x', false, 1)], { owner: 'dan', repo: 'x' })).toBeUndefined();
  });
});

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
