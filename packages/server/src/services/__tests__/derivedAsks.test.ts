/**
 * MindBlown's own rows on the Questions card (services/derivedAsks.ts):
 * stalled work after a day (a "Decision:" ticket after 2 h) and a
 * person's steps (skip-tagged tickets),
 * derived on read, snoozed by Later / Delegate, answered through the lint
 * fixes and recorded so the answered fold shows the round.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const NOW = Date.now();
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

const state = vi.hoisted(() => ({
  stalled: [] as Array<{ nodeId: string; percentComplete: number; lastChangeAt: string; lastRelease: { session: string; releasedAt: string; reason: string | null } | null }>,
  stored: [] as unknown[],
  nodes: [] as unknown[],
  archived: false,
  cap: 4,
  gate: [] as string[],
  versions: [] as Array<{ id: string; name: string; status: string; sortOrder: number }>,
  /** In a fleet with a repo — the deploy-probe question's precondition. */
  fleetRepo: false,
  probe: null as string | null,
}));
const NAVY = '11111111-2222-3333-4444-555555555555';

const node = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  text: id,
  tags: [],
  childrenIds: [],
  status: 'wip',
  percentComplete: 0,
  externalLinks: [],
  description: null,
  updatedAt: hoursAgo(3),
  ...extra,
});

const updateMap = vi.hoisted(() =>
  vi.fn(async (id: string, input: { dispatchGate?: string[]; deployProbe?: string | null }) => {
    if ('deployProbe' in input) state.probe = input.deployProbe ?? null;
    return { id, dispatchGate: input.dispatchGate };
  }),
);
vi.mock('../../db/maps.js', () => ({
  getMap: vi.fn(async (id: string) =>
    id === 'm1' || id === NAVY
      ? {
          map: {
            id,
            name: id === NAVY ? 'Navy App' : 'Navy',
            createdBy: 'u-owner',
            createdAt: hoursAgo(24 * 30),
            archivedAt: state.archived ? 'x' : null,
            maxActiveClaims: state.cap,
            dispatchGate: state.gate,
            statusWorkflow: [{ id: 'todo', name: 'Todo', category: 'todo' }, { id: 'wip', name: 'In progress', category: 'in_progress' }, { id: 'done', name: 'Done', category: 'done' }],
            ...(state.fleetRepo ? { fleetId: 'f1', githubRepoOwner: 'danielhaas', githubRepoName: 'navy' } : {}),
            deployProbe: state.probe,
          },
          nodes: state.nodes,
        }
      : null,
  ),
  updateMap,
}));
vi.mock('../../db/versions.js', () => ({ listVersions: vi.fn(async () => state.versions) }));
vi.mock('../../db/connection.js', () => ({ db: { select: () => ({ from: () => ({ where: async () => [{ name: 'Dan Haas' }] }) }) } }));
const updateNode = vi.hoisted(() => vi.fn(async (id: string, input: Record<string, unknown>) => ({ id, ...input })));
vi.mock('../../db/nodes.js', () => ({ updateNode }));
vi.mock('../../db/events.js', () => ({ recordFieldChanges: vi.fn(async () => {}) }));
vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../lib/stalled.js', () => ({ stalledForMap: vi.fn(async () => state.stalled) }));
const applyLintFix = vi.fn(async (_m: string, id: string) => ({ action: 'x', node: { id, mapId: 'm1' }, changedFields: ['percentComplete'] }));
vi.mock('../../lint/fix.js', () => ({
  applyLintFix: (...a: unknown[]) => applyLintFix(...(a as [string, string])),
  issueLinkOf: (n: { externalLinks: Array<{ isPullRequest?: boolean }> }) => n.externalLinks.find((l) => !l.isPullRequest) ?? null,
}));
const forge = vi.hoisted(() => ({ removeIssueLabel: vi.fn(async () => ({ status: 404, bodyText: '' })), endpoint: { kind: 'github' } }));
const ghCtx = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('../../lib/githubContext.js', () => ({ getGitHubContextForMap: vi.fn(async () => ghCtx.value) }));
const commentOnGitHubIssue = vi.hoisted(() => vi.fn(async () => ({ id: 1, html_url: 'x' })));
vi.mock('@mindblown/integrations', () => ({ commentOnGitHubIssue, ForgeApiError: class extends Error {} }));
const recordAnswer = vi.fn(async (k: { askId: string; mapId: string }, ask: unknown, p: { status: string }) => ({ ask, mapId: k.mapId, status: p.status }));
vi.mock('../../db/asks.js', () => ({
  ANSWER_RETENTION_DAYS: 14,
  listAsks: vi.fn(async () => state.stored),
  recordAnswer: (...a: unknown[]) => recordAnswer(...(a as [never, never, never])),
}));
vi.mock('../asks.js', () => ({ AskNotFoundError: class AskNotFoundError extends Error {}, AskValidationError: class AskValidationError extends Error {} }));

