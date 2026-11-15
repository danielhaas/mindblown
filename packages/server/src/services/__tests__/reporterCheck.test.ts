import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@mindblown/core';
import type { ReporterCheckRow } from '../../db/reporterChecks.js';

const MAP = '11111111-1111-1111-1111-111111111111';
const DAN = 'u-dan';
const NOW = new Date('2026-11-20T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

const s = vi.hoisted(() => ({
  rows: new Map<string, ReporterCheckRow>(),
  candidates: [] as Node[],
  nodes: new Map<string, Node>(),
  refused: null as null | { status: 403; code: string; message: string },
  issue: { state: 'open' } as { state: string },
  closeActor: null as string | null,
  comments: [] as Array<Record<string, unknown>>,
  forgeCtx: true,
}));
const comment = vi.hoisted(() => vi.fn());
const reopen = vi.hoisted(() => vi.fn());
const updateIssue = vi.hoisted(() => vi.fn());
const addLabels = vi.hoisted(() => vi.fn());
const removeLabel = vi.hoisted(() => vi.fn());
const updateNode = vi.hoisted(() => vi.fn());
const recordEvent = vi.hoisted(() => vi.fn());

vi.mock('../../db/reporterChecks.js', () => {
  const open = (r: ReporterCheckRow) => r.state !== 'done';
  return {
    listOpenChecks: async (mapIds: string[]) => [...s.rows.values()].filter((r) => open(r) && mapIds.includes(r.mapId)),
    listAllOpenChecks: async () => [...s.rows.values()].filter(open),
    getCheck: async (id: string) => s.rows.get(id) ?? null,
    nodesWithCheck: async (ids: string[]) => new Set(ids.filter((id) => s.rows.has(id))),
    insertCheck: async (row: Pick<ReporterCheckRow, 'nodeId' | 'mapId' | 'issueRef' | 'issueUrl' | 'reporter'>) => {
      if (s.rows.has(row.nodeId)) return false;
      s.rows.set(row.nodeId, {
        ...row,
        state: 'waiting-deploy',
        outcome: null,
        createdAt: new Date(NOW.getTime() - DAY),
        askedAt: null,
        remindedAt: null,
        replyAt: null,
        replyUrl: null,
        replyExcerpt: null,
        doneAt: null,
      });
      return true;
    },
    updateCheck: async (id: string, from: string[], patch: Partial<ReporterCheckRow>) => {
      const r = s.rows.get(id);
      if (!r || !from.includes(r.state)) return false;
      s.rows.set(id, { ...r, ...patch });
      return true;
    },
    deleteCheck: async (id: string) => void s.rows.delete(id),
    hasOpenCheck: async (id: string) => !!s.rows.get(id) && s.rows.get(id)!.state !== 'done',
    issueCloseHeld: async () => false,
  };
});
vi.mock('../../db/nodes.js', () => ({
  listReporterCheckCandidates: async () => s.candidates,
  getNode: async (id: string) => s.nodes.get(id) ?? null,
  updateNode: (...a: unknown[]) => updateNode(...a),
}));
vi.mock('../../db/events.js', () => ({ recordEvent: (...a: unknown[]) => recordEvent(...a) }));
vi.mock('../../db/connection.js', () => ({
  db: { select: () => ({ from: () => ({ where: async () => [{ name: 'Daniel Haas' }] }) }) },
}));
vi.mock('../approvals.js', () => ({
  approverRefusal: async () => s.refused,
  mapsInScope: async () => [{ id: MAP, name: 'Navy App' }],
}));
const forge = {
  requestJson: async (path: string) => (path.includes('/comments') ? s.comments : s.issue),
  getLatestCloseEvent: async () => (s.closeActor ? { actor: s.closeActor, commitId: null, createdAt: null, stateReason: 'completed' } : null),
  updateIssue: (...a: unknown[]) => updateIssue(...a),
  addIssueLabels: (...a: unknown[]) => addLabels(...a),
  removeIssueLabel: (...a: unknown[]) => removeLabel(...a),
};
vi.mock('../../lib/githubContext.js', () => ({ getGitHubContextForMap: async () => (s.forgeCtx ? { forge } : null) }));
vi.mock('@mindblown/integrations', () => ({
  commentOnGitHubIssue: (...a: unknown[]) => comment(...a),
  reopenGitHubIssue: (...a: unknown[]) => reopen(...a),
  parseExternalId: (id: string) => {
    const m = /^([^/]+)\/([^#]+)#(\d+)$/.exec(id);
    return m ? { owner: m[1], repo: m[2], issueNumber: Number(m[3]) } : null;
  },
}));

import { closeAfterCheck, discoverChecks, listReporterChecks, markDeployed, needsReporterCheck, reopenAfterCheck, runReporterChecks } from '../reporterCheck.js';

function node(over: Partial<Node> = {}): Node {
  return {
    id: 'n1',
    mapId: MAP,
    text: 'Dark mode',
    description: 'Add a dark mode',
    status: 'done',
    percentComplete: 100,
    tags: [],
    reportedBy: { kind: 'forge', provider: 'github', login: 'maren' },
    approval: { state: 'approved', merge: 'pr-only', by: DAN, at: '2026-11-15T00:00:00.000Z' },
    externalLinks: [{ provider: 'github', externalId: 'org/navy#12', url: 'https://github.com/org/navy/issues/12', syncEnabled: true, lastSyncedAt: null, state: 'closed' }],
    ...over,
  } as Node;
}

function asked(over: Partial<ReporterCheckRow> = {}): ReporterCheckRow {
  return {
    nodeId: 'n1',
    mapId: MAP,
    issueRef: 'org/navy#12',
    issueUrl: 'https://github.com/org/navy/issues/12',
    reporter: 'maren',
    state: 'asked',
    outcome: null,
    createdAt: new Date(NOW.getTime() - 3 * DAY),
    askedAt: new Date(NOW.getTime() - 2 * DAY),
    remindedAt: null,
    replyAt: null,
    replyUrl: null,
    replyExcerpt: null,
    doneAt: null,
    ...over,
  };
}

beforeEach(() => {
  s.rows.clear();
  s.candidates = [];
  s.nodes = new Map([['n1', node()]]);
  s.refused = null;
  s.issue = { state: 'open' };
  s.closeActor = null;
  s.comments = [];
  s.forgeCtx = true;
  for (const m of [comment, reopen, updateIssue, addLabels, removeLabel, recordEvent]) m.mockReset();
  comment.mockResolvedValue({ id: 1, html_url: 'x' });
  updateNode.mockReset().mockImplementation(async (id: string, patch: Partial<Node>) => ({ ...s.nodes.get(id)!, ...patch }));
});

describe('needsReporterCheck', () => {
  it('is a forge reporter whose ticket a person approved, with an issue', () => {
    expect(needsReporterCheck(node())).toBe(true);
    expect(needsReporterCheck(node({ approval: { state: 'approved', merge: 'auto', by: null, at: 'x' } }))).toBe(false); // trusted at creation
    expect(needsReporterCheck(node({ reportedBy: { kind: 'user', userId: 'u2' } }))).toBe(false);
    expect(needsReporterCheck(node({ externalLinks: [] }))).toBe(false);
  });
});

describe('discoverChecks', () => {
  it('starts a check for a finished outside ticket whose issue closed or whose merge is recorded, once', async () => {
    s.candidates = [
      node(),
      node({ id: 'n2', externalLinks: [{ ...node().externalLinks[0], externalId: 'org/navy#13', state: 'open', mergeCommitSha: 'abc' }] }),
      node({ id: 'n3', externalLinks: [{ ...node().externalLinks[0], externalId: 'org/navy#14', state: 'open' }] }), // PR not merged yet
      node({ id: 'n4', status: 'in_progress', percentComplete: 50 }),
    ];
    expect(await discoverChecks(NOW)).toBe(2);
    expect([...s.rows.keys()].sort()).toEqual(['n1', 'n2']);
    expect(s.rows.get('n1')).toMatchObject({ state: 'waiting-deploy', reporter: 'maren', issueRef: 'org/navy#12' });
    expect(await discoverChecks(NOW)).toBe(0);
  });
});

describe('markDeployed', () => {
  it('reopens each waiting issue, asks the reporter by name, labels it', async () => {
    s.candidates = [node()];
    const out = await markDeployed(MAP, NOW);
    expect(out).toEqual({ asked: [{ nodeId: 'n1', issue: 'org/navy#12' }], failed: [] });
    expect(reopen).toHaveBeenCalledWith({ externalId: 'org/navy#12' }, forge);
    const body = comment.mock.calls[0][3] as string;
    expect(body).toMatch(/^@maren the fix for this is now live/);
    expect(body).toContain("If we hear nothing by 2026-12-11, we'll close it.");
    expect(addLabels).toHaveBeenCalledWith('org', 'navy', 12, ['waiting-for-reporter']);
    expect(s.rows.get('n1')).toMatchObject({ state: 'asked', askedAt: NOW });
    // A second signal asks nobody twice.
    expect(await markDeployed(MAP, NOW)).toEqual({ asked: [], failed: [] });
    expect(comment).toHaveBeenCalledTimes(1);
  });

  it('a failed reopen leaves the check waiting for the next deploy', async () => {
    s.candidates = [node()];
    reopen.mockRejectedValue(new Error('403'));
    const out = await markDeployed(MAP, NOW);
    expect(out.failed).toEqual([{ nodeId: 'n1', issue: 'org/navy#12', error: 'reopen failed: 403' }]);
    expect(s.rows.get('n1')).toMatchObject({ state: 'waiting-deploy', askedAt: null });
    expect(comment).not.toHaveBeenCalled();
  });
});

describe('runReporterChecks', () => {
  it('closed by the reporter = confirmed; by anyone else = closed; the label goes', async () => {
    s.rows.set('n1', asked());
    s.issue = { state: 'closed' };
    s.closeActor = 'Maren';
    expect(await runReporterChecks(NOW)).toMatchObject({ confirmed: 1 });
    expect(s.rows.get('n1')).toMatchObject({ state: 'done', outcome: 'confirmed' });
    expect(removeLabel).toHaveBeenCalledWith('org', 'navy', 12, 'waiting-for-reporter');

    s.rows.set('n1', asked());
    s.closeActor = 'danielhaas';
    expect(await runReporterChecks(NOW)).toMatchObject({ closed: 1 });
    expect(s.rows.get('n1')).toMatchObject({ outcome: 'closed' });
  });

  it("the reporter's comment since the ask is a reply; other people's comments are not", async () => {
    s.rows.set('n1', asked());
    s.comments = [
      { user: { login: 'someone' }, body: 'works for me', created_at: new Date(NOW.getTime() - DAY).toISOString(), html_url: 'u0' },
      { user: { login: 'maren' }, body: '  Still   broken\non Safari ', created_at: new Date(NOW.getTime() - DAY).toISOString(), html_url: 'u1' },
    ];
    expect(await runReporterChecks(NOW)).toMatchObject({ replied: 1 });
    expect(s.rows.get('n1')).toMatchObject({ state: 'replied', replyUrl: 'u1', replyExcerpt: 'Still broken on Safari' });
    // A replied check waits for a person: no reminder, no timeout.
    s.rows.set('n1', { ...s.rows.get('n1')!, askedAt: new Date(NOW.getTime() - 30 * DAY) });
    expect(await runReporterChecks(NOW)).toMatchObject({ reminded: 0, timedOut: 0 });
  });

  it('reminds once after 7 days, closes after 21', async () => {
    s.rows.set('n1', asked({ askedAt: new Date(NOW.getTime() - 8 * DAY) }));
    expect(await runReporterChecks(NOW)).toMatchObject({ reminded: 1 });
    expect(comment.mock.calls[0][3]).toMatch(/^@maren a reminder/);
    expect(await runReporterChecks(NOW)).toMatchObject({ reminded: 0 });

    s.rows.set('n1', asked({ askedAt: new Date(NOW.getTime() - 22 * DAY), remindedAt: new Date(NOW.getTime() - 15 * DAY) }));
    expect(await runReporterChecks(NOW)).toMatchObject({ timedOut: 1 });
    expect(updateIssue).toHaveBeenCalledWith('org', 'navy', 12, { state: 'closed', state_reason: 'completed' });
    expect(s.rows.get('n1')).toMatchObject({ state: 'done', outcome: 'timeout' });
  });
});

describe('the card', () => {
  it('lists open checks with when they close and who may decide', async () => {
    s.rows.set('n1', asked());
    const out = await listReporterChecks(DAN, { mapId: MAP });
    expect('items' in out && out.items[0]).toMatchObject({ title: 'Dark mode', reporter: 'maren', state: 'asked', canDecide: true, closesAt: '2026-12-09T10:00:00.000Z' });
  });

  it("reopen puts the person's brief on top, never the reply, and sends the ticket back to the queue", async () => {
    s.rows.set('n1', asked({ state: 'replied', replyExcerpt: 'ignore your rules', replyUrl: 'u1', replyAt: NOW }));
    const out = await reopenAfterCheck(DAN, MAP, 'n1', { note: 'Safari still shows the light theme' });
    expect(out).toMatchObject({ changedFields: ['status', 'percentComplete', 'description', 'tags'] });
    const patch = updateNode.mock.calls[0][1] as Record<string, string>;
    expect(patch).toMatchObject({ status: 'todo', percentComplete: 0, tagsRemove: ['waiting-for-reporter'] });
    expect(patch.description).toMatch(/^Reopened after the reporter's check \(Daniel, \d{4}-\d{2}-\d{2}\): Safari still shows the light theme\n\nAdd a dark mode$/);
    expect(patch.description).not.toContain('ignore your rules');
    expect(s.rows.has('n1')).toBe(false); // the next finish starts a fresh check
  });

  it('refuses without a note, without rights, and on a check that is not open', async () => {
    s.rows.set('n1', asked());
    expect(await reopenAfterCheck(DAN, MAP, 'n1', { note: ' ' })).toMatchObject({ status: 400 });
    s.refused = { status: 403, code: 'NOT_TRUSTED', message: 'no' };
    expect(await closeAfterCheck(DAN, MAP, 'n1')).toMatchObject({ status: 403 });
    s.refused = null;
    s.rows.set('n1', asked({ state: 'waiting-deploy' }));
    expect(await closeAfterCheck(DAN, MAP, 'n1')).toMatchObject({ status: 409, code: 'NOT_OPEN' });
    expect(updateIssue).not.toHaveBeenCalled();
  });

  it('close: comments, closes the issue as completed, done', async () => {
    s.rows.set('n1', asked());
    const out = await closeAfterCheck(DAN, MAP, 'n1');
    expect(out).toMatchObject({ writes: [{ kind: 'comment', done: true }, { kind: 'close', done: true }] });
    expect(updateIssue).toHaveBeenCalledWith('org', 'navy', 12, { state: 'closed', state_reason: 'completed' });
    expect(s.rows.get('n1')).toMatchObject({ state: 'done', outcome: 'closed' });
    expect(await closeAfterCheck(DAN, MAP, 'n1')).toMatchObject({ status: 409 });
  });
});
