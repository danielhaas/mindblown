import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db/connection.js', () => ({ db: {} }));
vi.mock('../../db/settings.js', () => ({ getSystemSetting: async () => null, setSystemSetting: async () => {} }));
vi.mock('../../db/maps.js', () => ({ listMapIdsBoundToRepo: async () => [] }));
vi.mock('../../lib/githubContext.js', () => ({ getGitHubContextForMap: async () => null }));

import type { ForgeMapContext } from '../../lib/githubContext.js';
import {
  checkProbeMap,
  deployDriftView,
  latestProbeResult,
  overThreshold,
  probeDrifts,
  readProbe,
  runProbeChecks,
  setLatestProbeResult,
  undeployedOnDefaultBranch,
  type ProbeDeps,
  type ProbeMap,
} from '../deployProbe.js';
import type { UndeployedCommit } from '../deployDrift.js';

const SHA = 'abcdef1234567890abcdef1234567890abcdef12';
const NOW = new Date('2026-11-19T12:00:00Z');
const CFG = { afterMs: 2 * 3_600_000, repeatMs: 24 * 3_600_000 };
const NAVY: ProbeMap = { id: 'navy', name: 'Navy', deployProbe: 'https://navy.example/api/version' };
const ago = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const commit = (n: number, h: number): UndeployedCommit => ({ sha: String(n).repeat(40), at: ago(h), subject: `feat: ${n}` });
const ctx = { owner: 'danielhaas', repo: 'navy' } as ForgeMapContext;

const fetchWith = (impl: () => Promise<Response>) => vi.fn(impl) as unknown as typeof fetch;

describe('readProbe', () => {
  it('JSON and plain bodies give the sha', async () => {
    expect(await readProbe('u', fetchWith(async () => new Response(JSON.stringify({ commit: SHA }))))).toBe(SHA);
    expect(await readProbe('u', fetchWith(async () => new Response(`${SHA}\n`)))).toBe(SHA);
  });

  it('404, a body without a commit, an unreachable host, a timeout: a ProbeError that says which', async () => {
    await expect(readProbe('u', fetchWith(async () => new Response('nope', { status: 404 })))).rejects.toThrow('HTTP 404');
    await expect(readProbe('u', fetchWith(async () => new Response('<html></html>')))).rejects.toThrow('without a commit');
    await expect(readProbe('u', fetchWith(async () => Promise.reject(new TypeError('fetch failed'))))).rejects.toThrow('unreachable');
    const hang = vi.fn(
      (_u: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))),
    ) as unknown as typeof fetch;
    await expect(readProbe('u', hang, 20)).rejects.toThrow('timed out');
  });
});

describe('undeployedOnDefaultBranch', () => {
  it('compares the deployed sha with the default branch, oldest first', async () => {
    const requestJson = vi.fn(async () => ({
      commits: [
        { sha: 'b', commit: { message: 'fix: later\n\nbody', committer: { date: ago(1) } } },
        { sha: 'a', commit: { message: 'feat: first', committer: { date: ago(19) } } },
      ],
    }));
    const forge = { getRepoMergeSettings: async () => ({ defaultBranch: 'main' }), requestJson };
    const out = await undeployedOnDefaultBranch({ ...ctx, forge } as unknown as ForgeMapContext, SHA);
    expect(requestJson).toHaveBeenCalledWith(`/repos/danielhaas/navy/compare/${SHA}...main`);
    expect(out.branch).toBe('main');
    expect(out.commits.map((c) => [c.sha, c.subject])).toEqual([
      ['a', 'feat: first'],
      ['b', 'fix: later'],
    ]);
  });
});

function deps(over: Partial<ProbeDeps> & { commits?: UndeployedCommit[] } = {}): ProbeDeps & { stored: Map<string, unknown>; pushes: string[] } {
  const stored = new Map<string, unknown>();
  const pushes: string[] = [];
  return {
    stored,
    pushes,
    readProbe: async () => SHA,
    context: async () => ctx,
    compare: async () => ({ branch: 'main', commits: over.commits ?? [] }),
    push: async (m) => (pushes.push(m.title), true),
    getSetting: async (k) => stored.get(k) ?? null,
    setSetting: async (k, v) => void stored.set(k, v),
    ...over,
  };
}

beforeEach(() => {
  for (const id of ['navy', 'placet', 'mb']) setLatestProbeResult(id, undefined);
});

