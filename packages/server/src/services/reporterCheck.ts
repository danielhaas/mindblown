/**
 * The reporter's check: a ticket someone outside the project filed is
 * finished when that person has seen the fix working, not when the PR
 * merges.
 *
 *   1. A ticket a person approved (it went through the gate, #492) whose
 *      issue closed or whose merge is recorded gets a row, `waiting-deploy`
 *      — cheap signals; a pr-only worker marks the node done at PR open.
 *   2. A deploy signal (the card's button, POST /api/maps/:id/deployed,
 *      mark_deployed) asks the forge whether the work really landed (a
 *      merged closing PR, none in flight) and only then reopens the issue
 *      and asks the reporter to close it if the fix works, or to say what
 *      is still wrong. Not landed yet: the row keeps waiting.
 *   3. The timer polls the asked issues: closed by the reporter =
 *      confirmed; closed by anyone else = closed; a comment by the
 *      reporter = `replied`, for a person to decide. No answer: one
 *      reminder after REMIND_AFTER_DAYS, closed after CLOSE_AFTER_DAYS.
 *   4. A person decides a reply: reopen the ticket with their own brief
 *      (the reporter's words are untrusted and never become the brief),
 *      or close the issue.
 *
 * While a check is open MindBlown's own issue sync holds the close
 * (`issueCloseHeld`); the inbound reopen of an issue we reopened neither
 * rolls the node back off done nor re-triages it (`askingOnIssue`). A row
 * whose node is no longer done is dropped: the work is back in the queue.
 */
import { eq } from 'drizzle-orm';
import { REPORTER_CLOSE_AFTER_DAYS, REPORTER_REMIND_AFTER_DAYS, isForgeLink, proseMirrorToPlainText } from '@mindblown/core';
import type { DeployedResult, Node as CoreNode, ReopenAfterCheckInput, ReporterCheck, ReporterCheckList } from '@mindblown/core';
import { commentOnGitHubIssue, parseExternalId, probeIssueLanded, reopenGitHubIssue } from '@mindblown/integrations';
import type { ForgeClient } from '@mindblown/integrations';
import { db } from '../db/connection.js';
import { users } from '../db/schema.js';
import * as nodeDb from '../db/nodes.js';
import * as checkDb from '../db/reporterChecks.js';
import type { ReporterCheckRow } from '../db/reporterChecks.js';
import { recordEvent } from '../db/events.js';
import { getGitHubContextForMap } from '../lib/githubContext.js';
import { approverRefusal, mapsInScope } from './approvals.js';
import type { ApprovalError } from './approvals.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Tickets finished longer ago than this are not asked about (a slow review still fits). */
export const DISCOVER_WINDOW_DAYS = 30;
/** Nothing finished before the feature went live is asked about — settled issues stay settled. */
export const DISCOVER_FROM = new Date('2026-11-15T12:00:00.000Z');
/** A row asked this recently is left to the deploy that is still reopening it. */
const ASKING_GRACE_MS = 2 * 60 * 1000;
/** The issue label while the reporter is asked. */
export const WAITING_LABEL = 'waiting-for-reporter';
const EXCERPT_CHARS = 300;

/** A person let it through and a forge author reported it: their check decides the close. */
export function needsReporterCheck(node: CoreNode): boolean {
  return node.reportedBy?.kind === 'forge' && node.approval?.state === 'approved' && !!node.approval.by && !!issueLinkOf(node);
}

function issueLinkOf(node: CoreNode) {
  return node.externalLinks.find((l) => isForgeLink(l) && !l.isPullRequest) ?? null;
}

function looksDone(node: CoreNode): boolean {
  return node.status === 'done' || node.percentComplete === 100;
}

export { issueCloseHeld } from '../db/reporterChecks.js';

// ── Text posted on the issue ─────────────────────────────────────────

const date = (d: Date) => d.toISOString().slice(0, 10);

