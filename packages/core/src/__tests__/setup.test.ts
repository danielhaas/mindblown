import { describe, it, expect } from 'vitest';
import { projectSetup } from '../setup.js';

const bare = {
  description: null,
  rootNodeId: 'root',
  fleetId: null,
  maxActiveClaims: 0,
  forgeKind: null,
  forgeProblem: null,
  githubRepoOwner: null,
  githubRepoName: null,
  setupCompletedAt: null,
};
const root = { parentId: null };

const done = (s: ReturnType<typeof projectSetup>) => Object.fromEntries(s.steps.map((x) => [x.id, x.done]));

describe('projectSetup', () => {
  it('a fresh map lacks a description, repo, plan and fleet; nothing to start yet', () => {
    const s = projectSetup(bare, [root]);
    expect(done(s)).toEqual({ describe: false, repo: false, plan: false, fleet: false, start: true });
    expect(s.next?.id).toBe('describe');
    expect(s.completed).toBe(false);
  });

  it('a description of empty markup does not count', () => {
    expect(done(projectSetup({ ...bare, description: '<p> </p>' }, [root])).describe).toBe(false);
    expect(done(projectSetup({ ...bare, description: '<p>A CRM</p>' }, [root])).describe).toBe(true);
  });

  it('a repo counts only when it is reachable', () => {
    const bound = { ...bare, forgeKind: 'github' as const, githubRepoOwner: 'o', githubRepoName: 'r' };
    const ok = projectSetup(bound, [root]).steps.find((x) => x.id === 'repo')!;
    expect(ok).toMatchObject({ done: true, detail: 'Connected to o/r.' });
    const broken = projectSetup({ ...bound, forgeProblem: { kind: 'refused' as const, repo: 'o/r', message: 'App not installed' } }, [root]);
    expect(broken.steps.find((x) => x.id === 'repo')).toMatchObject({ done: false, detail: expect.stringContaining('App not installed') });
  });

  it('the plan needs something under the root and counts every node in it', () => {
    const s = projectSetup(bare, [root, { parentId: 'root' }, { parentId: 'a' }]);
    expect(s.steps.find((x) => x.id === 'plan')).toMatchObject({ done: true, detail: '2 nodes in the plan.' });
  });

  it('a connected fleet on hold still has to be started', () => {
    const held = projectSetup({ ...bare, fleetId: 'f', fleetName: 'claudia' }, [root]);
    expect(held.steps.find((x) => x.id === 'fleet')).toMatchObject({ done: true, detail: 'Fleet "claudia" connected.' });
    expect(held.steps.find((x) => x.id === 'start')).toMatchObject({ done: false, optional: false });
    const running = projectSetup({ ...bare, fleetId: 'f', maxActiveClaims: 2 }, [root]);
    expect(running.steps.find((x) => x.id === 'start')).toMatchObject({ done: true, detail: 'Running: up to 2 tickets at a time.' });
  });

  it('completed follows setupCompletedAt; next is null once every step is done', () => {
    const all = projectSetup(
      { ...bare, description: 'x', forgeKind: 'gitea', fleetId: 'f', maxActiveClaims: 1, setupCompletedAt: '2026-10-23T10:00:00Z' },
      [root, { parentId: 'root' }],
    );
    expect(all.completed).toBe(true);
    expect(all.next).toBeNull();
  });
});