import { setLatestDeployDrift } from '../deployDrift.js';
import { answerDerivedAsk, autoCheckBlockers, openDerivedAsks, derivedAskRows, requeueOrphans, sendBlockersToFleet } from '../derivedAsks.js';

const key = { fleetId: 'f1', mapId: 'm1', askId: 'stalled-old' };
const scope = { fleetId: 'f1', mapId: 'm1' };

beforeEach(() => {
  vi.clearAllMocks();
  state.stalled = [
    { nodeId: 'old', percentComplete: 90, lastChangeAt: hoursAgo(30), lastRelease: null },
    { nodeId: 'new', percentComplete: 20, lastChangeAt: hoursAgo(5), lastRelease: null },
  ];
  state.nodes = [
    node('old', { text: 'Nicknames', priority: 'P3', percentComplete: 90 }),
    node('new', { percentComplete: 20 }),
    node('phone', { tags: ['needs-human'], description: '**Next step (a person): check on a real phone**\n\nInter.' }),
    node('done-step', { tags: ['needs-human'], status: 'done', percentComplete: 100 }),
    node('free', {}),
  ];
  state.stored = [];
  state.archived = false;
  state.cap = 4;
  state.gate = [];
  state.versions = [];
  state.fleetRepo = false;
  state.probe = null;
});

describe('stalled questions', () => {
  it('ask about work stalled for a day, not about work stalled for hours', async () => {
    const rows = (await derivedAskRows(['m1', 'gone'])).filter((r) => r.ask.id.startsWith('stalled-'));
    expect(rows.map((r) => [r.ask.id, r.mapId, r.status])).toEqual([['stalled-old', 'm1', 'open']]);
    expect(rows[0].ask.options).toEqual(['Done', 'Back to the queue', 'For a person']);
  });

  it('a "Decision:" ticket asks once it is stalled, not after a day', async () => {
    state.nodes = [...state.nodes.filter((n) => (n as { id: string }).id !== 'new'), node('new', { text: 'Decision: STP participation', percentComplete: 75 })];
    const rows = (await derivedAskRows(['m1'])).filter((r) => r.ask.id.startsWith('stalled-'));
    expect(rows.map((r) => r.ask.id)).toEqual(['stalled-old', 'stalled-new']);
  });

  it('a recent Later or Delegate snoozes the row; an old one or a plain answer does not', async () => {
    const stalledIds = async () => (await openDerivedAsks(scope, ['m1'])).map((r) => r.ask.id).filter((id) => id.startsWith('stalled-'));
    state.stored = [{ ask: { id: 'stalled-old', unblocks: {} }, mapId: 'm1', status: 'later', answeredAt: hoursAgo(2) }];
    expect(await stalledIds()).toEqual([]);
    state.stored = [{ ask: { id: 'stalled-old', unblocks: {} }, mapId: 'm1', status: 'later', answeredAt: hoursAgo(24 * 20) }];
    expect(await stalledIds()).toEqual(['stalled-old']);
    state.stored = [{ ask: { id: 'stalled-old', unblocks: {} }, mapId: 'm1', status: 'answered', answeredAt: hoursAgo(2) }];
    expect(await stalledIds()).toEqual(['stalled-old']);
  });

  it('Done / Back to the queue / free text run the matching fix and record the answer', async () => {
    const done = await answerDerivedAsk(key, { action: 'answered', decision: 'Done' }, 'u1');
    expect(applyLintFix).toHaveBeenLastCalledWith('m1', 'old', 'mark-done', 'u1', { note: undefined });
    expect(done.ok).toBe(true);
    expect(done.node).toEqual({ id: 'old', mapId: 'm1' });
    expect(recordAnswer).toHaveBeenLastCalledWith(key, expect.objectContaining({ id: 'stalled-old' }), expect.objectContaining({ status: 'answered', answeredBy: 'Dan' }));

    await answerDerivedAsk(key, { action: 'answered', decision: 'Back to the queue' }, 'u1');
    expect(applyLintFix).toHaveBeenLastCalledWith('m1', 'old', 'requeue', 'u1', { note: undefined });

    await answerDerivedAsk(key, { action: 'answered', decision: 'run the import on prod' }, 'u1');
    expect(applyLintFix).toHaveBeenLastCalledWith('m1', 'old', 'needs-human', 'u1', { note: 'run the import on prod' });
  });

  it('Later only records; a node no longer stalled has no question to answer', async () => {
    const later = await answerDerivedAsk(key, { action: 'later' }, 'u1');
    expect(applyLintFix).not.toHaveBeenCalled();
    expect(later.row.status).toBe('later');
    state.stalled = [];
    await expect(answerDerivedAsk(key, { action: 'answered', decision: 'Done' }, 'u1')).rejects.toThrow();
    await expect(answerDerivedAsk({ ...key, askId: '#6823' }, { action: 'answered', decision: 'Done' }, 'u1')).rejects.toThrow();
  });
});

