/**
 * #513: which forge errors count as "the forge refuses this binding", and
 * the per-binding streak catch-up keeps for lib/forgeProblem.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ForgeApiError } from '@mindblown/integrations';
import {
  appBindingKey,
  clearForgeRefusal,
  forgeRefusalFor,
  noteForgeRefusal,
  refusalStatus,
  resetForgeRefusals,
  rowBindingKey,
} from '../forgeRefusals.js';

beforeEach(() => resetForgeRefusals());

describe('refusalStatus', () => {
  it('401, 404 and a plain 403 are refusals, on GitHub and Gitea alike', () => {
    expect(refusalStatus(new ForgeApiError(401, 'Bad credentials'))).toBe(401);
    expect(refusalStatus(new ForgeApiError(403, 'token does not have at least one of required scope(s)', 'gitea'))).toBe(403);
    expect(refusalStatus(new ForgeApiError(404, 'Not Found', 'gitea'))).toBe(404);
  });

  it('a rate-limit 403, other statuses and non-forge errors are not', () => {
    expect(refusalStatus(new ForgeApiError(403, '{"message":"API rate limit exceeded for installation"}'))).toBeNull();
    expect(refusalStatus(new ForgeApiError(500, 'boom'))).toBeNull();
    expect(refusalStatus(new ForgeApiError(422, 'Validation Failed'))).toBeNull();
    expect(refusalStatus(new Error('ECONNRESET'))).toBeNull();
  });
});

describe('binding keys', () => {
  it('a row key changes when the row is re-connected (updatedAt bump); an App key is the installation', () => {
    const before = rowBindingKey({ id: 'r1', updatedAt: new Date('2026-10-20T08:00:00Z') });
    const after = rowBindingKey({ id: 'r1', updatedAt: new Date('2026-10-20T09:00:00Z') });
    expect(before).not.toBe(after);
    expect(rowBindingKey({ id: 'r2', updatedAt: new Date('2026-10-20T08:00:00Z') })).not.toBe(before);
    expect(appBindingKey('123')).toBe('app:123');
  });
});

describe('refusal streak', () => {
  it('keeps the first refusal time across ticks, the latest status, and clears', () => {
    noteForgeRefusal('row:r1:1', 401, new Date('2026-10-20T08:00:00Z'));
    noteForgeRefusal('row:r1:1', 403, new Date('2026-10-20T08:10:00Z'));
    expect(forgeRefusalFor('row:r1:1')).toEqual({ status: 403, since: '2026-10-20T08:00:00.000Z' });
    expect(forgeRefusalFor('row:r2:1')).toBeNull();
    clearForgeRefusal('row:r1:1');
    expect(forgeRefusalFor('row:r1:1')).toBeNull();
  });
});
