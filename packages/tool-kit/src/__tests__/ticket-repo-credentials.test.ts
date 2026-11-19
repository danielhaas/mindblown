/**
 * The repo-credentials body (POST /api/fleets/:id/repo-credentials) as the
 * tool-kit types it: `canEditCi` is required, so a worker reading it can
 * enforce fleetCanEditCi itself over SSH or an unnarrowed token.
 */
import { describe, it, expect, expectTypeOf } from 'vitest';
import type { TicketRepo, TicketRepoCredentials } from '../index.js';

describe('TicketRepoCredentials', () => {
  it('is a TicketRepo plus token, git user and a required canEditCi', () => {
    expectTypeOf<TicketRepoCredentials>().toMatchTypeOf<TicketRepo>();
    expectTypeOf<TicketRepoCredentials['canEditCi']>().toEqualTypeOf<boolean>();
    expectTypeOf<TicketRepoCredentials['gitUsername']>().toEqualTypeOf<'x-access-token'>();
  });

  it('round-trips through JSON with canEditCi intact', () => {
    for (const canEditCi of [true, false]) {
      const sent: TicketRepoCredentials = {
        forge: 'gitea',
        owner: 'dan',
        name: 'product',
        webUrl: 'https://git.test/dan/product',
        cloneUrl: 'https://git.test/dan/product.git',
        apiBaseUrl: 'https://git.test/api/v1',
        token: 't',
        gitUsername: 'x-access-token',
        canEditCi,
      };
      const got = JSON.parse(JSON.stringify(sent)) as TicketRepoCredentials;
      expect(got).toEqual(sent);
      expect(got.canEditCi).toBe(canEditCi);
    }
  });
});