describe('checkProbeMap', () => {
  it('drift against the default branch; past the threshold one push, not again the same day', async () => {
    const d = deps({ commits: [commit(1, 19), commit(2, 1)] });
    const first = await checkProbeMap(NAVY, NOW, CFG, d);
    expect(first.pushed).toBe(true);
    expect(d.pushes).toEqual(['Navy: 2 merged changes not live']);
    expect(first.result.drift?.sha).toBe(SHA);
    expect(first.result.drift?.repo).toBe('danielhaas/navy');
    expect(latestProbeResult('navy')?.drift?.undeployed).toHaveLength(2);

    const later = new Date(NOW.getTime() + 3 * 3_600_000);
    expect((await checkProbeMap(NAVY, later, CFG, d)).pushed).toBe(false);
    const nextDay = new Date(NOW.getTime() + 24 * 3_600_000);
    expect((await checkProbeMap(NAVY, nextDay, CFG, d)).pushed).toBe(true);
  });

  it('under the threshold, or nothing waiting: no push', async () => {
    const d = deps({ commits: [commit(1, 1)] });
    expect((await checkProbeMap(NAVY, NOW, CFG, d)).pushed).toBe(false);
    expect((await checkProbeMap(NAVY, NOW, CFG, deps())).pushed).toBe(false);
  });

  it('a failed push is not remembered — tried again next tick', async () => {
    const d = deps({ commits: [commit(1, 19)], push: async () => false });
    expect((await checkProbeMap(NAVY, NOW, CFG, d)).pushed).toBe(false);
    expect(d.stored.size).toBe(0);
  });

  it('a failing probe or a map without a forge is the error, not stale numbers', async () => {
    setLatestProbeResult('navy', { drift: { sha: SHA, repo: 'x/y', undeployed: [commit(1, 19)], checkedAt: ago(1) } });
    const r = await checkProbeMap(NAVY, NOW, CFG, deps({ readProbe: async () => Promise.reject(new Error('probe answered HTTP 404')) }));
    expect(r.result).toEqual({ error: 'probe answered HTTP 404', checkedAt: NOW.toISOString() });
    expect(latestProbeResult('navy')?.drift).toBeUndefined();
    const noForge = await checkProbeMap(NAVY, NOW, CFG, deps({ context: async () => null }));
    expect(noForge.result.error).toContain('no forge binding');
  });
});

describe('runProbeChecks', () => {
  it('checks every probe map and drops the results of maps whose probe is gone', async () => {
    setLatestProbeResult('placet', { error: 'old', checkedAt: ago(5) });
    const r = await runProbeChecks(NOW, async () => [NAVY], deps({ commits: [commit(1, 19)] }));
    expect(r).toEqual({ checked: 1, failed: [], pushed: 1 });
    expect(latestProbeResult('placet')).toBeUndefined();
    expect(probeDrifts().map((p) => p.mapId)).toEqual(['navy']);
  });
});

describe('overThreshold', () => {
  it('only once the oldest has waited past the alert hours', () => {
    const drift = (h: number) => ({ sha: SHA, repo: null, undeployed: [commit(1, h)], checkedAt: NOW.toISOString() });
    expect(overThreshold(drift(19), NOW, CFG)).toBe(true);
    expect(overThreshold(drift(1), NOW, CFG)).toBe(false);
    expect(overThreshold({ ...drift(1), undeployed: [] }, NOW, CFG)).toBe(false);
  });
});

describe('deployDriftView', () => {
  it("the map's probe first, its error next, else the server's own drift", async () => {
    const self = vi.fn(async () => null);
    setLatestProbeResult('navy', { drift: { sha: SHA, repo: 'x/y', undeployed: [commit(1, 19)], checkedAt: NOW.toISOString() } });
    const v = await deployDriftView('navy', self);
    expect(v.probeError).toBeNull();
    expect(v.drift).toMatchObject({ sha: SHA, undeployed: 1, undeployedSince: ago(19) });
    expect(v.drift?.commits).toHaveLength(1);

    setLatestProbeResult('placet', { error: 'probe timed out after 10 s', checkedAt: NOW.toISOString() });
    expect(await deployDriftView('placet', self)).toEqual({ drift: null, probeError: 'probe timed out after 10 s' });
    expect(self).not.toHaveBeenCalled();

    expect(await deployDriftView('mb', self)).toEqual({ drift: null, probeError: null });
    expect(self).toHaveBeenCalledWith('mb');
  });
});
