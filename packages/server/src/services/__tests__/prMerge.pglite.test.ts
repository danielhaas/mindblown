/**
 * A person merges a fleet PR through MindBlown, end to end on PGlite: real
 * nodes, users, fleet rollups and change events; the forge is a double
 * behind the real GitHub / Gitea clients (so the wire calls are the real
 * ones). Covers a merge on each forge and the post-merge trail — node
 * done, claim released, mirror cleared, pr_merged with who merged — plus
 * the refusals the server owns (fleet key, untrusted editor, head moved,
 * CI red, a protected branch).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';

vi.mock('../../db/connection.js', async () =>
  (await import('../../test/pgliteDb.js')).pgliteConnection());
vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../lib/githubContext.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/githubContext.js')>()),
  getGitHubContextForMap: vi.fn(),
}));

import { createForgeClient, type ForgeFetch, type ForgeKind } from '@mindblown/integrations';
import type { LinkedPrState } from '@mindblown/core';
import { db } from '../../db/connection.js';
import { users, workspaces, maps, nodes, fleets, changeEvents, mapPermissions } from '../../db/schema.js';
import { truncateAll } from '../../test/pgliteDb.js';
import { upsertRollup } from '../../db/fleet.js';
import { getGitHubContextForMap } from '../../lib/githubContext.js';
import { mergePr, prSummary, prsWaiting } from '../prMerge.js';

const SHA = '0cd8f910799de3b216d420a490c541cf575b18f6';

interface Call { method: string; path: string; body: unknown }
type Handler = (body: unknown) => { status: number; body?: unknown };

/** A forge behind the real client: routes `METHOD /path` (query dropped) to a handler. */
function forgeDouble(kind: ForgeKind, owner: string, repo: string, routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const apiBaseUrl = kind === 'github' ? 'https://api.github.com' : 'https://git.example/api/v1';
  const fetchImpl: ForgeFetch = async (url, init) => {
    const path = url.slice(apiBaseUrl.length).split('?')[0];
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, path, body });
    const h = routes[`${init.method} ${path}`];
    const res = h ? h(body) : { status: 404, body: { message: 'not found' } };
    const text = res.body === undefined ? '' : JSON.stringify(res.body);
    return { status: res.status, ok: res.status >= 200 && res.status < 300, headers: { get: () => null }, json: async () => JSON.parse(text || 'null'), text: async () => text };
  };
  const forge = createForgeClient({ kind, apiBaseUrl: kind === 'gitea' ? 'https://git.example' : undefined, token: 't' }, fetchImpl);
  vi.mocked(getGitHubContextForMap).mockResolvedValue({ owner, repo, token: 't', forge });
  return calls;
}

function prWire(over: Record<string, unknown> = {}) {
  return {
    number: 12, title: 'Dark mode', body: 'Closes #5', state: 'open', merged: false, draft: false,
    html_url: 'https://github.com/o/r/pull/12', user: { login: 'fleet-bot' },
    base: { ref: 'main' }, head: { ref: 'fleet/dark', sha: SHA }, mergeable: true,
    additions: 12, deletions: 2, changed_files: 2, merge_commit_sha: null, merged_at: null, created_at: 'x', updated_at: 'x',
    ...over,
  };
}

async function seed() {
  const [owner] = await db.insert(users).values({ email: 'dan@example.com', name: 'Dan' }).returning();
  const [editor] = await db.insert(users).values({ email: 'e@example.com', name: 'Editor' }).returning();
  const [fleetUser] = await db.insert(users).values({ email: 'fleet-x@fleets.invalid', name: 'Fleet: x', kind: 'fleet' }).returning();
  const [ws] = await db.insert(workspaces).values({ name: 'W', slug: `w-${Math.random()}`, ownerId: owner.id }).returning();
  const [fleet] = await db.insert(fleets).values({ name: 'F', ownerId: owner.id, serviceUserId: fleetUser.id }).returning();
  const [map] = await db.insert(maps).values({ workspaceId: ws.id, name: 'Navy App', createdBy: owner.id, fleetId: fleet.id }).returning();
  await db.insert(mapPermissions).values([
    { mapId: map.id, userId: editor.id, permission: 'edit' },
    { mapId: map.id, userId: fleetUser.id, permission: 'edit' },
  ]);
  const [root] = await db.insert(nodes).values({ mapId: map.id, text: 'root', createdBy: owner.id }).returning();
  return { owner, editor, fleetUser, fleet, map, root };
}

