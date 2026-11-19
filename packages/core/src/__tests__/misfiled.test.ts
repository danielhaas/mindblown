import { describe, it, expect } from 'vitest';
import { findMisfiledRepo, misfiledHint, namedRepos, parseRepoRef, MISFILED_TAG, type MapRepoCandidate } from '../misfiled.js';
import { dispatchHold, DISPATCH_SKIP_TAGS } from '../dispatch.js';

const MINDBLOWN = { owner: 'danielhaas', name: 'mindblown' };
const maps: MapRepoCandidate[] = [
  { id: 'cf', name: 'claude-fleet', repo: { owner: 'danielhaas', name: 'claude-fleet' } },
  { id: 'mb2', name: 'MindBlown (old)', repo: { owner: 'danielhaas', name: 'mindblown' } },
  { id: 'loose', name: 'Ideas', repo: null },
];
const doc = (...paras: string[]) => ({
  type: 'doc',
  content: paras.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
});
const check = (text: string, description?: unknown, own: typeof MINDBLOWN | null = MINDBLOWN) =>
  findMisfiledRepo({ text, description }, own, maps);

describe('wrong-map guard: detection', () => {
  // The 19.11.2026 case.
  it('the 19.11 ticket: component (repo) title and a **Repo:** forge URL', () => {
    expect(check('fleet-worker (claude-fleet): keep the worktree on a crash', '**Why:** x\n**Repo:** github.com/danielhaas/claude-fleet')).toEqual({
      repo: 'danielhaas/claude-fleet',
      suggestedMapId: 'cf',
      suggestedMapName: 'claude-fleet',
    });
  });

  it.each([
    ['Repo: line with owner/repo', 'Some ticket', 'Repo: danielhaas/claude-fleet'],
    ['Repo: line with a URL', 'Some ticket', 'Repo: https://github.com/danielhaas/claude-fleet/issues/98'],
    ['Repo: line with a bare name', 'Some ticket', '- **Repo:** `claude-fleet`'],
    ['Repository: line with a markdown link', 'Some ticket', 'Repository: [the fleet](https://github.com/danielhaas/claude-fleet)'],
    ['title <repo>: …', 'claude-fleet: retry the clone', undefined],
    ['title <repo> (…)', 'claude-fleet (worker) retry the clone', undefined],
    ['title (<repo>) …', '(claude-fleet) retry the clone', undefined],
    ['title <component> (<repo>): …', 'worker loop (claude-fleet): retry the clone', undefined],
    ['title owner/repo: …', 'danielhaas/claude-fleet: retry', undefined],
  ])('strong signal hits: %s', (_label, text, description) => {
    expect(check(text, description)?.suggestedMapId).toBe('cf');
  });

  it('a Repo: line inside a ProseMirror description, also after a hard break', () => {
    expect(check('Some ticket', doc('Why: because', 'Repo: danielhaas/claude-fleet'))?.suggestedMapId).toBe('cf');
    const hardBreak = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Why: x' }, { type: 'hardBreak' }, { type: 'text', text: 'Repo: claude-fleet' }] }],
    };
    expect(check('Some ticket', hardBreak)?.suggestedMapId).toBe('cf');
  });

  it.each([
    ['running text in the description', 'Fix the panel', 'Works like claude-fleet #98 does; worker half of mindblown#546.'],
    ['a repo mid-title', 'Port the claude-fleet retry to the panel', undefined],
    ['a conventional-commit title', 'feat(claude-fleet): x', undefined],
    ['a link in running text', 'Fix the panel', 'See https://github.com/danielhaas/claude-fleet/pull/12 for the worker half.'],
  ])('running-text mentions do not count: %s', (_label, text, description) => {
    expect(check(text, description)).toBeNull();
  });

  it("naming the map's own repo is not misfiled, even when another repo is named too", () => {
    expect(check('mindblown: x')).toBeNull();
    expect(check('claude-fleet: x', 'Repo: danielhaas/mindblown')).toBeNull();
  });

  it('a map bound to the same repo is no suggestion', () => {
    const own = { owner: 'danielhaas', name: 'claude-fleet' };
    expect(findMisfiledRepo({ text: 'mindblown: x' }, own, maps)).toEqual({ repo: 'danielhaas/mindblown', suggestedMapId: 'mb2', suggestedMapName: 'MindBlown (old)' });
    expect(findMisfiledRepo({ text: 'Some ticket', description: 'Repo: danielhaas/claude-fleet' }, own, [maps[0]])).toBeNull();
  });

  it('unbound maps never match, and an unbound own map flags nothing', () => {
    expect(check('Ideas: x')).toBeNull();
    expect(check('claude-fleet: x', undefined, null)).toBeNull();
  });

  it('a repo nobody plans, or another owner, is no finding', () => {
    expect(check('other-repo: x')).toBeNull();
    expect(check('Some ticket', 'Repo: someoneelse/claude-fleet')).toBeNull();
  });

  it('parseRepoRef reads URLs, owner/repo, .git and bare names', () => {
    expect(parseRepoRef('https://gitea.example.com/team/app.git')).toEqual({ owner: 'team', name: 'app' });
    expect(parseRepoRef('`danielhaas/claude-fleet`.')).toEqual({ owner: 'danielhaas', name: 'claude-fleet' });
    expect(parseRepoRef('claude-fleet')).toEqual({ owner: null, name: 'claude-fleet' });
    expect(parseRepoRef('  ')).toBeNull();
    expect(namedRepos({ text: 'plain title' })).toEqual([]);
  });

  it('the hint names the repo, the map and the tool', () => {
    expect(misfiledHint({ repo: 'danielhaas/claude-fleet', suggestedMapId: 'cf', suggestedMapName: 'claude-fleet' })).toMatch(
      /^This names danielhaas\/claude-fleet, which map claude-fleet plans — move it with move_node_to_map/,
    );
  });

  it('the misfiled? tag holds the ticket from the fleet', () => {
    expect(DISPATCH_SKIP_TAGS).toContain(MISFILED_TAG);
    const approval = { state: 'approved' as const, merge: 'auto' as const, by: 'u', at: '2026-11-19T00:00:00Z' };
    expect(dispatchHold({ tags: [MISFILED_TAG], blockedReason: null, approval })).toMatchObject({ tag: MISFILED_TAG });
    expect(dispatchHold({ tags: [], blockedReason: null, approval })).toBeNull();
  });
});
