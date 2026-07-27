import { describe, it, expect } from 'vitest';
import {
  collectRequirementGhLinks,
  requirementStage,
  stageCounts,
  STAGE_LABEL,
  STAGE_COLOR,
  STAGE_ORDER,
} from '../requirements.js';

describe('requirementStage', () => {
  const it_ = { gate: 'it' as const, decision: 'accepted' as const };
  const biz = { gate: 'business' as const, decision: 'accepted' as const };

  it('derives the progress-only stages when nobody has signed', () => {
    expect(requirementStage(0)).toBe('open');
    expect(requirementStage(0.1)).toBe('in_progress');
    expect(requirementStage(99.4)).toBe('in_progress');
    // 99.5 is the register's rounding boundary — 99.5 displays as 100 %.
    expect(requirementStage(99.5)).toBe('built');
    expect(requirementStage(100)).toBe('built');
  });

  it('never calls a finished rollup "accepted" on its own', () => {
    expect(requirementStage(100, [])).toBe('built');
  });

  it('reports the furthest gate reached', () => {
    expect(requirementStage(100, [it_])).toBe('it_verified');
    expect(requirementStage(100, [biz])).toBe('accepted');
    expect(requirementStage(100, [it_, biz])).toBe('accepted');
  });

  it('treats a gate-less row as the business sign-off it used to be', () => {
    // Every pre-split acceptance was a business verdict; the DEFAULT
    // backfills them, and this keeps in-flight payloads consistent.
    expect(requirementStage(100, [{ decision: 'accepted' }])).toBe('accepted');
  });

  it('lets business acceptance stand without an IT verdict', () => {
    // The gates are independent flags, not a pipeline — the backfill
    // produces exactly this shape for all 163 existing rows.
    expect(requirementStage(100, [biz])).toBe('accepted');
  });

  it('lets a rejection outrank everything, at any progress', () => {
    const no = { gate: 'business' as const, decision: 'rejected' as const };
    expect(requirementStage(100, [no])).toBe('rejected');
    expect(requirementStage(100, [it_, biz, no])).toBe('rejected');
    expect(requirementStage(0, [no])).toBe('rejected');
    // An IT rejection counts too, even with the business ✓ standing.
    expect(
      requirementStage(100, [{ gate: 'it', decision: 'rejected' }, biz]),
    ).toBe('rejected');
  });

  it('can sign off on work that is not finished', () => {
    // "Good enough, we'll take it" is a real outcome; the UI confirms it
    // rather than blocking it.
    expect(requirementStage(40, [biz])).toBe('accepted');
  });
});

describe('stage presentation', () => {
  it('reserves green for the two signed-off stages', () => {
    // The whole point of renaming "Done" to "Gebaut": if built stayed
    // green, a skimming reader would still read it as finished.
    expect(STAGE_COLOR.built.bg).not.toBe(STAGE_COLOR.accepted.bg);
    expect(STAGE_LABEL.built).toBe('Gebaut');
    expect(STAGE_LABEL.accepted).toBe('Abgenommen');
  });

  it('orders the funnel from most to least complete', () => {
    expect(STAGE_ORDER[0]).toBe('accepted');
    expect(STAGE_ORDER).toHaveLength(6);
  });

  it('counts every stage, including the empty ones', () => {
    expect(stageCounts(['built', 'built', 'open'])).toEqual({
      open: 1,
      in_progress: 0,
      built: 2,
      it_verified: 0,
      accepted: 0,
      rejected: 0,
    });
  });
});

type N = {
  id: string;
  childrenIds?: string[];
  externalLinks?: Array<{
    provider: string;
    externalId: string;
    url: string;
    state?: 'open' | 'closed';
    isPullRequest?: boolean;
  }>;
};

const gh = (n: number, state?: 'open' | 'closed') => ({
  provider: 'github',
  externalId: `FulcrumCRM/crm#${n}`,
  url: `https://github.com/FulcrumCRM/crm/issues/${n}`,
  ...(state ? { state } : {}),
});

function lookup(nodes: N[]) {
  const map = new Map(nodes.map((n) => [n.id, n]));
  return (id: string) => map.get(id);
}