describe('orphaned in progress goes back to the queue', () => {
  const fleetScope = { fleetId: 'f1', visibleMapIds: ['m1'], fleetLevel: false };
  const released = { session: 'host/w-3/claude', releasedAt: hoursAgo(5), reason: 'stale_sweep' };

  beforeEach(() => {
    state.stalled = [
      { nodeId: 'orphan', percentComplete: 25, lastChangeAt: hoursAgo(3), lastRelease: released },
      { nodeId: 'decision', percentComplete: 75, lastChangeAt: hoursAgo(3), lastRelease: released },
      { nodeId: 'mine', percentComplete: 40, lastChangeAt: hoursAgo(30), lastRelease: null },
    ];
    state.nodes = [node('orphan', { percentComplete: 25 }), node('decision', { text: 'Decision: STP participation' }), node('mine', { percentComplete: 40 })];
  });

  it('a worker\'s orphan is requeued and the answer recorded; never claimed and a decision wait on a person', async () => {
    const out = await requeueOrphans(fleetScope, ['m1', 'gone'], 'owner', new Date(NOW));
    expect(out).toEqual({ requeued: [{ askId: 'stalled-orphan', mapId: 'm1' }], failed: [] });
    expect(applyLintFix).toHaveBeenCalledTimes(1);
    expect(applyLintFix).toHaveBeenCalledWith('m1', 'orphan', 'requeue', 'owner');
    expect(recordAnswer).toHaveBeenCalledWith(
      { fleetId: 'f1', mapId: 'm1', askId: 'stalled-orphan' },
      expect.objectContaining({ id: 'stalled-orphan' }),
      expect.objectContaining({ status: 'answered', answeredBy: 'Auto-check', answer: expect.objectContaining({ decision: 'Back to the queue' }) }),
    );
  });

  it('an open question on the ticket or a recent Later holds it back', async () => {
    state.stored = [{ ask: { id: 'q-7', unblocks: { node_id: 'orphan' } }, mapId: 'm1', status: 'open' }];
    expect((await requeueOrphans(fleetScope, ['m1'], 'owner', new Date(NOW))).requeued).toEqual([]);
    state.stored = [{ ask: { id: 'stalled-orphan', unblocks: {} }, mapId: 'm1', status: 'later', answeredAt: hoursAgo(1) }];
    expect((await requeueOrphans(fleetScope, ['m1'], 'owner', new Date(NOW))).requeued).toEqual([]);
    expect(applyLintFix).not.toHaveBeenCalled();
  });

  it('a failed write is reported and recorded as not done', async () => {
    applyLintFix.mockRejectedValueOnce(new Error('node gone'));
    const out = await requeueOrphans(fleetScope, ['m1'], 'owner', new Date(NOW));
    expect(out).toEqual({ requeued: [], failed: [{ askId: 'stalled-orphan', mapId: 'm1', error: 'node gone' }] });
    expect(recordAnswer).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ writes: [expect.objectContaining({ done: false, error: 'node gone' })] }));
  });

  it('nothing on an archived map', async () => {
    state.archived = true;
    expect(await requeueOrphans(fleetScope, ['m1'], 'owner', new Date(NOW))).toEqual({ requeued: [], failed: [] });
  });
});

