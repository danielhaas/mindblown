import { describe, expect, it, vi } from 'vitest';
import { mergeRefusal } from '@mindblown/core';
import type { MergePrResult, MergeRefusalCode, PrCheck, PrSummary } from '@mindblown/core';
import { mergePrTool, prSummaryTool, prsWaitingTool, renderMergeResult, renderPrSummary, renderPrsWaiting } from '../prMerge.js';
import type { ToolBackend } from '../../backend.js';

const SHA = 'abc1234def5678abc1234def5678abc1234def56';

const summary = (over: Partial<PrSummary> = {}): PrSummary => ({
  mapId: 'm1',
  nodeId: 'n1',
  ticket: 'Merges by voice',
  forge: 'gitea',
  repo: 'dan/avatar',
  number: 12,
  url: 'https://git.example/dan/avatar/pulls/12',
  title: 'feat: voice merge',
  author: 'fleet-bot',
  worker: 'claudia:slot2:fleet-worker',
  base: 'main',
  head: 'fleet/n1-voice',
  headSha: SHA,
  state: 'open',
  draft: false,
  mergeable: true,
  ci: 'success',
  checks: [{ name: 'test', state: 'success', url: null }],
  reviews: [{ author: 'ray', state: 'APPROVED', body: 'LGTM\nship it', submittedAt: '2026-11-18T08:00:00Z' }],
  waits: 'Needs a human merge',
  files: Array.from({ length: 20 }, (_, i) => ({ path: `src/f${i}.ts`, additions: 20 - i, deletions: 1 })),
  filesTotal: 23,
  additions: 400,
  deletions: 30,
  readAt: '2026-11-18T09:00:00Z',
  ...over,
});

describe('pr_summary', () => {
  it('names repo, head sha, CI, reviews, why it waits, top files and the rest', () => {
    const out = renderPrSummary(summary());
    expect(out).toContain('PR #12 · dan/avatar — feat: voice merge');
    expect(out).toContain(`main ← fleet/n1-voice @ ${SHA}`);
    expect(out).toContain('Worker: claudia:slot2:fleet-worker');
    expect(out).toContain('Waits: Needs a human merge');
    expect(out).toContain('CI: green (1 check)');
    expect(out).toContain('APPROVED by ray — LGTM ship it');
    expect(out).toContain('Files: 23 changed, +400 −30');
    expect(out).toContain('  +20 −1  src/f0.ts');
    expect(out).toContain('… 3 more');
    expect(out).toContain(`merge_pr mapId=m1 nodeId=n1 expectedHeadSha=${SHA}`);
  });

  it('shows failing checks with their link, conflicts, and no merge hint once merged', () => {
    const out = renderPrSummary(summary({ ci: 'failure', mergeable: false, checks: [{ name: 'lint', state: 'failure', url: 'https://ci/1' }] }));
    expect(out).toContain('HAS CONFLICTS');
    expect(out).toContain('✗ lint — https://ci/1');
    expect(renderPrSummary(summary({ state: 'merged' }))).not.toContain('merge_pr');
  });

  it('reads through the backend', async () => {
    const backend = { prSummary: vi.fn(async () => summary()) } as unknown as ToolBackend;
    await prSummaryTool.handler(backend, { mapId: 'm1', nodeId: 'n1' } as never);
    expect(backend.prSummary).toHaveBeenCalledWith('m1', 'n1');
  });
});

describe('merge_pr — description', () => {
  it("says it runs only on a person's explicit decision", () => {
    expect(mergePrTool.description).toContain("only on a person's explicit decision");
  });
});

// Every refusal the server can return, in the shape the rule produces it.
describe('merge_pr — refusals (core mergeRefusal)', () => {
  const pr = { state: 'open' as 'open' | 'closed', merged: false, draft: false, headSha: SHA, mergeable: true as boolean | null, number: 12 };
  const ok: PrCheck[] = [{ name: 'test', state: 'success', url: null }];
  const code = (p: Partial<typeof pr>, checks: PrCheck[] = ok, sha = SHA) => mergeRefusal({ ...pr, ...p }, checks, sha)?.code ?? null;

  it('passes a clean, green, unmoved PR — and one with no CI at all (a person decides that)', () => {
    expect(code({})).toBeNull();
    expect(code({}, [])).toBeNull();
    expect(code({}, ok, SHA.slice(0, 7))).toBeNull();
  });
  it('the PR is not open', () => {
    expect(code({ merged: true })).toBe('NOT_OPEN');
    expect(code({ state: 'closed' })).toBe('NOT_OPEN');
  });
  it('a draft', () => expect(code({ draft: true })).toBe('DRAFT'));
  it('the head moved', () => {
    expect(code({}, ok, 'ffff0000')).toBe('HEAD_MOVED');
    expect(code({}, ok, '')).toBe('HEAD_MOVED');
    expect(code({}, ok, 'abc12')).toBe('HEAD_MOVED'); // too short to pin anything
  });
  it('conflicts / not known yet', () => {
    expect(code({ mergeable: false })).toBe('CONFLICTS');
    expect(code({ mergeable: null })).toBe('MERGEABLE_UNKNOWN');
  });
  it('CI failed or still running', () => {
    expect(code({}, [...ok, { name: 'e2e', state: 'failure', url: null }])).toBe('CI_FAILED');
    expect(code({}, [...ok, { name: 'e2e', state: 'pending', url: null }])).toBe('CI_RUNNING');
    expect(mergeRefusal(pr, [{ name: 'e2e', state: 'failure', url: null }], SHA)?.message).toContain('e2e');
  });
});