export function askComment(reporter: string, closesAt: Date): string {
  return [
    `@${reporter} the fix for this is now live — could you check whether it works for you?`,
    '',
    '- If it works, please close this issue.',
    "- If something is still wrong, reply here with what you see.",
    '',
    `If we hear nothing by ${date(closesAt)}, we'll close it.`,
  ].join('\n');
}

export function reminderComment(reporter: string, closesAt: Date): string {
  return `@${reporter} a reminder: could you check whether the fix works for you? Close the issue if it does, or reply with what's still wrong. Without an answer we'll close it on ${date(closesAt)}.`;
}

const TIMEOUT_COMMENT = "Closing this since we haven't heard back — reopen it or comment if it's still a problem.";

// ── Discovery ────────────────────────────────────────────────────────

/** Start a check for each finished ticket that owes one. Returns how many were started. */
export async function discoverChecks(now: Date = new Date()): Promise<number> {
  const since = new Date(Math.max(now.getTime() - DISCOVER_WINDOW_DAYS * DAY_MS, DISCOVER_FROM.getTime()));
  const candidates = (await nodeDb.listReporterCheckCandidates(since)).filter((n) => needsReporterCheck(n) && looksDone(n));
  if (candidates.length === 0) return 0;
  const known = await checkDb.checksOf(candidates.map((n) => n.id));
  let started = 0;
  for (const n of candidates) {
    const had = known.get(n.id);
    if (had) {
      // Finished again after its check ended (reopened by hand, by the reporter): a new round.
      const again = had.state === 'done' && had.doneAt && n.completedAt && new Date(n.completedAt) > had.doneAt;
      if (!again) continue;
      await checkDb.deleteCheck(n.id);
    }
    const link = issueLinkOf(n)!;
    // A cheap first signal; the deploy asks the forge for the real merge before anyone is asked.
    if (link.state !== 'closed' && !link.mergeCommitSha) continue;
    if (n.reportedBy?.kind !== 'forge') continue;
    if (await checkDb.insertCheck({ nodeId: n.id, mapId: n.mapId, issueRef: link.externalId, issueUrl: link.url, reporter: n.reportedBy.login })) started++;
  }
  return started;
}

// ── Forge access ─────────────────────────────────────────────────────

interface Target {
  forge: ForgeClient;
  owner: string;
  repo: string;
  number: number;
}

