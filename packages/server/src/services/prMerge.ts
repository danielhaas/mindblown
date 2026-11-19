/**
 * A person merges a fleet PR through MindBlown — e.g. by voice through the
 * Tracer avatar, which calls MCP with the person's API key after they said
 * yes. Three reads/writes:
 *
 *   prSummary   — the node's PR, read live from the map's forge: head sha,
 *                 mergeable, every check, reviews, files with +/-, and why
 *                 it waits (the fleet's label). A webhook snapshot older
 *                 than SNAPSHOT_STALE_MS is refreshed from that read.
 *   mergePr     — merge through the map's forge connection (GitHub or
 *                 Gitea/Forgejo), pinned to the head sha the person saw.
 *                 Refuses — never forces — when the PR is not open, the
 *                 head moved, it conflicts, CI failed or is running, or the
 *                 forge refuses (protected branch). Only a person's key: a
 *                 fleet key (users.kind 'fleet') never merges. Afterwards
 *                 the same post-merge flow as a webhook merge runs
 *                 (sync/prMerged.ts), with the person as the actor.
 *   prsWaiting  — the open PRs waiting on a person.
 *
 * Which PR: the node's `linked_pr` mirror when it is open, else the PR the
 * fleet reports for the ticket (rollup claims). Fleet PRs say `Refs #N`
 * or name no issue at all, so most of them never get a mirror.
 */
import { eq } from 'drizzle-orm';
import {
  ciResult,
  mergeRefusal,
  PR_SUMMARY_FILES,
  snapshotCi,
  ticketPhases,
  waitLabel,
  waitsOnPerson,
} from '@mindblown/core';
import type {
  LinkedPrState,
  MergePrResult,
  MergeRefusal,
  Node as CoreNode,
  PrCheck,
  PrCiResult,
  PrSummary,
  PrWaiting,
  PrsWaitingList,
  TicketPhase,
} from '@mindblown/core';
import { ForgeApiError, MERGE_METHODS, type ForgeClient, type MergeMethod } from '@mindblown/integrations';
import { db } from '../db/connection.js';
import { users } from '../db/schema.js';
import * as nodeDb from '../db/nodes.js';
import * as permDb from '../db/permissions.js';
import * as fleetDb from '../db/fleet.js';
import * as fleetEntityDb from '../db/fleets.js';
import * as events from '../db/events.js';
import { getGitHubContextForMap, type ForgeMapContext } from '../lib/githubContext.js';
import { handlePrClosed } from '../sync/prSync.js';
import { applyMergedPr } from '../sync/prMerged.js';
import { broadcast } from '../ws.js';
import { loadTrustContext } from './trustPolicy.js';
import { mapsInScope } from './approvals.js';

/** A webhook snapshot older than this is refreshed by a pr_summary read. */
export const SNAPSHOT_STALE_MS = 5 * 60 * 1000;

export interface PrMergeError {
  status: 400 | 403 | 404 | 502;
  code: string;
  message: string;
}

const fail = (status: PrMergeError['status'], code: string, message: string): PrMergeError => ({ status, code, message });

// ── Locating the PR ────────────────────────────────────────────────

interface Located {
  node: CoreNode;
  ctx: ForgeMapContext;
  repo: string;
  number: number;
  snapshot: LinkedPrState | null;
  phase: TicketPhase | null;
}

/** The fleet's phase per ticket of one fleet (fresh hosts only). */
async function fleetPhases(fleetId: string | null): Promise<Map<string, TicketPhase>> {
  if (!fleetId) return new Map();
  return ticketPhases(await fleetDb.listRollups(fleetId), new Date());
}

async function locate(mapId: string, nodeId: string): Promise<Located | PrMergeError> {
  const node = await nodeDb.getNode(nodeId);
  if (!node || node.mapId !== mapId) return fail(404, 'NODE_NOT_FOUND', `Node ${nodeId} not found on map ${mapId}`);
  const phase = (await fleetPhases(await fleetEntityDb.getMapFleetId(mapId))).get(nodeId) ?? null;
  const snapshot = node.linkedPr?.state === 'open' ? node.linkedPr : null;
  const number = snapshot?.number ?? phase?.prNumber ?? null;
  if (number == null) return fail(404, 'NO_PR', `No open PR on record for "${node.text}".`);
  const ctx = await getGitHubContextForMap(mapId);
  if (!ctx) return fail(400, 'NO_FORGE', 'This map has no forge connection — MindBlown cannot read or merge its PRs.');
  const repo = snapshot?.repo ?? `${ctx.owner}/${ctx.repo}`;
  if (repo.toLowerCase() !== `${ctx.owner}/${ctx.repo}`.toLowerCase()) {
    return fail(400, 'NO_FORGE', `PR #${number} is in ${repo}, but this map's forge connection is for ${ctx.owner}/${ctx.repo}.`);
  }
  return { node, ctx, repo, number, snapshot, phase };
}

