import { describe, it, expect } from 'vitest';
import { approvalAtCreation, automationFor, defaultTrustPolicy, parseTrustPolicy, trustLevel, type TrustPolicy } from '../index.js';

const policy: TrustPolicy = {
  ...defaultTrustPolicy('owner', ['dan-bot']),
  levels: { known: { dispatch: 'auto', merge: 'pr-only' }, external: { dispatch: 'approval', merge: 'pr-only' } },
};
const members = ['owner', 'alice'];
const forgeUsers = [{ provider: 'github', login: 'alice-gh', userId: 'alice' }];
const user = (userId: string) => ({ reportedBy: { kind: 'user' as const, userId } });
const forge = (login: string, provider: 'github' | 'gitea' = 'github') => ({
  reportedBy: { kind: 'forge' as const, provider, login },
});

describe('trustLevel', () => {
  it('counts an unknown reporter as external (fail-closed, #492)', () => {
    expect(trustLevel({ reportedBy: null }, policy, members)).toBe('external');
  });
  it('trusts the listed user ids and forge logins (case-insensitive)', () => {
    expect(trustLevel(user('owner'), policy, members)).toBe('trusted');
    expect(trustLevel(forge('Dan-Bot'), policy, members)).toBe('trusted');
  });
  it('a member not on the list is known', () => {
    expect(trustLevel(user('alice'), policy, members)).toBe('known');
  });
  it('a forge author mapped to a member is known; to a trusted user, trusted', () => {
    expect(trustLevel(forge('alice-gh'), policy, members, forgeUsers)).toBe('known');
    const trustAlice = { ...policy, trustedUserIds: ['owner', 'alice'] };
    expect(trustLevel(forge('ALICE-GH'), trustAlice, members, forgeUsers)).toBe('trusted');
  });
  it('everyone else is external', () => {
    expect(trustLevel(user('stranger'), policy, members)).toBe('external');
    expect(trustLevel(forge('random'), policy, members, forgeUsers)).toBe('external');
    // the link is per forge: the same login on another forge is someone else
    expect(trustLevel(forge('alice-gh', 'gitea'), policy, members, forgeUsers)).toBe('external');
  });
});

describe('automationFor', () => {
  it('runs trusted work fully automatic, deploy included', () => {
    expect(automationFor(user('owner'), policy, members)).toEqual({
      level: 'trusted', dispatch: 'auto', merge: 'auto', deploy: true,
    });
  });
  it('follows the level knobs for untrusted work and never deploys it', () => {
    expect(automationFor(user('alice'), policy, members)).toEqual({
      level: 'known', dispatch: 'auto', merge: 'pr-only', deploy: false,
    });
    const allAuto: TrustPolicy = { ...policy, levels: { ...policy.levels, external: { dispatch: 'auto', merge: 'auto' } } };
    expect(automationFor(forge('random'), allAuto, members)).toEqual({
      level: 'external', dispatch: 'auto', merge: 'auto', deploy: false,
    });
  });
});

describe('approvalAtCreation', () => {
  const at = '2026-10-28T12:00:00.000Z';
  it('approves trusted work by policy, merge auto', () => {
    expect(approvalAtCreation(automationFor(user('owner'), policy, members), at)).toEqual({
      state: 'approved', merge: 'auto', by: null, at,
    });
  });
  it('approves a level on dispatch=auto by policy, but keeps pr-only', () => {
    expect(approvalAtCreation(automationFor(user('alice'), policy, members), at)).toEqual({
      state: 'approved', merge: 'pr-only', by: null, at,
    });
  });
  it('proposes a level on dispatch=approval, and an unknown reporter', () => {
    expect(approvalAtCreation(automationFor(user('stranger'), policy, members), at).state).toBe('proposed');
    expect(approvalAtCreation(automationFor({ reportedBy: null }, policy, members), at).state).toBe('proposed');
  });
});

describe('defaultTrustPolicy', () => {
  it('trusts the creator and the binding login; both untrusted levels are safe', () => {
    expect(defaultTrustPolicy('c', ['bot'])).toEqual({
      trustedUserIds: ['c'],
      trustedForgeLogins: ['bot'],
      levels: { known: { dispatch: 'approval', merge: 'pr-only' }, external: { dispatch: 'approval', merge: 'pr-only' } },
    });
  });
});

describe('parseTrustPolicy', () => {
  it('normalizes the lists', () => {
    const parsed = parseTrustPolicy({ ...policy, trustedForgeLogins: [' a ', 'a', ''] });
    expect(parsed).toEqual({ ...policy, trustedForgeLogins: ['a'] });
  });
  it('rejects bad shapes with a message', () => {
    expect(parseTrustPolicy(null)).toMatch(/object/);
    expect(parseTrustPolicy({ ...policy, trustedUserIds: [1] })).toMatch(/trustedUserIds/);
    expect(parseTrustPolicy({ ...policy, levels: { known: policy.levels.known } })).toMatch(/external/);
    expect(
      parseTrustPolicy({ ...policy, levels: { ...policy.levels, known: { dispatch: 'auto', merge: 'deploy' } } }),
    ).toMatch(/merge/);
  });
});