describe('merge_pr — rendering every refusal the server sends', () => {
  const codes: MergeRefusalCode[] = ['NOT_A_PERSON', 'FORBIDDEN', 'NO_PR', 'NO_FORGE', 'NOT_OPEN', 'DRAFT', 'HEAD_MOVED', 'CONFLICTS', 'MERGEABLE_UNKNOWN', 'CI_FAILED', 'CI_RUNNING', 'PROTECTED'];
  it.each(codes)('%s comes back as "Not merged" with the reason', async (c) => {
    const result: MergePrResult = { merged: false, code: c, message: `because ${c}` };
    const backend = { mergePr: vi.fn(async () => result) } as unknown as ToolBackend;
    const out = await mergePrTool.handler(backend, { mapId: 'm1', nodeId: 'n1', expectedHeadSha: SHA } as never);
    expect(out).toBe(`Not merged (${c}): because ${c}`);
  });

  it('passes the pinned sha and method through', async () => {
    const backend = { mergePr: vi.fn(async () => ({ merged: true, repo: 'dan/avatar', number: 12, url: 'u', method: 'merge', mergeCommitSha: 'm9', nodeStatus: 'done', landedOnDefault: true })) } as unknown as ToolBackend;
    const out = await mergePrTool.handler(backend, { mapId: 'm1', nodeId: 'n1', expectedHeadSha: SHA, method: 'merge' } as never);
    expect(backend.mergePr).toHaveBeenCalledWith('m1', 'n1', { expectedHeadSha: SHA, method: 'merge' });
    expect(out).toContain('Merged PR #12 in dan/avatar (merge) as m9');
    expect(out).toContain('Ticket is now done.');
  });

  it('a release-branch merge says the ticket stays open', () => {
    expect(renderMergeResult({ merged: true, repo: 'o/r', number: 1, url: 'u', method: 'squash', mergeCommitSha: null, nodeStatus: 'in_progress', landedOnDefault: false })).toContain('other than the default branch');
  });

  it('the schema refuses a missing or too short sha before any call', () => {
    const schema = mergePrTool.schema.expectedHeadSha;
    expect(schema.safeParse('abc').success).toBe(false);
    expect(schema.safeParse(SHA).success).toBe(true);
    expect(mergePrTool.schema.method.safeParse('force').success).toBe(false);
  });
});

describe('prs_waiting', () => {
  it('one row per PR: repo#number, title, why, CI, since, node', () => {
    const out = renderPrsWaiting({
      now: 'x',
      items: [
        { mapId: 'm1', mapName: 'Tracer Avatar', nodeId: 'n1', ticket: 'Merges by voice', repo: 'dan/avatar', number: 12, url: 'https://u', title: 'feat: voice', ci: 'success', waits: 'Needs a human merge', since: '2026-11-18T07:30:00Z' },
        { mapId: 'm2', mapName: 'Sonarpipe', nodeId: 'n2', ticket: 'Fix audio', repo: '', number: 7, url: null, title: null, ci: 'unknown', waits: 'No CI', since: null },
      ],
    });
    expect(out).toContain('PRs waiting on a person: 2');
    expect(out).toContain('- [Tracer Avatar] dan/avatar#12 · feat: voice');
    expect(out).toContain('  Needs a human merge · CI green · since 2026-11-18 07:30 · node n1 · https://u');
    expect(out).toContain('- [Sonarpipe] PR #7 · Fix audio');
    expect(out).toContain('No CI · CI unknown · node n2');
    expect(renderPrsWaiting({ items: [], now: 'x' })).toBe('No PRs are waiting on a person.');
  });

  it('a PR on an archived map (read by naming the map) is marked [ARCHIVED]', () => {
    const out = renderPrsWaiting({
      now: 'x',
      items: [{ mapId: 'm1', mapName: 'Fulcrum CRM Roadmap', mapArchived: true, nodeId: 'n1', ticket: 'T', repo: 'o/r', number: 3, url: null, title: null, ci: 'success', waits: 'Needs a human merge', since: null }],
    });
    expect(out).toContain('- [Fulcrum CRM Roadmap] [ARCHIVED] o/r#3 · T');
  });

  it('at most one of mapId / fleetId', async () => {
    const backend = { prsWaiting: vi.fn(async () => ({ items: [], now: 'x' })) } as unknown as ToolBackend;
    await prsWaitingTool.handler(backend, { fleetId: 'f1' } as never);
    expect(backend.prsWaiting).toHaveBeenCalledWith({ mapId: undefined, fleetId: 'f1' });
    await expect(prsWaitingTool.handler(backend, { mapId: 'm', fleetId: 'f' } as never)).rejects.toThrow();
  });
});