async function targetOf(row: Pick<ReporterCheckRow, 'mapId' | 'issueRef'>): Promise<Target | string> {
  const parsed = parseExternalId(row.issueRef);
  if (!parsed) return `not an issue reference: ${row.issueRef}`;
  const ctx = await getGitHubContextForMap(row.mapId);
  if (!ctx) return 'the map has no issue tracker connected';
  return { forge: ctx.forge, owner: parsed.owner, repo: parsed.repo, number: parsed.issueNumber };
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function setWaitingLabel(t: Target, on: boolean): Promise<void> {
  try {
    if (on) await t.forge.addIssueLabels(t.owner, t.repo, t.number, [WAITING_LABEL]);
    else await t.forge.removeIssueLabel(t.owner, t.repo, t.number, WAITING_LABEL);
  } catch (err) {
    // The label is a convenience for people browsing the issues; the check runs without it.
    console.warn(`[reporter-check] label ${on ? 'add' : 'remove'} failed on ${t.owner}/${t.repo}#${t.number}:`, errText(err));
  }
}

/** The label on the issue and the tag on the node together: the outbound sync pushes labels = tags. */
async function markWaiting(t: Target, nodeId: string, on: boolean): Promise<void> {
  await setWaitingLabel(t, on);
  try {
    await nodeDb.updateNode(nodeId, on ? { tagsAppend: [WAITING_LABEL] } : { tagsRemove: [WAITING_LABEL] });
  } catch (err) {
    console.warn(`[reporter-check] tag ${on ? 'add' : 'remove'} failed on ${nodeId}:`, errText(err));
  }
}

/** The work is back in the queue (rolled off done, reopened by hand): its check is void. */
async function dropIfNotDone(row: ReporterCheckRow): Promise<boolean> {
  const node = await nodeDb.getNode(row.nodeId);
  if (node && looksDone(node)) return false;
  await checkDb.deleteCheck(row.nodeId);
  if (node && row.state !== 'waiting-deploy') {
    const t = await targetOf(row);
    if (typeof t !== 'string') await markWaiting(t, row.nodeId, false);
  }
  return true;
}

// ── Asking (deploy signal) ───────────────────────────────────────────

type AskResult = { kind: 'asked' } | { kind: 'not-landed' } | { kind: 'skipped' } | { kind: 'failed'; error: string };

/**
 * Reopen the issue and ask the reporter — only for work that landed: a
 * merged closing PR on the default branch and none still open. The row is
 * moved first, so a second signal never asks twice.
 */
async function askOne(row: ReporterCheckRow, now: Date): Promise<AskResult> {
  if (await dropIfNotDone(row)) return { kind: 'skipped' };
  const t = await targetOf(row);
  if (typeof t === 'string') return { kind: 'failed', error: t };
  try {
    const probe = await probeIssueLanded(t.owner, t.repo, t.number, t.forge);
    if (!probe.landed || probe.inFlight) return { kind: 'not-landed' };
  } catch (err) {
    return { kind: 'failed', error: `could not check the merge: ${errText(err)}` };
  }
  if (!(await checkDb.updateCheck(row.nodeId, ['waiting-deploy'], { state: 'asked', askedAt: now }))) return { kind: 'skipped' }; // asked elsewhere
  const undo = async (error: string): Promise<AskResult> => {
    await checkDb.updateCheck(row.nodeId, ['asked'], { state: 'waiting-deploy', askedAt: null });
    return { kind: 'failed', error };
  };
  const link = { externalId: row.issueRef };
  try {
    await reopenGitHubIssue(link, t.forge);
  } catch (err) {
    return undo(`reopen failed: ${errText(err)}`);
  }
  try {
    await commentOnGitHubIssue(t.owner, t.repo, t.number, askComment(row.reporter, new Date(now.getTime() + REPORTER_CLOSE_AFTER_DAYS * DAY_MS)), t.forge);
  } catch (err) {
    // Reopened but not asked: the row stays asked (the issue is open), the timer's reminder asks again.
    console.warn(`[reporter-check] ${row.issueRef} reopened, but the question could not be posted:`, errText(err));
  }
  await markWaiting(t, row.nodeId, true);
  await recordEvent({ mapId: row.mapId, nodeId: row.nodeId, userId: null, eventType: 'node.field_changed', fieldName: 'reporter_check', oldValue: 'waiting-deploy', newValue: 'asked' }); // recordEvent swallows its own failures
  return { kind: 'asked' };
}

/**
 * The map was deployed: ask the reporter of every ticket merged before
 * now. Edit on the map is checked by the caller (route guard / backend).
 */
export async function markDeployed(mapId: string, now: Date = new Date()): Promise<DeployedResult> {
  // A ticket that finished since the last tick is part of this deploy too.
  await discoverChecks(now).catch((err) => console.warn('[reporter-check] discovery failed:', errText(err)));
  const out: DeployedResult = { asked: [], notLanded: [], failed: [] };
  for (const row of await checkDb.listOpenChecks([mapId])) {
    if (row.state !== 'waiting-deploy') continue;
    const r = await askOne(row, now);
    const at = { nodeId: row.nodeId, issue: row.issueRef };
    if (r.kind === 'asked') out.asked.push(at);
    else if (r.kind === 'not-landed') out.notLanded.push(at);
    else if (r.kind === 'failed') out.failed.push({ ...at, error: r.error });
  }
  return out;
}

// ── The timer: answers, reminders, timeouts ──────────────────────────

interface IssueComment {
  body?: string | null;
  html_url?: string;
  created_at?: string;
  user?: { login?: string | null } | null;
}

/** The reporter's first comment since they were asked; null when none. */
async function reporterReply(t: Target, row: ReporterCheckRow): Promise<{ at: Date; url: string; excerpt: string } | null> {
  const asked = row.askedAt!;
  const comments = await t.forge.requestJson<IssueComment[]>(
    `/repos/${t.owner}/${t.repo}/issues/${t.number}/comments?since=${encodeURIComponent(asked.toISOString())}&per_page=100`,
  );
  const mine = (comments ?? []).find(
    (c) => c.user?.login?.toLowerCase() === row.reporter.toLowerCase() && c.created_at && new Date(c.created_at) > asked,
  );
  if (!mine) return null;
  const excerpt = (mine.body ?? '').replace(/\s+/g, ' ').trim().slice(0, EXCERPT_CHARS);
  return { at: new Date(mine.created_at!), url: mine.html_url ?? row.issueUrl, excerpt };
}

export interface ReporterCheckTick {
  started: number;
  confirmed: number;
  closed: number;
  replied: number;
  reminded: number;
  timedOut: number;
  errors: string[];
}

/** One pass over the open checks. */
export async function runReporterChecks(now: Date = new Date()): Promise<ReporterCheckTick> {
  const tick: ReporterCheckTick = { started: 0, confirmed: 0, closed: 0, replied: 0, reminded: 0, timedOut: 0, errors: [] };
  try {
    tick.started = await discoverChecks(now);
  } catch (err) {
    tick.errors.push(`discovery: ${errText(err)}`);
  }
  for (const row of await checkDb.listAllOpenChecks()) {
    try {
      if (await dropIfNotDone(row)) continue;
      if (row.state === 'waiting-deploy') continue;
      // A deploy that just moved this row may still be reopening the issue.
      if (row.askedAt && now.getTime() - row.askedAt.getTime() < ASKING_GRACE_MS) continue;
      const t = await targetOf(row);
      if (typeof t === 'string') throw new Error(t);
      const issue = await t.forge.requestJson<{ state?: string }>(`/repos/${t.owner}/${t.repo}/issues/${t.number}`);
      if (issue.state === 'closed') {
        const close = await t.forge.getLatestCloseEvent(t.owner, t.repo, t.number);
        // The reporter closing as completed confirms; not-planned, or anyone else, is a plain close.
        const byReporter = close?.actor?.toLowerCase() === row.reporter.toLowerCase() && close?.stateReason !== 'not_planned';
        if (await checkDb.updateCheck(row.nodeId, ['asked', 'replied'], { state: 'done', outcome: byReporter ? 'confirmed' : 'closed', doneAt: now })) {
          await markWaiting(t, row.nodeId, false);
          if (byReporter) tick.confirmed++;
          else tick.closed++;
        }
        continue;
      }
      if (row.state === 'replied') continue; // a person decides
      const reply = await reporterReply(t, row);
      if (reply) {
        if (await checkDb.updateCheck(row.nodeId, ['asked'], { state: 'replied', replyAt: reply.at, replyUrl: reply.url, replyExcerpt: reply.excerpt })) tick.replied++;
        continue;
      }
      const askedAt = row.askedAt!.getTime();
      const closesAt = new Date(askedAt + REPORTER_CLOSE_AFTER_DAYS * DAY_MS);
      if (now >= closesAt) {
        // Close first: a failed close leaves the row asked and the next tick tries again.
        await t.forge.updateIssue(t.owner, t.repo, t.number, { state: 'closed', state_reason: 'completed' });
        if (await checkDb.updateCheck(row.nodeId, ['asked'], { state: 'done', outcome: 'timeout', doneAt: now })) {
          await commentOnGitHubIssue(t.owner, t.repo, t.number, TIMEOUT_COMMENT, t.forge).catch((err) => tick.errors.push(`${row.issueRef} timeout comment: ${errText(err)}`));
          await markWaiting(t, row.nodeId, false);
          tick.timedOut++;
        }
        continue;
      }
      if (!row.remindedAt && now.getTime() - askedAt >= REPORTER_REMIND_AFTER_DAYS * DAY_MS) {
        if (await checkDb.updateCheck(row.nodeId, ['asked'], { remindedAt: now })) {
          await commentOnGitHubIssue(t.owner, t.repo, t.number, reminderComment(row.reporter, closesAt), t.forge);
          tick.reminded++;
        }
      }
    } catch (err) {
      tick.errors.push(`${row.issueRef}: ${errText(err)}`);
    }
  }
  return tick;
}

// ── The card: list, reopen, close ────────────────────────────────────

/** The open checks in scope, each saying whether the reader may decide. */
export async function listReporterChecks(userId: string, scope: { mapId?: string; fleetId?: string }): Promise<ReporterCheckList | ApprovalError> {
  const inScope = await mapsInScope(userId, scope);
  if ('status' in inScope) return inScope;
  const names = new Map(inScope.map((m) => [m.id, m.name]));
  const rows = await checkDb.listOpenChecks(inScope.map((m) => m.id));
  const mayDecide = new Map<string, boolean>();
  const items: ReporterCheck[] = [];
  for (const r of rows) {
    const node = await nodeDb.getNode(r.nodeId);
    if (!node) continue;
    if (!mayDecide.has(r.mapId)) mayDecide.set(r.mapId, (await approverRefusal(userId, r.mapId)) === null);
    items.push({
      mapId: r.mapId,
      mapName: names.get(r.mapId) ?? '',
      nodeId: r.nodeId,
      title: node.text,
      issue: { ref: r.issueRef, url: r.issueUrl },
      reporter: r.reporter,
      state: r.state,
      outcome: r.outcome,
      createdAt: r.createdAt.toISOString(),
      askedAt: r.askedAt?.toISOString() ?? null,
      remindedAt: r.remindedAt?.toISOString() ?? null,
      closesAt: r.state === 'asked' && r.askedAt ? new Date(r.askedAt.getTime() + REPORTER_CLOSE_AFTER_DAYS * DAY_MS).toISOString() : null,
      reply: r.replyAt && r.replyUrl ? { at: r.replyAt.toISOString(), url: r.replyUrl, excerpt: r.replyExcerpt ?? '' } : null,
      canDecide: mayDecide.get(r.mapId)!,
    });
  }
  items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { items, now: new Date().toISOString() };
}

async function decidableCheck(userId: string, mapId: string, nodeId: string): Promise<{ row: ReporterCheckRow; node: CoreNode } | ApprovalError> {
  const refused = await approverRefusal(userId, mapId);
  if (refused) return refused;
  const row = await checkDb.getCheck(nodeId);
  const node = await nodeDb.getNode(nodeId);
  if (!row || !node || row.mapId !== mapId) return { status: 404, code: 'NOT_FOUND', message: 'No reporter check for this ticket on this map' };
  if (row.state !== 'asked' && row.state !== 'replied') {
    return { status: 409, code: 'NOT_OPEN', message: `This check is ${row.state === 'done' ? 'already done' : 'still waiting for the deploy'}` };
  }
  return { row, node };
}

async function firstName(userId: string): Promise<string> {
  const [me] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId));
  return me?.name.split(/\s+/)[0] || 'a trusted user';
}

