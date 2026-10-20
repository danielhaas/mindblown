/**
 * #513: which forge errors count as "the forge refuses this token", and
 * the per-repo streak catch-up keeps for lib/forgeProblem.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ForgeApiError } from '@mindblown/integrations';
import {
  clearForgeRefusal,
  forgeRefusalFor,
  noteForgeRefusal,
  refusalStatus,
  resetForgeRefusals,
} from '../forgeRefusals.js';

beforeEach(() => resetForgeRefusals());

describe('refusalStatus', () => {
  it('401 and a plain 403 are refusals, on GitHub and Gitea alike', () => {
    expect(refusalStatus(new ForgeApiError(401, 'Bad credentials'))).toBe(401);
    expect(refusalStatus(new ForgeApiError(403, 'token does not have at least one of required scope(s)', 'gitea'))).toBe(403);
  });

  it('a rate-limit 403, other statuses and non-forge errors are not', () => {
    expect(refusalStatus(new ForgeApiError(403, '{"message":"API rate limit exceeded for installation"}'))).toBeNull();
    expect(refusalStatus(new ForgeApiError(404, 'Not Found'))).toBeNull();
    expect(refusalStatus(new ForgeApiError(500, 'boom'))).toBeNull();
    expect(refusalStatus(new Error('ECONNRESET'))).toBeNull();
  });
});

describe('refusal streak', () => {
  it('keeps the first refusal time across ticks, matches case-insensitively, and clears', () => {
    noteForgeRefusal('dan', 'Sonarpipe', 401, new Date('2026-10-20T08:00:00Z'));
    noteForgeRefusal('dan', 'Sonarpipe', 403, new Date('2026-10-20T08:10:00Z'));
    expect(forgeRefusalFor('Dan', 'sonarpipe')).toEqual({ status: 403, since: '2026-10-20T08:00:00.000Z' });
    expect(forgeRefusalFor('dan', 'crm2')).toBeNull();
    clearForgeRefusal('dan', 'sonarpipe');
    expect(forgeRefusalFor('dan', 'Sonarpipe')).toBeNull();
  });
});
