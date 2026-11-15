import { beforeEach, describe, expect, it, vi } from 'vitest';

const s = vi.hoisted(() => ({
  stored: null as unknown,
  maps: ['map-a'] as string[],
  boundTo: null as null | [string, string],
  deployed: [] as Array<{ mapId: string; contains?: (sha: string) => Promise<boolean> }>,
  failed: [] as Array<{ nodeId: string; issue: string; error: string }>,
}));

vi.mock('../../db/settings.js', () => ({
  getSystemSetting: async () => s.stored,
  setSystemSetting: async (_k: string, v: unknown) => void (s.stored = v),
}));
vi.mock('../../db/maps.js', () => ({
  listMapIdsBoundToRepo: async (owner: string, repo: string) => ((s.boundTo = [owner, repo]), s.maps),
}));
vi.mock('../reporterCheck.js', () => ({
  markDeployed: async (mapId: string, _now: Date, opts: { contains?: (sha: string) => Promise<boolean> }) => {
    s.deployed.push({ mapId, contains: opts.contains });
    return { asked: [{ nodeId: 'n1', issue: 'danielhaas/mindblown#9' }], notLanded: [], failed: s.failed };
  },
}));

import { parseGitHubRemote, pinnedGit, signalSelfDeploy, type Git } from '../selfDeploy.js';

const HEAD = 'f'.repeat(40);
function git(over: Partial<Git> = {}): Git & { asked: Array<[string, string]> } {
  const asked: Array<[string, string]> = [];
  return {
    asked,
    head: async () => HEAD,
    origin: async () => 'git@github.com:danielhaas/mindblown.git',
    contains: async (sha, head) => (asked.push([sha, head]), true),
    ...over,
  };
}

beforeEach(() => {
  s.stored = null;
  s.maps = ['map-a'];
  s.boundTo = null;
  s.deployed = [];
  s.failed = [];
});

describe('parseGitHubRemote', () => {
  it('reads ssh and https remotes, nothing else', () => {
    expect(parseGitHubRemote('git@github.com:danielhaas/mindblown.git')).toEqual({ owner: 'danielhaas', repo: 'mindblown' });
    expect(parseGitHubRemote('https://github.com/danielhaas/mindblown')).toEqual({ owner: 'danielhaas', repo: 'mindblown' });
    expect(parseGitHubRemote('https://x-access-token:t@github.com/o/r.git\n')).toEqual({ owner: 'o', repo: 'r' });
    expect(parseGitHubRemote('ssh://git@github.com/o/r.git')).toEqual({ owner: 'o', repo: 'r' });
    expect(parseGitHubRemote('git@gitea.example:o/r.git')).toBeNull();
  });
});

describe('signalSelfDeploy', () => {
  it('a start on a new commit signals the maps bound to its own repo and remembers the commit', async () => {
    const g = git();
    const r = await signalSelfDeploy(g);
    expect(s.boundTo).toEqual(['danielhaas', 'mindblown']);
    expect(r).toMatchObject({ sha: HEAD, repo: 'danielhaas/mindblown', maps: [{ mapId: 'map-a' }] });
    expect(s.stored).toBe(HEAD);
    // The merge check runs against the deployed commit.
    await s.deployed[0].contains!('abc1234');
    expect(g.asked).toEqual([['abc1234', HEAD]]);
  });

  it('a plain restart on the same commit signals nothing', async () => {
    s.stored = HEAD;
    expect(await signalSelfDeploy(git())).toBeNull();
    expect(s.deployed).toEqual([]);
  });

  it('no git checkout, no signal, nothing stored', async () => {
    const g = git({ head: async () => { throw new Error('not a git repository'); } });
    expect(await signalSelfDeploy(g)).toBeNull();
    expect(s.stored).toBeNull();
  });

  it('a non-GitHub origin remembers the commit but signals no map', async () => {
    const r = await signalSelfDeploy(git({ origin: async () => '/srv/mirror.git' }));
    expect(r?.maps).toEqual([]);
    expect(s.boundTo).toBeNull();
    expect(s.stored).toBe(HEAD);
  });
});

describe('signalSelfDeploy retries', () => {
  it('a failed ask leaves the commit unstored, so the next try asks again', async () => {
    s.failed = [{ nodeId: 'n2', issue: 'danielhaas/mindblown#10', error: 'reopen failed: 502' }];
    await signalSelfDeploy(git());
    expect(s.stored).toBeNull();
    s.failed = [];
    await signalSelfDeploy(git());
    expect(s.deployed).toHaveLength(2);
    expect(s.stored).toBe(HEAD);
  });
});

describe('pinnedGit (the real git, in this checkout)', () => {
  it('HEAD contains itself; an unknown commit is not contained, not an error', async () => {
    const g = pinnedGit();
    const head = await g.head();
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    expect(await g.contains(head, head)).toBe(true);
    expect(await g.contains('0123456789abcdef0123456789abcdef01234567', head)).toBe(false);
    expect(await g.contains('not-a-sha', head)).toBe(false);
  });
});