export interface CheckOutcome {
  node: CoreNode;
  changedFields: string[];
  writes: Array<{ kind: 'comment' | 'close'; target: string; done: boolean; error?: string }>;
}

/**
 * The fix did not do it: the ticket goes back to the queue with the
 * person's brief on top. The reporter's reply is never copied in — it is
 * untrusted text, and the fleet would follow it.
 */
export async function reopenAfterCheck(userId: string, mapId: string, nodeId: string, input: ReopenAfterCheckInput): Promise<CheckOutcome | ApprovalError> {
  const note = typeof input?.note === 'string' ? input.note.trim() : '';
  if (!note) return { status: 400, code: 'VALIDATION_ERROR', message: "Say what is still wrong — it becomes the ticket's brief" };
  if (note.length > 4000) return { status: 400, code: 'VALIDATION_ERROR', message: 'The note is at most 4000 characters' };
  const found = await decidableCheck(userId, mapId, nodeId);
  if ('status' in found) return found;
  const { row, node } = found;
  // The conditional move is the guard against a second click.
  if (!(await checkDb.updateCheck(row.nodeId, ['asked', 'replied'], { state: 'done', outcome: 'reopened', doneAt: new Date() }))) {
    return { status: 409, code: 'DECIDED_ELSEWHERE', message: 'Someone decided on this in the meantime — reload' };
  }
  const by = await firstName(userId);
  const old = proseMirrorToPlainText(node.description).trim();
  const brief = `Reopened after the reporter's check (${by}, ${date(new Date())}): ${note}`;
  // The first fix's merge evidence goes: the next round must prove its own merge, or the
  // issue would close (and the reporter be asked) as soon as the new PR opens.
  const externalLinks = node.externalLinks.map((l) =>
    l.externalId === row.issueRef && isForgeLink(l) ? { ...l, mergeCommitSha: null, mergedPrNumber: null, closeCheckedForPr: null } : l,
  );
  const updated = await nodeDb.updateNode(node.id, {
    status: 'todo',
    percentComplete: 0,
    description: old ? `${brief}\n\n${old}` : brief,
    tagsRemove: [WAITING_LABEL],
    externalLinks,
    linkedPr: null,
  });
  if (!updated) return { status: 404, code: 'NODE_NOT_FOUND', message: `Node ${node.id} not found` };
  // Then the row goes, so the next finish starts a fresh check.
  await checkDb.deleteCheck(row.nodeId);
  await recordEvent({ mapId, nodeId: node.id, userId, eventType: 'node.field_changed', fieldName: 'reporter_check', oldValue: row.state, newValue: { outcome: 'reopened', note } });
  const writes: CheckOutcome['writes'] = [];
  const t = await targetOf(row);
  if (typeof t !== 'string') {
    await setWaitingLabel(t, false);
    try {
      await commentOnGitHubIssue(t.owner, t.repo, t.number, `Thanks for checking — we're working on it again (${by}).`, t.forge);
      writes.push({ kind: 'comment', target: row.issueRef, done: true });
    } catch (err) {
      writes.push({ kind: 'comment', target: row.issueRef, done: false, error: errText(err) });
    }
  }
  return { node: updated, changedFields: ['status', 'percentComplete', 'description', 'tags'], writes };
}