describe('collectRequirementGhLinks', () => {
  it('returns own links, not inherited', () => {
    const get = lookup([{ id: 'r', externalLinks: [gh(1)] }]);
    expect(collectRequirementGhLinks(get, 'r')).toEqual([
      { externalId: 'FulcrumCRM/crm#1', url: expect.any(String), inherited: false },
    ]);
  });

  it('rolls up links from the work below — the 54-requirement case', () => {
    const get = lookup([
      { id: 'r', childrenIds: ['w1', 'w2'] },
      { id: 'w1', externalLinks: [gh(1)] },
      { id: 'w2', externalLinks: [gh(2)] },
    ]);
    const got = collectRequirementGhLinks(get, 'r');
    expect(got.map((l) => l.externalId)).toEqual(['FulcrumCRM/crm#1', 'FulcrumCRM/crm#2']);
    expect(got.every((l) => l.inherited)).toBe(true);
  });

  it('reaches links at any depth', () => {
    const get = lookup([
      { id: 'r', childrenIds: ['a'] },
      { id: 'a', childrenIds: ['b'] },
      { id: 'b', childrenIds: ['c'] },
      { id: 'c', externalLinks: [gh(9)] },
    ]);
    expect(collectRequirementGhLinks(get, 'r')).toEqual([
      { externalId: 'FulcrumCRM/crm#9', url: expect.any(String), inherited: true },
    ]);
  });

  it('own link wins over the same issue linked on a child', () => {
    const get = lookup([
      { id: 'r', childrenIds: ['w'], externalLinks: [gh(5)] },
      { id: 'w', externalLinks: [gh(5)] },
    ]);
    const got = collectRequirementGhLinks(get, 'r');
    expect(got).toHaveLength(1);
    expect(got[0].inherited).toBe(false);
  });

  it('dedupes the same issue linked on two children', () => {
    const get = lookup([
      { id: 'r', childrenIds: ['w1', 'w2'] },
      { id: 'w1', externalLinks: [gh(7)] },
      { id: 'w2', externalLinks: [gh(7)] },
    ]);
    expect(collectRequirementGhLinks(get, 'r')).toHaveLength(1);
  });

  it('ignores non-github providers', () => {
    const get = lookup([
      { id: 'r', childrenIds: ['w'] },
      { id: 'w', externalLinks: [{ provider: 'jira', externalId: 'X-1', url: 'https://x' }] },
    ]);
    expect(collectRequirementGhLinks(get, 'r')).toEqual([]);
  });

  it('returns empty for a bare requirement — the 36-requirement case', () => {
    expect(collectRequirementGhLinks(lookup([{ id: 'r' }]), 'r')).toEqual([]);
  });

  it('survives a cyclic tree instead of hanging', () => {
    const get = lookup([
      { id: 'r', childrenIds: ['a'] },
      { id: 'a', childrenIds: ['r'], externalLinks: [gh(3)] },
    ]);
    expect(collectRequirementGhLinks(get, 'r')).toHaveLength(1);
  });

  it('tolerates a missing node id', () => {
    expect(collectRequirementGhLinks(lookup([]), 'nope')).toEqual([]);
  });

  it('carries the closed state through', () => {
    const get = lookup([{ id: 'r', externalLinks: [gh(1, 'closed')] }]);
    expect(collectRequirementGhLinks(get, 'r')).toEqual([
      { externalId: 'FulcrumCRM/crm#1', url: expect.any(String), inherited: false, state: 'closed' },
    ]);
  });

  it('carries the pull-request flag through, own and inherited', () => {
    // GitHub shares a number space between issues and PRs, so a link can
    // point at either; the column must not call a PR an issue.
    const get = lookup([
      {
        id: 'r',
        childrenIds: ['w'],
        externalLinks: [{ ...gh(856, 'closed'), isPullRequest: true }],
      },
      { id: 'w', externalLinks: [{ ...gh(857, 'open'), isPullRequest: true }] },
    ]);
    const got = collectRequirementGhLinks(get, 'r');
    expect(got.map((l) => [l.externalId, l.inherited, l.isPullRequest])).toEqual([
      ['FulcrumCRM/crm#856', false, true],
      ['FulcrumCRM/crm#857', true, true],
    ]);
  });

  it('leaves isPullRequest undefined for links that were never resolved', () => {
    const get = lookup([{ id: 'r', externalLinks: [gh(1, 'closed')] }]);
    expect(collectRequirementGhLinks(get, 'r')[0].isPullRequest).toBeUndefined();
  });

  it('leaves state undefined for links written before the field existed', () => {
    const get = lookup([{ id: 'r', externalLinks: [gh(1)] }]);
    expect(collectRequirementGhLinks(get, 'r')[0].state).toBeUndefined();
  });

  it('own link wins with its own state even if a child has a different one', () => {
    const get = lookup([
      { id: 'r', childrenIds: ['w'], externalLinks: [gh(5, 'open')] },
      { id: 'w', externalLinks: [gh(5, 'closed')] },
    ]);
    const got = collectRequirementGhLinks(get, 'r');
    expect(got).toHaveLength(1);
    expect(got[0].state).toBe('open');
  });
});
