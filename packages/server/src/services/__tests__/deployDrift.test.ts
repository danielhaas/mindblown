import { beforeEach, describe, expect, it, vi } from 'vitest';

const s = vi.hoisted(() => ({ stored: null as unknown, bound: ['mb-map'] as string[] }));

vi.mock('../../db/settings.js', () => ({
  getSystemSetting: async () => s.stored,
  setSystemSetting: async (_k: string, v: unknown) => void (s.stored = v),
}));
vi.mock('../../db/maps.js', () => ({ listMapIdsBoundToRepo: async () => s.bound }));

import {
  checkDeployDrift,
  deployDriftForMap,
  driftAlertDue,
  driftPushMessage,
  driftSummary,
  parseLog,
  runDeployDriftCheck,
  setLatestDeployDrift,
  type DeployDrift,
  type DriftGit,
  type UndeployedCommit,
} from '../deployDrift.js';

const HEAD = 'a'.repeat(40);
const NOW = new Date('2026-11-19T12:00:00Z');
const CFG = { afterMs: 2 * 3_600_000, repeatMs: 24 * 3_600_000 };
const commit = (n: number, hoursAgo: number): UndeployedCommit => ({
  sha: String(n).repeat(40).slice(0, 40),
  at: new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString(),
  subject: `feat: change ${n} (#${600 + n})`,
});
const git = (undeployed: UndeployedCommit[]): DriftGit & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    head: async () => HEAD,
    origin: async () => 'git@github.com:danielhaas/mindblown.git',
    undeployed: async (h) => (calls.push(h), undeployed),
  };
};
const drift = (undeployed: UndeployedCommit[]): DeployDrift => ({ sha: HEAD, repo: 'danielhaas/mindblown', undeployed, checkedAt: NOW.toISOString() });

beforeEach(() => {
  s.stored = null;
  s.bound = ['mb-map'];
  setLatestDeployDrift(null);
});

describe('parseLog', () => {
  it('reads sha, committer date and subject (tabs in the subject survive)', () => {
    expect(parseLog(`${'b'.repeat(40)}\t2026-11-18T08:42:05Z\tfeat: x\tand tab\n\n`)).toEqual([
      { sha: 'b'.repeat(40), at: '2026-11-18T08:42:05Z', subject: 'feat: x\tand tab' },
    ]);
    expect(parseLog('')).toEqual([]);
  });
});

describe('driftAlertDue', () => {
  it('nothing waiting, or waiting under the threshold: no push', () => {
    expect(driftAlertDue(drift([]), null, NOW, CFG)).toBe(false);
    expect(driftAlertDue(drift([commit(1, 1.9)]), null, NOW, CFG)).toBe(false);
  });

  it('past the threshold: push once per oldest commit, again after a day', () => {
    const d = drift([commit(1, 19), commit(2, 1)]);
    expect(driftAlertDue(d, null, NOW, CFG)).toBe(true);
    const pushedAt = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
    expect(driftAlertDue(d, { sha: d.undeployed[0].sha, at: pushedAt(3) }, NOW, CFG)).toBe(false);
    expect(driftAlertDue(d, { sha: d.undeployed[0].sha, at: pushedAt(24) }, NOW, CFG)).toBe(true);
    // A deploy happened and a new commit has waited long enough: a new episode.
    expect(driftAlertDue(d, { sha: 'old', at: pushedAt(1) }, NOW, CFG)).toBe(true);
  });
});

describe('driftPushMessage', () => {
  it('counts, ages the oldest, lists five subjects', () => {
    const d = drift([commit(1, 19), commit(2, 18), commit(3, 2), commit(4, 2), commit(5, 1), commit(6, 1), commit(7, 1)]);
    const m = driftPushMessage(d, NOW);
    expect(m.title).toBe('MindBlown: 7 merged changes not deployed');
    expect(m.message).toContain('Oldest waiting 19 h. Prod runs aaaaaaaa.');
    expect(m.message).toContain('• feat: change 1 (#601)');
    expect(m.message).toContain('… and 2 more');
    expect(m.message).not.toContain('change 6');
  });
});

describe('runDeployDriftCheck', () => {
  it('compares against the running commit, pushes when due and remembers it', async () => {
    const g = git([commit(1, 19)]);
    const push = vi.fn(async () => true);
    const r = await runDeployDriftCheck(g, NOW, CFG, push);
    expect(g.calls).toEqual([HEAD]);
    expect(r.pushed).toBe(true);
    expect(push).toHaveBeenCalledTimes(1);
    expect(s.stored).toEqual({ sha: commit(1, 19).sha, at: NOW.toISOString() });
    // The next tick, same drift: no second push.
    expect((await runDeployDriftCheck(g, NOW, CFG, push)).pushed).toBe(false);
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('a failed push is not remembered, so the next tick tries again', async () => {
    const push = vi.fn(async () => false);
    await runDeployDriftCheck(git([commit(1, 19)]), NOW, CFG, push);
    expect(s.stored).toBeNull();
  });

  it('feeds the health summary without commit subjects', async () => {
    await checkDeployDrift(git([commit(1, 19), commit(2, 1)]), NOW);
    const { latestDeployDrift } = await import('../deployDrift.js');
    expect(driftSummary(latestDeployDrift())).toEqual({
      sha: HEAD, undeployed: 2, undeployedSince: commit(1, 19).at, checkedAt: NOW.toISOString(),
    });
    expect(driftSummary(null)).toBeNull();
  });
});

describe('deployDriftForMap', () => {
  it('only a map bound to the running repo gets the drift (with commits); others and before a check get null', async () => {
    expect(await deployDriftForMap('mb-map')).toBeNull();
    await checkDeployDrift(git([commit(1, 19)]), NOW);
    expect(await deployDriftForMap('mb-map')).toMatchObject({ undeployed: 1, commits: [commit(1, 19)] });
    expect(await deployDriftForMap('other-map')).toBeNull();
  });

  it('a checkout without a GitHub origin has no map to show it on', async () => {
    await checkDeployDrift({ ...git([commit(1, 19)]), origin: async () => '/srv/mirror.git' }, NOW);
    expect(await deployDriftForMap('mb-map')).toBeNull();
  });
});