describe('a person\'s steps', () => {
  const stepKey = { fleetId: 'f1', mapId: 'm1', askId: 'step-phone' };

  it('one row per open ticket with a skip tag, its next step as the text; none for done work or an archived map', async () => {
    const steps = (await derivedAskRows(['m1'])).filter((r) => r.ask.id.startsWith('step-'));
    expect(steps.map((r) => r.ask.id)).toEqual(['step-phone']);
    expect(steps[0].ask).toMatchObject({ hint: 'ops-task', options: ['Done', 'Fleet can do it'], question: 'Next step: check on a real phone' });
    state.archived = true;
    expect(await derivedAskRows(['m1'])).toEqual([]);
  });

  it('no step row for a node a collector\'s open question already names', async () => {
    state.stored = [{ ask: { id: 'fleet-phone', unblocks: { node_id: 'phone' } }, mapId: 'm1', status: 'open', answeredAt: null }];
    expect((await openDerivedAsks(scope, ['m1'])).map((r) => r.ask.id)).toEqual(['stalled-old']);
  });

  it('no stalled row for a node a collector\'s open question already names', async () => {
    state.stored = [{ ask: { id: 'fleet-old', unblocks: { node_id: 'old' } }, mapId: 'm1', status: 'open', answeredAt: null }];
    expect((await openDerivedAsks(scope, ['m1'])).map((r) => r.ask.id)).toEqual(['step-phone']);
  });

  it('Done / Fleet can do it; free text is a decision, handed to the fleet unless kept (#619)', async () => {
    await answerDerivedAsk(stepKey, { action: 'answered', decision: 'Done' }, 'u1');
    expect(applyLintFix).toHaveBeenLastCalledWith('m1', 'phone', 'mark-done', 'u1', { note: undefined });
    await answerDerivedAsk(stepKey, { action: 'answered', decision: 'Fleet can do it' }, 'u1');
    expect(applyLintFix).toHaveBeenLastCalledWith('m1', 'phone', 'to-fleet', 'u1', { note: undefined });
    const date = new Date().toISOString().slice(0, 10);
    await answerDerivedAsk(stepKey, { action: 'answered', decision: 'yes, allow it' }, 'u1');
    expect(applyLintFix).toHaveBeenLastCalledWith('m1', 'phone', 'to-fleet', 'u1', { note: undefined, decision: `Decision (Dan, ${date}): yes, allow it` });
    await answerDerivedAsk(stepKey, { action: 'answered', decision: 'yes', next: 'done' }, 'u1');
    expect(applyLintFix).toHaveBeenLastCalledWith('m1', 'phone', 'mark-done', 'u1', { note: undefined, decision: `Decision (Dan, ${date}): yes` });
    await answerDerivedAsk(stepKey, { action: 'answered', decision: 'waiting for Thomas to send the key', next: 'mine' }, 'u1');
    expect(applyLintFix).toHaveBeenLastCalledWith('m1', 'phone', 'needs-human', 'u1', { note: 'waiting for Thomas to send the key' });
    await answerDerivedAsk(stepKey, { action: 'answered', decision: 'ask Rita', noRequeue: true }, 'u1');
    expect(applyLintFix).toHaveBeenLastCalledWith('m1', 'phone', 'needs-human', 'u1', { note: 'ask Rita' });
  });

  it('the decision goes on the linked issue and a hand-back takes the hold labels off', async () => {
    ghCtx.value = { owner: 'o', repo: 'r', forge };
    const issue = { provider: 'github', externalId: 'o/r#619', isPullRequest: false };
    applyLintFix.mockResolvedValueOnce({ action: 'to-fleet', node: { id: 'phone', mapId: 'm1', externalLinks: [issue] } as never, changedFields: ['tags'] });
    const out = await answerDerivedAsk(stepKey, { action: 'answered', decision: 'yes' }, 'u1');
    expect(commentOnGitHubIssue).toHaveBeenCalledWith('o', 'r', 619, expect.stringContaining('Decision (Dan, '), forge);
    expect(forge.removeIssueLabel.mock.calls.map((c) => (c as unknown[])[3])).toEqual(['blocked', 'kira-skip', 'needs-human', 'needs-daniel-input', 'needs-rita-review', 'misfiled?']);
    expect(out.ok).toBe(true);
    const writes = (recordAnswer.mock.calls.at(-1)![2] as unknown as { writes: Array<{ kind: string; done: boolean }> }).writes;
    expect(writes.map((w) => [w.kind, w.done])).toEqual([['mb-put', true], ['gh-comment', true], ['gh-edit', true]]);

    // Still mine: no decision, no comment, the labels stay.
    commentOnGitHubIssue.mockClear();
    forge.removeIssueLabel.mockClear();
    applyLintFix.mockResolvedValueOnce({ action: 'needs-human', node: { id: 'phone', mapId: 'm1', externalLinks: [issue] } as never, changedFields: ['tags'] });
    await answerDerivedAsk(stepKey, { action: 'answered', decision: 'later this week', next: 'mine' }, 'u1');
    expect(commentOnGitHubIssue).not.toHaveBeenCalled();
    expect(forge.removeIssueLabel).not.toHaveBeenCalled();
    ghCtx.value = null;
  });
});