async function leaf(s: Awaited<ReturnType<typeof seed>>, over: Partial<typeof nodes.$inferInsert> = {}) {
  const [n] = await db
    .insert(nodes)
    .values({ mapId: s.map.id, parentId: s.root.id, text: 'Dark mode', createdBy: s.owner.id, status: 'in_progress', percentComplete: 80, claimedBySession: 'claudia:slot1:fleet-worker', claimedAt: new Date(), ...over })
    .returning();
  return n;
}

const snapshot = (over: Partial<LinkedPrState> = {}): LinkedPrState => ({
  number: 12, repo: 'o/r', url: 'https://github.com/o/r/pull/12', head: 'fleet/dark', base: 'main', author: 'fleet-bot',
  draft: false, state: 'open', mergeable: true, changedFiles: ['a.ts'], reviews: [{ author: 'ray', state: 'APPROVED', body: 'ok', submittedAt: 'x' }],
  checks: { state: 'success', failures: [] }, lastSyncedAt: new Date().toISOString(), ...over,
});

/** A GitHub forge whose PR is #12 on o/r; the merge flips it to merged. */
function github(over: { checks?: unknown[]; mergeStatus?: number } = {}) {
  let merged = false;
  return forgeDouble('github', 'o', 'r', {
    'GET /repos/o/r/pulls/12': () => ({ status: 200, body: merged ? prWire({ state: 'closed', merged: true, merge_commit_sha: 'm1' }) : prWire() }),
    'GET /repos/o/r/pulls/12/files': () => ({ status: 200, body: [{ filename: 'a.ts', additions: 2, deletions: 1 }, { filename: 'big.ts', additions: 10, deletions: 1 }] }),
    [`GET /repos/o/r/commits/${SHA}/check-runs`]: () => ({ status: 200, body: { check_runs: over.checks ?? [{ name: 'test', status: 'completed', conclusion: 'success' }] } }),
    [`GET /repos/o/r/commits/${SHA}/status`]: () => ({ status: 200, body: { statuses: [] } }),
    'GET /repos/o/r': () => ({ status: 200, body: { default_branch: 'main' } }),
    'PUT /repos/o/r/pulls/12/merge': () => {
      if (over.mergeStatus && over.mergeStatus !== 200) return { status: over.mergeStatus, body: { message: 'Required status check "deploy" is expected.' } };
      merged = true;
      return { status: 200, body: { merged: true, sha: 'm1' } };
    },
  });
}

async function prMergedEvents(nodeId: string) {
  return db.select().from(changeEvents).where(and(eq(changeEvents.nodeId, nodeId), eq(changeEvents.eventType, 'node.pr_merged')));
}