function forgeError(err: unknown, what: string): PrMergeError {
  const detail = err instanceof ForgeApiError ? `${err.status}: ${err.body.slice(0, 200)}` : err instanceof Error ? err.message : String(err);
  return fail(502, 'FORGE_ERROR', `Could not ${what} on the forge (${detail}).`);
}

async function readChecks(forge: ForgeClient, owner: string, repo: string, sha: string): Promise<PrCheck[]> {
  return forge.listCommitChecks(owner, repo, sha);
}

// ── pr_summary ─────────────────────────────────────────────────────

export async function prSummary(mapId: string, nodeId: string): Promise<PrSummary | PrMergeError> {
  const loc = await locate(mapId, nodeId);
  if ('status' in loc) return loc;
  const { node, ctx, repo, number, snapshot, phase } = loc;
  let detail, files, checks;
  try {
    detail = await ctx.forge.getPullRequestDetail(ctx.owner, ctx.repo, number);
    [files, checks] = await Promise.all([
      ctx.forge.listPullRequestFileStats(ctx.owner, ctx.repo, number),
      readChecks(ctx.forge, ctx.owner, ctx.repo, detail.headSha),
    ]);
  } catch (err) {
    return forgeError(err, `read PR #${number}`);
  }
  const ci = ciResult(checks);
  const state = detail.merged ? 'merged' : detail.state;
  const waits = state !== 'open' ? null : phase && waitsOnPerson(phase.label) ? phase.label : waitLabel(detail, ci);

  // Refresh a stale mirror from what was just read; reviews stay (webhook-fed).
  const now = new Date();
  if (snapshot && snapshot.number === number && state === 'open' && now.getTime() - Date.parse(snapshot.lastSyncedAt) > SNAPSHOT_STALE_MS) {
    const next: LinkedPrState = {
      ...snapshot,
      head: detail.head,
      base: detail.base,
      draft: detail.draft,
      mergeable: detail.mergeable,
      changedFiles: files.map((f) => f.path),
      checks: {
        state: ci === 'none' ? null : ci,
        failures: checks.filter((c) => c.state === 'failure').map((c) => c.name),
      },
      lastSyncedAt: now.toISOString(),
    };
    await nodeDb.updateNode(node.id, { linkedPr: next }).catch(() => null);
  }

  const sorted = [...files].sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions));
  return {
    mapId,
    nodeId: node.id,
    ticket: node.text,
    forge: ctx.forge.endpoint.kind,
    repo,
    number,
    url: detail.url,
    title: detail.title,
    author: detail.author,
    worker: node.claimedBySession ?? null,
    base: detail.base,
    head: detail.head,
    headSha: detail.headSha,
    state,
    draft: detail.draft,
    mergeable: detail.mergeable,
    ci,
    checks,
    reviews: snapshot?.number === number ? snapshot.reviews : [],
    waits,
    files: sorted.slice(0, PR_SUMMARY_FILES),
    filesTotal: detail.changedFiles ?? files.length,
    additions: detail.additions ?? files.reduce((n, f) => n + f.additions, 0),
    deletions: detail.deletions ?? files.reduce((n, f) => n + f.deletions, 0),
    readAt: now.toISOString(),
  };
}

// ── merge_pr ───────────────────────────────────────────────────────

/** Only a person on the map's trusted list, with edit, merges. A fleet key never does. */
export async function mergerRefusal(userId: string, mapId: string): Promise<MergeRefusal | null> {
  const [user] = await db.select({ kind: users.kind }).from(users).where(eq(users.id, userId));
  if (user?.kind !== 'person') {
    return { code: 'NOT_A_PERSON', message: "A fleet key cannot merge PRs — merging a PR that waits on a person is that person's decision." };
  }
  if (!permDb.hasPermission(await permDb.getPermission(mapId, userId), 'edit')) {
    return { code: 'FORBIDDEN', message: 'Edit access to the map required to merge its PRs.' };
  }
  const ctx = await loadTrustContext(mapId);
  if (!ctx?.policy.trustedUserIds.includes(userId)) {
    return { code: 'FORBIDDEN', message: "Only people on the map's trusted list may merge its PRs." };
  }
  return null;
}

function refused(r: MergeRefusal): MergePrResult {
  return { merged: false, ...r };
}

/** A forge's "no" to the merge call, in the person's words. */
function forgeRefusal(err: ForgeApiError, number: number, base: string): MergeRefusal | null {
  const said = err.body.slice(0, 200);
  if (err.status === 409) return { code: 'HEAD_MOVED', message: `PR #${number}'s head moved while merging — read pr_summary again. (${said})` };
  if (err.status === 403) return { code: 'PROTECTED', message: `The forge does not let MindBlown's connection merge into ${base} (${said}).` };
  if (err.status === 405 || err.status === 422) return { code: 'PROTECTED', message: `The forge refused to merge PR #${number} — ${base} is protected or the PR does not meet its rules (${said}).` };
  return null;
}