describe('blockers (a worker\'s red CI, a wait)', () => {
  const blockerKey = { fleetId: 'f1', mapId: 'm1', askId: 'blocker-ci' };
  const ci = 'Fleet worker bb:slot1:fleet-worker: CI failed on PR #995 (445fab60). Fix the branch or close the PR.';
  beforeEach(() => {
    state.nodes.push(
      // No MindBlown claim: the worker still follows the PR from its own claim file (22.10.2026).
      node('ci', { blockedReason: ci, percentComplete: 90 }),
      node('vendor', { blockedReason: 'Waiting for the vendor' }),
      node('checking', { blockedReason: 'Waiting for the vendor', tags: ['fleet-check'] }),
      node('tagged', { blockedReason: 'x', tags: ['needs-human'] }),
      node('epic', { blockedReason: 'y', childrenIds: ['free'] }),
      node('closed', { blockedReason: 'z', status: 'done', percentComplete: 100 }),
    );
  });

  it('one row per open blocked leaf; a skip-tagged one stays a step, parents, done work and ones the fleet is checking get none', async () => {
    const rows = await derivedAskRows(['m1']);
    expect(rows.filter((r) => r.ask.id.startsWith('blocker-')).map((r) => r.ask.id)).toEqual(['blocker-ci', 'blocker-vendor']);
    expect(rows.map((r) => r.ask.id)).toContain('step-tagged');
    expect(rows.find((r) => r.ask.id === 'blocker-ci')!.ask).toMatchObject({ question: `Blocked: ${ci}`, options: ['Fleet can fix it', 'Unblocked', 'Done'] });
  });

  it('no row for a node a collector\'s open question already names', async () => {
    state.stored = [{ ask: { id: 'fleet-ci', unblocks: { node_id: 'ci' } }, mapId: 'm1', status: 'open', answeredAt: null }];
    expect((await openDerivedAsks(scope, ['m1'])).map((r) => r.ask.id)).not.toContain('blocker-ci');
  });

  it('Unblocked clears the blocker, Done finishes, free text = a person\'s next step', async () => {
    await answerDerivedAsk(blockerKey, { action: 'answered', decision: 'Fleet can fix it' }, 'u1');
    expect(applyLintFix).toHaveBeenLastCalledWith('m1', 'ci', 'fleet-fix', 'u1', { note: undefined });
    await answerDerivedAsk(blockerKey, { action: 'answered', decision: 'Unblocked' }, 'u1');
    expect(applyLintFix).toHaveBeenLastCalledWith('m1', 'ci', 'clear-blocker', 'u1', { note: undefined });
    await answerDerivedAsk(blockerKey, { action: 'answered', decision: 'Done' }, 'u1');
    expect(applyLintFix).toHaveBeenLastCalledWith('m1', 'ci', 'mark-done', 'u1', { note: undefined });
    await answerDerivedAsk(blockerKey, { action: 'answered', decision: 'bump the dependency on main' }, 'u1');
    expect(applyLintFix).toHaveBeenLastCalledWith('m1', 'ci', 'needs-human', 'u1', { note: 'bump the dependency on main' });
    await answerDerivedAsk({ ...blockerKey, askId: 'blocker-vendor' }, { action: 'answered', decision: 'Fleet can fix it' }, 'u1');
    expect(applyLintFix).toHaveBeenLastCalledWith('m1', 'vendor', 'fleet-check', 'u1', { note: undefined });
    expect(recordAnswer).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), expect.objectContaining({
      writes: [expect.objectContaining({ detail: expect.stringMatching(/^fleet-check — Decision \(Dan, \d{4}-\d\d-\d\d\): Fleet can fix it$/) })],
    }));
  });

  it('"Let the fleet check all": every blocker row, fix or check by its kind; steps and stalled rows stay', async () => {
    const out = await sendBlockersToFleet({ fleetId: 'f1', visibleMapIds: ['m1'], fleetLevel: false }, ['m1'], 'u1', 'Dan');
    expect(out.sent).toEqual([
      { askId: 'blocker-ci', mapId: 'm1', action: 'fleet-fix' },
      { askId: 'blocker-vendor', mapId: 'm1', action: 'fleet-check' },
    ]);
    expect(out.failed).toEqual([]);
    expect(applyLintFix.mock.calls.map((c) => (c as unknown[]).slice(1, 3))).toEqual([['ci', 'fleet-fix'], ['vendor', 'fleet-check']]);
  });

  describe('auto-check', () => {
    const fleetScope = { fleetId: 'f1', visibleMapIds: ['m1'], fleetLevel: false };
    const gaveUp = 'Fleet worker bb:slot1:fleet-worker: the agent ran past 60 min and was stopped. Partial work: branch b.';
    beforeEach(() => {
      state.nodes.push(
        node('timeout', { blockedReason: gaveUp }),
        node('fresh', { blockedReason: gaveUp, updatedAt: new Date(NOW - 10 * 60_000).toISOString() }),
        node('merge', { blockedReason: 'Fleet worker bb:slot1:fleet-worker: PR #7 came from a ticket approved for a PR only. Review it and merge it by hand.' }),
      );
    });
    const ourRow = (writes: unknown[] = [{ done: true }]) => ({ ask: { id: 'blocker-timeout' }, mapId: 'm1', status: 'answered', answeredBy: 'Auto-check', answeredAt: hoursAgo(1), writes });

    it('checks a fleet give-up that has sat 30 min, as Auto-check; not a fresh one, a person\'s blocker or a PR note', async () => {
      const out = await autoCheckBlockers(fleetScope, ['m1'], 'owner', new Date(NOW));
      expect(out.sent).toEqual([{ askId: 'blocker-timeout', mapId: 'm1', action: 'fleet-check' }]);
      expect(applyLintFix).toHaveBeenCalledTimes(1);
      expect(applyLintFix).toHaveBeenLastCalledWith('m1', 'timeout', 'fleet-check', 'owner', { note: undefined });
      expect(recordAnswer).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ answeredBy: 'Auto-check' }));
    });

    it('once per ticket: a row last answered by the auto-check stays with a person; a person\'s answer or a failed write re-arms it', async () => {
      state.stored = [ourRow()];
      expect((await autoCheckBlockers(fleetScope, ['m1'], 'owner', new Date(NOW))).sent).toEqual([]);
      state.stored = [{ ...ourRow(), answeredBy: 'Dan' }];
      expect((await autoCheckBlockers(fleetScope, ['m1'], 'owner', new Date(NOW))).sent.map((r) => r.askId)).toEqual(['blocker-timeout']);
      state.stored = [ourRow([{ done: false, error: 'db down' }])];
      expect((await autoCheckBlockers(fleetScope, ['m1'], 'owner', new Date(NOW))).sent.map((r) => r.askId)).toEqual(['blocker-timeout']);
    });

    describe('stale: the ticket a blocker waits for is done now (#493 on 29.10.2026)', () => {
      const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
      const link = (n: number) => [{ provider: 'github', externalId: `o/r#${n}`, url: '', syncEnabled: true, lastSyncedAt: null }];
      const question = 'Fleet worker claudia:slot2:fleet-worker: needs a decision: #492 is merged. #494 is still open. Wait for it?';
      const ours = (mins: number) => ({ ask: { id: 'blocker-q' }, mapId: 'm1', status: 'answered', answeredBy: 'Auto-check', answeredAt: minsAgo(mins), writes: [{ done: true }] });
      const staleSent = async () => (await autoCheckBlockers(fleetScope, ['m1'], 'owner', new Date(NOW))).sent.map((r) => r.askId).filter((id) => id === 'blocker-q');
      const setDeps = (done494: string | null) => {
        state.nodes.push(
          node('q', { blockedReason: question, updatedAt: minsAgo(60), externalLinks: link(493) }),
          node('t492', { status: 'done', percentComplete: 100, completedAt: minsAgo(600), externalLinks: link(492) }),
          node('t494', done494 ? { status: 'done', percentComplete: 100, completedAt: done494, externalLinks: link(494) } : { externalLinks: link(494) }),
        );
      };

      it('checks the question again once every named ticket is done and one finished after it', async () => {
        setDeps(minsAgo(40));
        state.stored = [ours(61), { ask: { id: 'fleet-q', unblocks: { node_id: 'q' } }, mapId: 'm1', status: 'open', answeredAt: null }];
        expect(await staleSent()).toEqual(['blocker-q']);
      });

      it('not while a named ticket is open, nor for one done before the blocker, nor twice', async () => {
        setDeps(null);
        expect(await staleSent()).toEqual([]);
        state.nodes = state.nodes.filter((n) => !['q', 't492', 't494'].includes((n as { id: string }).id));
        setDeps(minsAgo(90));
        expect(await staleSent()).toEqual([]);
        state.nodes = state.nodes.filter((n) => !['q', 't492', 't494'].includes((n as { id: string }).id));
        setDeps(minsAgo(40));
        state.stored = [ours(35)];
        expect(await staleSent()).toEqual([]);
      });

      it('a named ticket done at an unknown time counts as done, but does not set it off', async () => {
        setDeps(minsAgo(40));
        const t492 = state.nodes.find((n) => (n as { id: string }).id === 't492') as Record<string, unknown>;
        t492.completedAt = null;
        expect(await staleSent()).toEqual(['blocker-q']);
        const t494 = state.nodes.find((n) => (n as { id: string }).id === 't494') as Record<string, unknown>;
        t494.completedAt = null;
        expect(await staleSent()).toEqual([]);
      });

      it('never a person\'s blocker that names a ticket', async () => {
        setDeps(minsAgo(40));
        state.nodes.push(node('held', { blockedReason: 'Waiting for #494', updatedAt: minsAgo(60) }));
        expect((await autoCheckBlockers(fleetScope, ['m1'], 'owner', new Date(NOW))).sent.map((r) => r.askId)).not.toContain('blocker-held');
      });
    });

    it('the fresh give-up is checked once its 30 min are up', async () => {
      const out = await autoCheckBlockers(fleetScope, ['m1'], 'owner', new Date(NOW + 25 * 60_000));
      expect(out.sent.map((r) => r.askId)).toEqual(['blocker-timeout', 'blocker-fresh']);
    });
  });
});