describe('merge_pr on PGlite', () => {
  beforeEach(async () => {
    await truncateAll(db);
    vi.mocked(getGitHubContextForMap).mockReset();
  });

  it('GitHub: merges pinned to the head, then the webhook flow — done, claim released, mirror cleared, who merged', async () => {
    const s = await seed();
    const n = await leaf(s, {
      externalLinks: [{ provider: 'github', externalId: 'o/r#5', url: 'https://github.com/o/r/issues/5', syncEnabled: true, lastSyncedAt: null }],
      linkedPr: snapshot(),
    });
    const calls = github();

    const out = await mergePr(s.owner.id, s.map.id, n.id, { expectedHeadSha: SHA });
    expect(out).toMatchObject({ merged: true, repo: 'o/r', number: 12, method: 'squash', mergeCommitSha: 'm1', nodeStatus: 'done', landedOnDefault: true });
    expect(calls.find((c) => c.method === 'PUT')).toEqual({ method: 'PUT', path: '/repos/o/r/pulls/12/merge', body: { merge_method: 'squash', sha: SHA } });

    const [after] = await db.select().from(nodes).where(eq(nodes.id, n.id));
    expect(after.status).toBe('done');
    expect(after.claimedBySession).toBeNull();
    expect(after.linkedPr).toBeNull();
    const link = (after.externalLinks as Array<{ mergeCommitSha?: string }>)[0];
    expect(link.mergeCommitSha).toBe('m1');
    await vi.waitFor(async () => {
      const ev = await prMergedEvents(n.id);
      expect(ev).toHaveLength(1);
      expect(ev[0].userId).toBe(s.owner.id);
      expect(ev[0].newValue).toMatchObject({ prNumber: 12, mergedBy: 'Dan', externalId: 'o/r#5' });
    });
  });

  it('Gitea: a fleet ticket without an issue — PR found through the fleet, merged, the ticket itself goes done', async () => {
    const s = await seed();
    const n = await leaf(s, { text: 'Merges by voice' });
    await upsertRollup(s.fleet.id, {
      v: 2, host: 'claudia', generated_at: new Date().toISOString(), maps: [s.map.id], workers: [],
      claims: [{ nodeId: n.id, mapId: s.map.id, phase: 'pr', phase_since: '2026-11-18T07:00:00Z', pr_number: 7, ci: 'manual' }],
    }, s.map.id);
    let merged = false;
    const calls = forgeDouble('gitea', 'dan', 'avatar', {
      'GET /repos/dan/avatar/pulls/7': () => ({ status: 200, body: prWire({ number: 7, body: 'Fleet ticket', html_url: 'https://git.example/dan/avatar/pulls/7', ...(merged ? { state: 'closed', merged: true, merge_commit_sha: 'g1' } : {}) }) }),
      'GET /repos/dan/avatar/pulls/7/files': () => ({ status: 200, body: [{ filename: 'voice.ts', additions: 12, deletions: 2 }] }),
      [`GET /repos/dan/avatar/commits/${SHA}/status`]: () => ({ status: 200, body: { state: 'success', statuses: [{ context: 'ci / test', status: 'success' }] } }),
      'GET /repos/dan/avatar': () => ({ status: 200, body: { default_branch: 'main', default_merge_style: 'merge' } }),
      'POST /repos/dan/avatar/pulls/7/merge': () => {
        merged = true;
        return { status: 200 };
      },
    });

    const summary = await prSummary(s.map.id, n.id);
    expect(summary).toMatchObject({ forge: 'gitea', repo: 'dan/avatar', number: 7, headSha: SHA, waits: 'Needs a human merge', ci: 'success', worker: 'claudia:slot1:fleet-worker', filesTotal: 2 });
    const waiting = await prsWaiting(s.owner.id, { fleetId: s.fleet.id });
    expect(waiting).toMatchObject({ items: [{ nodeId: n.id, repo: 'dan/avatar', number: 7, waits: 'Needs a human merge', ci: 'success', since: '2026-11-18T07:00:00Z' }] });

    const out = await mergePr(s.owner.id, s.map.id, n.id, { expectedHeadSha: SHA.slice(0, 12) });
    expect(out).toMatchObject({ merged: true, repo: 'dan/avatar', number: 7, method: 'merge', mergeCommitSha: 'g1', nodeStatus: 'done' });
    expect(calls.find((c) => c.method === 'POST')).toEqual({ method: 'POST', path: '/repos/dan/avatar/pulls/7/merge', body: { Do: 'merge', head_commit_id: SHA } });

    const [after] = await db.select().from(nodes).where(eq(nodes.id, n.id));
    expect(after.status).toBe('done');
    expect(after.claimedBySession).toBeNull();
    await vi.waitFor(async () => {
      const ev = await prMergedEvents(n.id);
      expect(ev).toHaveLength(1);
      expect(ev[0].userId).toBe(s.owner.id);
      expect(ev[0].newValue).toMatchObject({ prNumber: 7, repo: 'dan/avatar', mergedBy: 'Dan', alreadyDone: false });
    });
  });

  it('pr_summary refreshes a mirror older than five minutes', async () => {
    const s = await seed();
    const n = await leaf(s, { linkedPr: snapshot({ lastSyncedAt: '2026-01-01T00:00:00Z', checks: { state: null, failures: [] } }) });
    github();
    const out = await prSummary(s.map.id, n.id);
    expect(out).toMatchObject({ number: 12, ci: 'success', reviews: [{ author: 'ray' }], files: [{ path: 'big.ts' }, { path: 'a.ts' }] });
    const [after] = await db.select().from(nodes).where(eq(nodes.id, n.id));
    const pr = after.linkedPr as LinkedPrState;
    expect(pr.checks.state).toBe('success');
    expect(pr.changedFiles).toEqual(['a.ts', 'big.ts']);
    expect(Date.parse(pr.lastSyncedAt)).toBeGreaterThan(Date.parse('2026-11-01T00:00:00Z'));
  });

  describe('refusals — nothing reaches the forge merge', () => {
    const noMerge = (calls: Call[]) => expect(calls.some((c) => c.path.endsWith('/merge'))).toBe(false);

    it('a fleet key', async () => {
      const s = await seed();
      const n = await leaf(s, { linkedPr: snapshot() });
      const calls = github();
      expect(await mergePr(s.fleetUser.id, s.map.id, n.id, { expectedHeadSha: SHA })).toMatchObject({ merged: false, code: 'NOT_A_PERSON' });
      noMerge(calls);
    });

    it('an editor who is not on the trusted list', async () => {
      const s = await seed();
      const n = await leaf(s, { linkedPr: snapshot() });
      const calls = github();
      expect(await mergePr(s.editor.id, s.map.id, n.id, { expectedHeadSha: SHA })).toMatchObject({ merged: false, code: 'FORBIDDEN' });
      noMerge(calls);
    });

    it('the head moved', async () => {
      const s = await seed();
      const n = await leaf(s, { linkedPr: snapshot() });
      const calls = github();
      expect(await mergePr(s.owner.id, s.map.id, n.id, { expectedHeadSha: 'deadbeef00' })).toMatchObject({ merged: false, code: 'HEAD_MOVED' });
      noMerge(calls);
    });

    it('CI red / running', async () => {
      const s = await seed();
      const n = await leaf(s, { linkedPr: snapshot() });
      const calls = github({ checks: [{ name: 'e2e', status: 'completed', conclusion: 'failure' }] });
      expect(await mergePr(s.owner.id, s.map.id, n.id, { expectedHeadSha: SHA })).toMatchObject({ merged: false, code: 'CI_FAILED' });
      github({ checks: [{ name: 'e2e', status: 'in_progress', conclusion: null }] });
      expect(await mergePr(s.owner.id, s.map.id, n.id, { expectedHeadSha: SHA })).toMatchObject({ merged: false, code: 'CI_RUNNING' });
      noMerge(calls);
    });

    it('no PR on record', async () => {
      const s = await seed();
      const n = await leaf(s);
      github();
      expect(await mergePr(s.owner.id, s.map.id, n.id, { expectedHeadSha: SHA })).toMatchObject({ merged: false, code: 'NO_PR' });
    });

    it('the forge protects the branch — the node stays as it was', async () => {
      const s = await seed();
      const n = await leaf(s, { linkedPr: snapshot() });
      github({ mergeStatus: 405 });
      const out = await mergePr(s.owner.id, s.map.id, n.id, { expectedHeadSha: SHA });
      expect(out).toMatchObject({ merged: false, code: 'PROTECTED' });
      expect((out as { message: string }).message).toContain('Required status check');
      const [after] = await db.select().from(nodes).where(eq(nodes.id, n.id));
      expect(after.status).toBe('in_progress');
    });
  });
});