/** Close the issue without the reporter: they confirmed elsewhere, or a person checked it. */
export async function closeAfterCheck(userId: string, mapId: string, nodeId: string): Promise<CheckOutcome | ApprovalError> {
  const found = await decidableCheck(userId, mapId, nodeId);
  if ('status' in found) return found;
  const { row, node } = found;
  const t = await targetOf(row);
  if (typeof t === 'string') return { status: 409, code: 'NO_ISSUE', message: t };
  // Close first: if the forge refuses, the check stays open and nothing is marked.
  try {
    await t.forge.updateIssue(t.owner, t.repo, t.number, { state: 'closed', state_reason: 'completed' });
  } catch (err) {
    return { node, changedFields: [], writes: [{ kind: 'close', target: row.issueRef, done: false, error: errText(err) }] };
  }
  if (!(await checkDb.updateCheck(row.nodeId, ['asked', 'replied'], { state: 'done', outcome: 'closed', doneAt: new Date() }))) {
    return { status: 409, code: 'DECIDED_ELSEWHERE', message: 'Someone decided on this in the meantime — reload' };
  }
  await recordEvent({ mapId, nodeId: node.id, userId, eventType: 'node.field_changed', fieldName: 'reporter_check', oldValue: row.state, newValue: { outcome: 'closed' } });
  const writes: CheckOutcome['writes'] = [{ kind: 'close', target: row.issueRef, done: true }];
  try {
    await commentOnGitHubIssue(t.owner, t.repo, t.number, `Closing — thanks (${await firstName(userId)}).`, t.forge);
    writes.push({ kind: 'comment', target: row.issueRef, done: true });
  } catch (err) {
    writes.push({ kind: 'comment', target: row.issueRef, done: false, error: errText(err) });
  }
  await markWaiting(t, row.nodeId, false);
  return { node, changedFields: [], writes };
}