describe('tickets that need a brief', () => {
  const ready = (id: string, extra: Record<string, unknown> = {}) =>
    node(id, {
      parentId: 'root', status: null, claimedBySession: null, dependencies: [], blockedReason: null,
      approval: { state: 'approved', merge: 'auto', by: null, at: '2026-10-28T00:00:00.000Z' },
      ...extra,
    });
  const briefKey = { fleetId: 'f1', mapId: 'm1', askId: 'brief-bare' };

  beforeEach(() => {
    state.stalled = [];
    state.nodes = [
      node('root', { parentId: null, childrenIds: ['bare', 'held', 'described'], dependencies: [], claimedBySession: null }),
      ready('bare', { text: 'Show durations' }),
      ready('held', { tags: ['needs-human'] }),
      ready('described', { description: 'Add a duration column to done cards' }),
    ];
  });

  it('one row per ready ticket the pull refuses for want of a brief; a held one stays a step', async () => {
    const rows = await derivedAskRows(['m1']);
    expect(rows.filter((r) => r.ask.id.startsWith('brief-')).map((r) => r.ask.id)).toEqual(['brief-bare']);
    expect(rows.map((r) => r.ask.id)).toContain('step-held');
    expect(rows.find((r) => r.ask.id === 'brief-bare')!.ask).toMatchObject({ title: 'Show durations', options: ['Done'], sources: ['mindblown-brief'] });
  });

  it('none while the map is on hold (cap 0) — nothing is pulled, so nothing waits on a brief', async () => {
    state.cap = 0;
    expect((await derivedAskRows(['m1'])).filter((r) => r.ask.id.startsWith('brief-'))).toEqual([]);
  });

  it('free text writes the brief, Done finishes', async () => {
    await answerDerivedAsk(briefKey, { action: 'answered', decision: 'Show on done cards how long they took' }, 'u1');
    expect(applyLintFix).toHaveBeenLastCalledWith('m1', 'bare', 'write-brief', 'u1', { note: 'Show on done cards how long they took' });
    await answerDerivedAsk(briefKey, { action: 'answered', decision: 'Done' }, 'u1');
    expect(applyLintFix).toHaveBeenLastCalledWith('m1', 'bare', 'mark-done', 'u1', { note: undefined });
  });
});