export interface MergePrInput {
  expectedHeadSha: string;
  method?: MergeMethod;
}

export async function mergePr(userId: string, mapId: string, nodeId: string, input: MergePrInput): Promise<MergePrResult | PrMergeError> {
  if (input.method && !MERGE_METHODS.includes(input.method)) return fail(400, 'VALIDATION_ERROR', `method must be one of ${MERGE_METHODS.join(', ')}`);
  if (typeof input.expectedHeadSha !== 'string' || input.expectedHeadSha.length === 0) {
    return fail(400, 'VALIDATION_ERROR', 'expectedHeadSha is required — the head sha pr_summary showed the person');
  }
  const who = await mergerRefusal(userId, mapId);
  if (who) return refused(who);

  const loc = await locate(mapId, nodeId);
  if ('status' in loc) {
    if (loc.code === 'NO_PR' || loc.code === 'NO_FORGE') return refused({ code: loc.code, message: loc.message });
    return loc;
  }
  const { node, ctx, repo, number } = loc;

  let detail, checks, settings;
  try {
    detail = await ctx.forge.getPullRequestDetail(ctx.owner, ctx.repo, number);
    [checks, settings] = await Promise.all([
      readChecks(ctx.forge, ctx.owner, ctx.repo, detail.headSha),
      ctx.forge.getRepoMergeSettings(ctx.owner, ctx.repo),
    ]);
  } catch (err) {
    return forgeError(err, `read PR #${number} before merging`);
  }
  const no = mergeRefusal(detail, checks, input.expectedHeadSha);
  if (no) return refused(no);

  const method = input.method ?? settings.defaultMethod;
  try {
    await ctx.forge.mergePullRequest(ctx.owner, ctx.repo, number, { method, headSha: detail.headSha });
  } catch (err) {
    const r = err instanceof ForgeApiError ? forgeRefusal(err, number, detail.base) : null;
    return r ? refused(r) : forgeError(err, `merge PR #${number}`);
  }

  // The merge stands from here; the trail below is best effort.
  const [user] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId));
  const mergedBy = user?.name ?? null;
  const landedOnDefault = detail.base === settings.defaultBranch;
  let mergeCommitSha: string | null = null;
  try {
    const after = await ctx.forge.getPullRequest(ctx.owner, ctx.repo, number);
    mergeCommitSha = after.merge_commit_sha ?? null;
    await afterMerge(userId, mergedBy, node, repo, {
      number,
      title: after.title ?? detail.title,
      body: after.body ?? null,
      html_url: detail.url,
      merge_commit_sha: mergeCommitSha,
      head: { ref: detail.head, sha: detail.headSha },
      base: detail.base,
      author: detail.author,
    }, settings.defaultBranch, ctx);
  } catch (err) {
    console.warn(`[merge-pr] post-merge flow for ${repo}#${number} failed:`, err instanceof Error ? err.message : err);
  }
  const fresh = await nodeDb.getNode(node.id);
  return { merged: true, repo, number, url: detail.url, method, mergeCommitSha, nodeStatus: fresh?.status ?? null, landedOnDefault };
}

/**
 * What a `pull_request.closed` + merged webhook does, with the person as
 * the actor — plus the ticket itself when no issue link ties it to the PR
 * (a fleet ticket without an issue): done, claim released, pr_merged.
 */
async function afterMerge(
  userId: string,
  mergedBy: string | null,
  node: CoreNode,
  repo: string,
  pr: { number: number; title: string; body: string | null; html_url: string; merge_commit_sha: string | null; head: { ref: string; sha: string }; base: string; author: string | null },
  defaultBranch: string,
  ctx: ForgeMapContext,
): Promise<void> {
  await handlePrClosed(repo, {
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: 'closed',
    merged: true,
    draft: false,
    head: pr.head,
    base: { ref: pr.base },
    html_url: pr.html_url,
    user: pr.author ? { login: pr.author } : null,
    mergeable: null,
  }, defaultBranch);
  if (pr.base !== defaultBranch) return; // A release-branch merge: work merged, not shipped — as the webhook.

  const transitions = await applyMergedPr(repo, pr, { actorUserId: userId, mergedBy, resolveForge: async () => ctx });
  if (transitions.some((t) => t.nodeId === node.id && t.recorded)) return;

  // The ticket the person merged for, when the PR names no issue of it.
  const before = await nodeDb.getNode(node.id);
  if (!before) return;
  const alreadyDone = before.status === 'done' && before.percentComplete === 100;
  if (!alreadyDone) {
    const updates: nodeDb.UpdateNodeInput = { status: 'done', percentComplete: 100 };
    const updated = await nodeDb.updateNode(node.id, updates);
    if (updated) {
      broadcast(updated.mapId, { type: 'node:updated', nodeId: node.id, fields: Object.keys(updates), node: updated, source: 'merge_pr' });
      events.recordFieldChanges(updated.mapId, node.id, userId, before, updated).catch(() => {});
      events
        .recordClaimTransition(updated.mapId, node.id, userId, before, updated, {
          reason: 'done',
          note: `PR #${pr.number} merged${mergedBy ? ` by ${mergedBy}` : ''}`,
        })
        .catch(() => {});
    }
  }
  events
    .recordPrMerged(before.mapId, node.id, userId, {
      prNumber: pr.number,
      repo,
      url: pr.html_url,
      mergeCommitSha: pr.merge_commit_sha,
      externalId: '',
      alreadyDone,
      mergedBy,
    })
    .catch(() => {});
}