describe('ready work outside the dispatch gate', () => {
  const fleetScope = { fleetId: 'f1', visibleMapIds: [NAVY], fleetLevel: false };
  const ticket = (id: string, extra: Record<string, unknown> = {}) =>
    node(id, { parentId: 'root', status: 'todo', claimedBySession: null, dependencies: [], approval: { state: 'approved' }, blockedReason: null, versionId: null, description: 'Brief.', ...extra });
  const navy = () => [
    node('root', { parentId: null, childrenIds: ['a', 'b', 'c', 'd', 'e'], status: null }),
    ticket('a', { versionId: 'v1', tags: ['needs-human'] }), // inside the gate, a person's
    ticket('b'),
    ticket('c', { text: 'TeamSnap OAuth', priority: 'P1' }),
    ticket('d', { versionId: 'v3' }),
    ticket('e', { versionId: 'v4' }),
  ];
  const gateRows = async () => (await openDerivedAsks(fleetScope, [NAVY])).filter((r) => r.ask.id.startsWith('gate-'));

  beforeEach(() => {
    state.stalled = [];
    state.gate = ['type:bug|version:v1|version:v2'];
    state.versions = [
      { id: 'v1', name: 'V1', status: 'active', sortOrder: 1 },
      { id: 'v2', name: 'V2', status: 'planning', sortOrder: 2 },
      { id: 'v3', name: 'V3', status: 'planning', sortOrder: 3 },
      { id: 'v4', name: 'V4', status: 'planning', sortOrder: 4 },
    ];
    state.nodes = navy();
  });

  it('an idle map with ready tickets outside its gate asks its owner once, with the split', async () => {
    const rows = await gateRows();
    expect(rows).toHaveLength(1);
    const a = rows[0].ask;
    expect(a.id).toMatch(new RegExp(`^gate-${NAVY}-[0-9a-f]{8}$`));
    expect(a.question).toContain('Navy App: the fleet is idle, 4 ready tickets are outside the gate (2 unversioned, 2 in V3/V4)');
    expect(a.options).toEqual(['Version them', 'Widen the gate', 'Leave it']);
    expect(a.hint).toBe('decision');
    expect(a.answerer).toBe('Dan');
  });

  it('nothing outside the gate, work inside it, no gate, or the map on hold → no ask', async () => {
    state.nodes = navy().filter((n) => !['b', 'c', 'd', 'e'].includes((n as { id: string }).id));
    expect(await gateRows()).toEqual([]);
    state.nodes = [...navy(), ticket('f', { versionId: 'v2' })];
    expect(await gateRows()).toEqual([]);
    state.nodes = navy();
    state.gate = [];
    expect(await gateRows()).toEqual([]);
    state.gate = ['version:v1'];
    state.cap = 0;
    expect(await gateRows()).toEqual([]);
  });

  it('an answered row is not asked again until the gated-out set changes', async () => {
    const [row] = await gateRows();
    await answerDerivedAsk({ fleetId: 'f1', mapId: NAVY, askId: row.ask.id }, { action: 'answered', decision: 'Leave it' }, 'u1');
    expect(recordAnswer).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ id: row.ask.id }), expect.objectContaining({ status: 'answered' }));
    expect(updateNode).not.toHaveBeenCalled();
    expect(updateMap).not.toHaveBeenCalled();
    state.stored = [{ ask: row.ask, mapId: NAVY, status: 'answered', answeredAt: hoursAgo(1), writes: [] }];
    expect(await gateRows()).toEqual([]);
    state.nodes = [...navy(), ticket('g')];
    const again = await gateRows();
    expect(again).toHaveLength(1);
    expect(again[0].ask.id).not.toBe(row.ask.id);
  });

  it('Version them puts the unversioned ones into the active version', async () => {
    const [row] = await gateRows();
    const out = await answerDerivedAsk({ fleetId: 'f1', mapId: NAVY, askId: row.ask.id }, { action: 'answered', decision: 'Version them' }, 'u1');
    expect(updateNode.mock.calls.map((c) => [c[0], c[1]])).toEqual([['b', { versionId: 'v1' }], ['c', { versionId: 'v1' }]]);
    expect(out.ok).toBe(true);
  });

  it('Version them without an active version writes nothing and says why', async () => {
    state.versions = state.versions.map((v) => ({ ...v, status: 'planning' }));
    const [row] = await gateRows();
    expect(row.ask.question).toContain('the map has none');
    const out = await answerDerivedAsk({ fleetId: 'f1', mapId: NAVY, askId: row.ask.id }, { action: 'answered', decision: 'Version them' }, 'u1');
    expect(updateNode).not.toHaveBeenCalled();
    expect(out.ok).toBe(false);
  });

  it('Widen the gate ORs in the versions of the gated-out tickets', async () => {
    const [row] = await gateRows();
    await answerDerivedAsk({ fleetId: 'f1', mapId: NAVY, askId: row.ask.id }, { action: 'answered', decision: 'Widen the gate' }, 'u1');
    expect(updateMap).toHaveBeenCalledWith(NAVY, { dispatchGate: ['type:bug|version:v1|version:v2|version:v3|version:v4'] }, 'u1');
  });
});