// ── prs_waiting ────────────────────────────────────────────────────

function phaseCi(phase: TicketPhase | null): PrCiResult | 'unknown' {
  if (!phase) return 'unknown';
  if (phase.label === 'CI red') return 'failure';
  if (phase.label === 'No CI') return 'none';
  return 'unknown';
}

/**
 * Open PRs a person has to act on, across the maps in scope: a ticket the
 * fleet says waits on a person (Needs a human merge / No CI / CI red /
 * Merge conflict), and an open mirror outside the fleet that is not
 * waiting on CI. A fleet PR without a mirror is read from the forge for
 * its title and CI; one that turns out closed is left out.
 */
export async function prsWaiting(userId: string, scope: { mapId?: string; fleetId?: string }): Promise<PrsWaitingList | PrMergeError> {
  const inScope = await mapsInScope(userId, scope);
  if ('status' in inScope) return fail(inScope.status === 403 ? 403 : 404, inScope.code, inScope.message);
  const items: PrWaiting[] = [];
  const phasesByFleet = new Map<string, Map<string, TicketPhase>>();

  for (const map of inScope) {
    const fleetId = await fleetEntityDb.getMapFleetId(map.id);
    if (fleetId && !phasesByFleet.has(fleetId)) phasesByFleet.set(fleetId, await fleetPhases(fleetId));
    const phases = fleetId ? phasesByFleet.get(fleetId)! : new Map<string, TicketPhase>();
    const seen = new Set<string>();

    // Mirrors first: the webhook keeps them current without a forge call.
    for (const n of await nodeDb.listOpenLinkedPrNodes(map.id)) {
      const pr = n.linkedPr;
      const phase = phases.get(n.id) ?? null;
      const ci = snapshotCi(pr.checks.state);
      const waits = phase ? (waitsOnPerson(phase.label) ? phase.label : null) : waitLabel(pr, ci);
      seen.add(n.id);
      if (!waits) continue;
      items.push({
        mapId: map.id, mapName: map.name, ...(map.archived ? { mapArchived: true } : {}), nodeId: n.id, ticket: n.text, repo: pr.repo, number: pr.number,
        url: pr.url, title: null, ci, waits, since: phase?.since ?? pr.lastSyncedAt,
      });
    }

    // Fleet tickets without a mirror.
    const fleetOnly = [...phases].filter(([nodeId, p]) => !seen.has(nodeId) && p.prNumber != null && waitsOnPerson(p.label));
    if (fleetOnly.length === 0) continue;
    const ctx = await getGitHubContextForMap(map.id).catch(() => null);
    for (const [nodeId, phase] of fleetOnly) {
      const node = await nodeDb.getNode(nodeId);
      if (!node || node.mapId !== map.id || node.deletedAt) continue;
      const row: PrWaiting = {
        mapId: map.id, mapName: map.name, ...(map.archived ? { mapArchived: true } : {}), nodeId, ticket: node.text,
        repo: ctx ? `${ctx.owner}/${ctx.repo}` : '', number: phase.prNumber!, url: null, title: null,
        ci: phaseCi(phase), waits: phase.label, since: phase.since,
      };
      if (ctx) {
        try {
          const d = await ctx.forge.getPullRequestDetail(ctx.owner, ctx.repo, row.number);
          if (d.merged || d.state !== 'open') continue;
          row.url = d.url;
          row.title = d.title;
          row.ci = ciResult(await ctx.forge.listCommitChecks(ctx.owner, ctx.repo, d.headSha));
        } catch {
          /* the row stays, with what the fleet said */
        }
      }
      items.push(row);
    }
  }
  items.sort((a, b) => (a.since ?? '').localeCompare(b.since ?? ''));
  return { items, now: new Date().toISOString() };
}