describe('how is the map deployed? (deploy probe)', () => {
  const probeKey = { fleetId: 'f1', mapId: 'm1', askId: 'deploy-probe-m1' };
  const probeRows = async () => (await derivedAskRows(['m1'])).filter((r) => r.ask.id.startsWith('deploy-probe-'));

  it('asked of a map in a fleet with a repo and no probe — not once it has one, nor without fleet or repo', async () => {
    expect(await probeRows()).toEqual([]);
    state.fleetRepo = true;
    const rows = await probeRows();
    expect(rows.map((r) => [r.ask.id, r.mapId, r.ask.title])).toEqual([['deploy-probe-m1', 'm1', 'How is Navy deployed?']]);
    state.probe = 'none';
    expect(await probeRows()).toEqual([]);
    state.probe = 'https://navy.example/api/version';
    expect(await probeRows()).toEqual([]);
    state.probe = null;
    state.archived = true;
    expect(await probeRows()).toEqual([]);
  });

  it("not for the repo this server runs from — its own checkout's drift covers it (#645)", async () => {
    state.fleetRepo = true;
    setLatestDeployDrift({ sha: 'a'.repeat(40), repo: 'DanielHaas/Navy', undeployed: [], checkedAt: 'x' });
    try {
      expect(await probeRows()).toEqual([]);
    } finally {
      setLatestDeployDrift(null);
    }
  });

  it('a URL answer becomes the probe and the question is gone for good', async () => {
    state.fleetRepo = true;
    const out = await answerDerivedAsk(probeKey, { action: 'answered', decision: 'https://navy.example/api/version' }, 'u1');
    expect(out.ok).toBe(true);
    expect(state.probe).toBe('https://navy.example/api/version');
    expect(recordAnswer).toHaveBeenLastCalledWith(probeKey, expect.objectContaining({ id: 'deploy-probe-m1' }), expect.objectContaining({ status: 'answered' }));
    expect(await probeRows()).toEqual([]);
    await expect(answerDerivedAsk(probeKey, { action: 'answered', decision: 'none' }, 'u1')).rejects.toThrow();
  });

  it('"none" stores none; other text is refused and nothing is written', async () => {
    state.fleetRepo = true;
    await expect(answerDerivedAsk(probeKey, { action: 'answered', decision: 'by hand from gamora' }, 'u1')).rejects.toThrow('probe URL');
    expect(state.probe).toBeNull();
    expect(recordAnswer).not.toHaveBeenCalled();
    await answerDerivedAsk(probeKey, { action: 'answered', decision: 'none' }, 'u1');
    expect(state.probe).toBe('none');
  });

  it('Later snoozes it like any derived row', async () => {
    state.fleetRepo = true;
    await answerDerivedAsk(probeKey, { action: 'later' }, 'u1');
    expect(state.probe).toBeNull();
    state.stored = [{ ask: { id: 'deploy-probe-m1', unblocks: {} }, mapId: 'm1', status: 'later', answeredAt: hoursAgo(1) }];
    expect((await openDerivedAsks(scope, ['m1'])).filter((r) => r.ask.id.startsWith('deploy-probe-'))).toEqual([]);
  });
});
