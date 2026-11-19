/**
 * The rows MindBlown adds to the Questions card itself, derived on read:
 *
 *   stalled-<node>  in progress, nobody on it, no change for
 *                   a day, a "Decision:" ticket 2 h (core
 *                   stalledAskAfterHours) — a question
 *   step-<node>     an open ticket carrying a skip tag (needs-human …):
 *                   a step only a person can do (core humanSteps.ts)
 *   blocker-<node>  an open leaf with a manual blockedReason and no skip
 *                   tag — a worker's red CI or merge conflict, a wait
 *                   (core humanSteps.ts)
 *   brief-<node>    a ready ticket inside the gate the pull refuses for
 *                   want of a brief (core dispatchQueueSnapshot)
 *   gate-<map>-<fp> the map has nothing grantable inside its gate while
 *                   ready tickets sit outside it (core gatedOutReady) —
 *                   one decision for the map owner; <fp> fingerprints the
 *                   gated-out set, so an answered row stays answered until
 *                   the set changes
 *   deploy-probe-<map>  a map in a fleet with a repo and no deploy probe:
 *                   "how is <map> deployed?" (core deployProbe.ts) — the
 *                   answer (a URL, or none) is the map's probe, so it is
 *                   asked until answered, once. Not for the repo this
 *                   server runs from: its own checkout says (#645)
 *   question-<node> a blocker whose kind is a question (flag_blocker, or
 *                   an unkinded blocker classified after an hour) — to its
 *                   answerer, default the map owner (core blockerKinds.ts)
 *   external-<node> a wait on a party outside whose re-check date has come
 *   lint-<rule>-<node> a finding the daily self-check (lint/daily.ts) left
 *                   for a person — read from the map's newest run, so it
 *                   stays the same row while the finding stays; a node
 *                   with any other row here gets none (that row is the ask).
 *                   Re-checked live against the node (lintFindingHolds):
 *                   a finding that no longer holds, or a node with any
 *                   other ask answered since the run, shows no row
 *
 * A node in a parked branch (#655, itself or an ancestor parked) gets no
 * stalled, step, blocker, question or external row: it is "later".
 *
 * Nothing is stored while a row is open, so a fleet push (which replaces
 * the open set) cannot wipe it and there is no second list to keep in step:
 * answering writes the node, and the row is gone on the next read. A node
 * a collector's open question already names gets no step row — the
 * question is the thing to answer.
 *
 * Every answer is recorded as an asks row anyway (answered / later /
 * delegated) so the answered fold and the digest show the round, and so
 * Later and Delegate snooze it: an open derived row is hidden while its
 * node has a later/delegated row younger than ANSWER_RETENTION_DAYS.
 *
 * The answers are lint fixes (lint/fix.ts). Stalled: Done = mark-done,
 * Back to the queue = requeue, For a person / free text = needs-human.
 * Step: Done = mark-done, Fleet can do it = to-fleet, free text = a
 * decision (#619): "Decision (by, date): …" in place of the next step and
 * as a comment on the linked issue, then `next` — to-fleet (default),
 * mark-done, or needs-human with the text as the new next step ("Still
 * mine", which writes no decision). A hand-back takes the hold labels
 * (blocked, the skip tags) off the linked issue too. Blocker: Unblocked =
 * clear-blocker, Done = mark-done, free text = needs-human. Brief: Done =
 * mark-done, free text = write-brief. Gate: Version them = the unversioned
 * ones get the map's active version, Widen the gate = the gate's version
 * entries also let in the gated-out tickets' versions, Leave it = nothing.
 */
import {
  buildLintAsk,
  LINT_FIX_ACTIONS,
  lintAnswerAction,
  parseLintAskId,
  buildExternalAsk,
  buildQuestionAsk,
  externalAnswerAction,
  externalAskNodeId,
  externalRecheckAt,
  externalRecheckDue,
  planUnblock,
  prependDecision,
  questionAskNodeId,
  AUTO_CHECK_BY,
  AUTO_CHECK_GRACE_MINUTES,
  autoCheckable,
  isForgeLink,
  namedTickets,
  staleCheckable,
  briefAnswerAction,
  briefAskNodeId,
  buildDeployProbeAsk,
  deployProbeAskMapId,
  deployProbeFromAnswer,
  buildBriefAsk,
  briefFromAnswer,
  dispatchQueueSnapshot,
  buildGateAsk,
  defaultVersionForNewLeaf,
  gateAnswerAction,
  gateAskMapId,
  gatedOutReady,
  effectiveVersionId,
  gateVersionIds,
  parseGateEntry,
  GATE_VERSION_PREFIX,
  GATE_OR,
  blockerAnswerAction,
  blockerAnswerText,
  blockerFleetAction,
  FLEET_CHECK_TAG,
  blockerAskNodeId,
  buildBlockerAsk,
  buildIsDonePredicate,
  buildStalledAsk,
  buildStepAsk,
  BLOCKED_TAG,
  decisionCommentBody,
  decisionLine,
  derivedAskNodeId,
  DISPATCH_SKIP_TAGS,
  dispatchSkipTag,
  isDispatchSkipTag,
  isOrphanRequeueable,
  isStalledAskDue,
  planAskWrites,
  stalledAskAfterHours,
  stalledAnswerAction,
  stalledAnswerNote,
  stalledAskNodeId,
  STEP_ASK_OPTIONS,
  stepAnswerText,
  stepAnswerAction,
  stepAskNodeId,
  lintDailyOptedIn,
  isUnkindedBlocker,
  parkedNodeIds,
} from '@mindblown/core';
import type { AskAnswerInput, AskRow, AskWrite, LintActionId, LintRun, LintRunAsk, MindMap, Node as CoreNode, Version } from '@mindblown/core';
import { commentOnGitHubIssue } from '@mindblown/integrations';
import * as asksDb from '../db/asks.js';
import * as lintRunsDb from '../db/lintRuns.js';
import * as mapDb from '../db/maps.js';
import * as nodeDb from '../db/nodes.js';
import * as versionDb from '../db/versions.js';
import { recordFieldChanges } from '../db/events.js';
import { broadcast } from '../ws.js';
import { getGitHubContextForMap } from '../lib/githubContext.js';
import { stalledForMap } from '../lib/stalled.js';
import { applyLintFix, issueLinkOf } from '../lint/fix.js';
import { AskNotFoundError, AskValidationError, type AnswerAskOutcome } from './asks.js';
import { removeIssueLabels } from './issueLabels.js';
import { latestDeployDrift } from './deployDrift.js';
import { syncNodeToGitHub } from '../routes/nodes.js';
import { mapOwnerAnswerer } from './flagBlocker.js';
import { briefRowState } from './briefDrafts.js';

const rowKey = (r: { mapId?: string | null; ask: { id: string } }) => `${r.mapId ?? ''}|${r.ask.id}`;

function openRow(ask: AskRow['ask'], mapId: string, now: Date, firstSeenAt: string): AskRow {
  return {
    ask,
    mapId,
    status: 'open',
    pushedAt: now.toISOString(),
    firstSeenAt,
    answer: null,
    answeredBy: null,
    answeredAt: null,
    writes: [],
    workerPending: false,
  };
}

/** The derived rows of these maps. A map whose change log can't be read still gets its steps. */
export async function derivedAskRows(mapIds: string[], now: Date = new Date()): Promise<AskRow[]> {
  const out: AskRow[] = [];
  // The daily check's asks; a failed read only drops them, not the rest.
  const lintRuns = await lintRunsDb.latestRuns(mapIds).catch((err) => {
    console.warn(`[asks] daily check runs unreadable, lint asks skipped: ${err instanceof Error ? err.message : String(err)}`);
    return new Map<string, LintRun>();
  });
  for (const mapId of mapIds) {
    const data = await mapDb.getMap(mapId);
    if (!data || data.map.archivedAt) continue;
    const mapStart = out.length;
    const byId = new Map(data.nodes.map((n) => [n.id, n]));
    // A parked branch (#655) is "later": no step, stalled or blocker row on it
    // or below it — the same hold the dispatch snapshot applies (PARKED_HOLD_TAG).
    const parked = parkedNodeIds(data.nodes);

    const stalled = await stalledForMap(data.map, data.nodes, now).catch(() => []);
    for (const s of stalled) {
      const node = byId.get(s.nodeId);
      if (!node || parked.has(node.id) || !isStalledAskDue(s, now, node.text)) continue;
      const seen = new Date(Date.parse(s.lastChangeAt) + stalledAskAfterHours(node.text) * 3_600_000).toISOString();
      out.push(openRow(buildStalledAsk(node, s, mapId, now), mapId, now, seen));
    }

    const isDone = buildIsDonePredicate(data.map.statusWorkflow ?? []);
    let owner: string | null = null;
    const answerer = async () => (owner ??= await mapOwnerAnswerer(data.map));
    for (const node of data.nodes) {
      if (isDone(node.status) || (node.childrenIds.length === 0 && (node.percentComplete ?? 0) >= 100)) continue;
      if (parked.has(node.id)) continue;
      const kind = node.blockedReason?.trim() ? node.blockerInfo?.kind : undefined;
      if (dispatchSkipTag(node) !== null) out.push(openRow(buildStepAsk(node, mapId), mapId, now, node.updatedAt));
      // A blocker with a kind reaches its person as a question — on a parent too.
      else if (kind === 'question') out.push(openRow(buildQuestionAsk(node, mapId, await answerer()), mapId, now, node.blockedAt ?? node.updatedAt));
      // An external wait is asked about again once its re-check date has come; until then nothing to do.
      else if (kind === 'external') {
        if (externalRecheckDue(node.blockerInfo, now)) out.push(openRow(buildExternalAsk(node, mapId, await answerer()), mapId, now, node.blockerInfo?.recheckAt ?? node.updatedAt));
      }
      // fleet-check: the fleet has it already, nothing for a person until it reports back.
      else if (node.childrenIds.length === 0 && node.blockedReason?.trim() && !node.tags.includes(FLEET_CHECK_TAG)) out.push(openRow(buildBlockerAsk(node, mapId), mapId, now, node.updatedAt));
    }

    // Held tickets are out of this set already — they have their step or
    // blocker row. A map on hold (cap 0) pulls nothing, so nothing waits on a brief.
    const cap = data.map.maxActiveClaims ?? 0;
    const queue = cap > 0 ? dispatchQueueSnapshot(data.nodes, { workflow: data.map.statusWorkflow ?? [], cap, gate: data.map.dispatchGate ?? [] }) : null;
    // While the AI drafts briefs for this map, a person is asked only when it
    // could not write one — with its question (services/briefDrafts).
    const briefless = (queue?.needsBriefIds ?? []).map((id) => byId.get(id)).filter((n): n is CoreNode => !!n);
    const briefState = await briefRowState(data.map, briefless).catch(() => null);
    for (const node of briefless) {
      const state = briefState?.get(node.id) ?? { ask: true as const, question: null };
      if (state.ask) out.push(openRow(buildBriefAsk(node, mapId, state.question), mapId, now, node.updatedAt));
    }

    // The daily check's findings for a person — one row per finding, none
    // for a node that already has a row above (that row is its question).
    // Only while the map is opted in: a map that switched every rule off
    // (or never opted in) keeps no lint asks from an old run.
    const run = lintDailyOptedIn(data.map.lintAutoFix) ? lintRuns.get(mapId) : undefined;
    if (run && run.asked.length > 0) {
      const covered = new Set(out.slice(mapStart).map((r) => r.ask.unblocks.node_id));
      const seen = new Set<string>();
      const stalledIds = new Set(stalled.map((s) => s.nodeId));
      for (const a of run.asked) {
        const id = `${a.ruleId}|${a.nodeId}`;
        if (!byId.has(a.nodeId) || covered.has(a.nodeId) || seen.has(id)) continue;
        // The run is from this morning: show the finding only while it still holds.
        if (!lintFindingHolds(a, byId.get(a.nodeId)!, isDone, stalledIds)) continue;
        seen.add(id);
        // pushedAt = the run that found it: an answer on the node after that settles it (openDerivedAsks).
        out.push({ ...openRow(buildLintAsk(a, mapId, await answerer(), now), mapId, now, a.firstSeenAt), pushedAt: run.ranAt });
      }
    }

    // The fleet is idle on this map (nothing grantable, a free slot) while
    // ready work sits outside the gate — "empty" must not read as "nothing to do".
    if (queue?.state === 'empty') {
      const gate = await gateRow(data.map, data.nodes, mapId, now).catch(() => null);
      if (gate) out.push(gate);
    }

    // The fleet merges into the repo; nothing says whether it goes live.
    const own = latestDeployDrift()?.repo?.toLowerCase();
    const repo = data.map.githubRepoOwner && data.map.githubRepoName ? `${data.map.githubRepoOwner}/${data.map.githubRepoName}`.toLowerCase() : null;
    if (!data.map.deployProbe && data.map.fleetId && repo && repo !== own) {
      out.push(openRow(buildDeployProbeAsk(data.map, 'Dan'), mapId, now, data.map.createdAt));
    }
  }
  return out;
}

/**
 * Whether a stored daily-check finding still holds for the node as it is
 * now — the rule's cheap per-node condition (lint/engine.ts), re-checked
 * live so an answer or edit since the run drops the row without a new run.
 * Rules with no per-node condition (map-level, forge-backed) keep the run's word.
 */
function lintFindingHolds(a: LintRunAsk, node: CoreNode, isDone: (status: string | null) => boolean, stalledIds: Set<string>): boolean {
  const done = isDone(node.status);
  const leaf = node.childrenIds.length === 0;
  const pct = node.percentComplete ?? 0;
  switch (a.ruleId) {
    case 'blocker-without-question':
      return isUnkindedBlocker(node) && !done;
    case 'stale-blocked-reason':
      return (node.blockedReason ?? '').trim() !== '' && done;
    case 'status-progress-mismatch':
      return leaf && ((done && pct < 100) || (pct >= 100 && node.status != null && !done));
    case 'done-parent-open-child':
      return !leaf && done;
    case 'stalled-unclaimed':
      return stalledIds.has(node.id);
    case 'issue-state-mismatch': {
      const link = (node.externalLinks ?? []).find((l) => isForgeLink(l) && !l.isPullRequest && l.state != null);
      return !!link && ((done && link.state === 'open') || (!done && link.state === 'closed'));
    }
    default:
      return true;
  }
}

/** The gate row of a map, or null when no ready ticket is outside its gate. */
async function gateRow(map: MindMap, nodes: CoreNode[], mapId: string, now: Date): Promise<AskRow | null> {
  const gated = gatedOutReady(nodes, { workflow: map.statusWorkflow ?? [], gate: map.dispatchGate ?? [] });
  if (gated.ids.length === 0) return null;
  const versions = await versionDb.listVersions(mapId);
  const names = new Map(versions.map((v) => [v.id, v.name]));
  const ask = buildGateAsk(map, gated, {
    versionName: (id) => names.get(id) ?? id.slice(0, 8),
    activeVersion: activeVersionOf(versions)?.name ?? null,
    answerer: await mapOwnerAnswerer(map),
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const latest = gated.ids.map((id) => byId.get(id)?.updatedAt ?? '').sort().pop() || now.toISOString();
  return openRow(ask, mapId, now, latest);
}

/** The map's active version — the first by sort order when several are. */
function activeVersionOf(versions: Version[]): Version | null {
  return defaultVersionForNewLeaf([`${GATE_VERSION_PREFIX}any`], versions);
}

/** The scope's open derived rows: minus snoozed ones, minus steps a collector's open question already covers. */
export async function openDerivedAsks(scope: asksDb.AskScope, mapIds: string[], now: Date = new Date()): Promise<AskRow[]> {
  const derived = await derivedAskRows(mapIds, now);
  if (derived.length === 0) return derived;
  const stored = await asksDb.listAsks(scope, { status: 'all' });
  const { snoozed, asked } = storedFilters(stored, now);
  // A daily-check finding answered once stays answered while it reads the
  // same — "Leave it" must not bring it back with tomorrow's run.
  const settled = new Set(
    stored.filter((r) => r.status === 'answered' && parseLintAskId(r.ask.id)).map((r) => `${rowKey(r)}|${r.ask.question}`),
  );
  // A gate row answered for this gated-out set stays answered until the set changes (its id).
  const answered = new Set(stored.filter((r) => r.status !== 'open' && gateAskMapId(r.ask.id)).map(rowKey));
  // Any other ask on the node answered since the run that found a lint
  // finding settles that finding too: the person has looked at the node.
  const nodeAnsweredAt = new Map<string, number>();
  for (const r of stored) {
    const nodeId = r.ask.unblocks?.node_id;
    if (r.status !== 'answered' || !r.answeredAt || !nodeId || parseLintAskId(r.ask.id)) continue;
    const k = `${r.mapId ?? ''}|${nodeId}`;
    nodeAnsweredAt.set(k, Math.max(nodeAnsweredAt.get(k) ?? 0, Date.parse(r.answeredAt)));
  }
  const answeredSinceRun = (r: AskRow) =>
    !!parseLintAskId(r.ask.id) && (nodeAnsweredAt.get(`${r.mapId ?? ''}|${r.ask.unblocks.node_id}`) ?? 0) >= Date.parse(r.pushedAt);
  return derived.filter(
    (r) =>
      !snoozed.has(rowKey(r)) &&
      !asked(r) &&
      !answered.has(rowKey(r)) &&
      !settled.has(`${rowKey(r)}|${r.ask.question}`) &&
      !answeredSinceRun(r),
  );
}

/** Rows snoozed by Later / Delegate, and whether a collector's open question already covers a derived row's node. */
function storedFilters(stored: AskRow[], now: Date): { snoozed: Set<string>; asked: (r: AskRow) => boolean } {
  const cutoff = now.getTime() - asksDb.ANSWER_RETENTION_DAYS * 86_400_000;
  const snoozed = new Set(
    stored
      .filter((r) => (r.status === 'later' || r.status === 'delegated') && r.answeredAt && Date.parse(r.answeredAt) >= cutoff)
      .map(rowKey),
  );
  const open = new Set(stored.filter((r) => r.status === 'open' && r.ask.unblocks?.node_id).map((r) => `${r.mapId ?? ''}|${r.ask.unblocks.node_id}`));
  const asked = (r: AskRow) =>
    !!derivedAskNodeId(r.ask.id) && open.has(`${r.mapId ?? ''}|${r.ask.unblocks.node_id}`);
  return { snoozed, asked };
}

/**
 * Which fix an answer runs, the note it carries, whether the text is a
 * decision, and that text — an answer that starts with an option runs the
 * option and its rest is the decision ("Fleet can fix it — rebase on main").
 */
function plannedFix(
  ask: AskRow['ask'],
  input: AskAnswerInput,
  decision: string,
): { action: LintActionId; note: string | undefined; decided: boolean; text: string } | null {
  const askId = ask.id;
  const lint = parseLintAskId(askId);
  if (lint) {
    // An option runs its fix; "Leave it" (or text the rule has no fix for) is recorded only.
    const fix = lintAnswerAction(LINT_FIX_ACTIONS[lint.ruleId] ?? [], decision);
    return fix ? { action: fix.action, note: fix.note, decided: false, text: decision } : null;
  }
  if (stalledAskNodeId(askId)) return { action: stalledAnswerAction(decision), note: stalledAnswerNote(decision) ?? undefined, decided: false, text: decision };
  if (briefAskNodeId(askId)) {
    const brief = briefAnswerAction(decision);
    return { action: brief, note: brief === 'write-brief' ? briefFromAnswer(ask, decision) : undefined, decided: false, text: decision };
  }
  if (stepAskNodeId(askId)) {
    // noRequeue (answer_ask's "a human step still precedes the fleet") keeps the step.
    const next = input.next ?? (input.noRequeue ? 'mine' : 'fleet');
    const action = stepAnswerAction(decision, next);
    const text = stepAnswerText(decision);
    return { action, note: action === 'needs-human' && text ? text : undefined, decided: !!text && action !== 'needs-human', text };
  }
  let action: LintActionId = blockerAnswerAction(decision);
  if (action === 'fleet-fix') action = blockerFleetAction(ask);
  if (action === 'needs-human') {
    const isOption = STEP_ASK_OPTIONS.some((o) => o.toLowerCase() === decision.toLowerCase());
    return { action, note: !isOption && decision ? decision : undefined, decided: false, text: decision };
  }
  const text = blockerAnswerText(decision);
  return { action, note: undefined, decided: !!text, text };
}

/** Labels a hand-back takes off the linked issue: the hold the node just left. */
const HOLD_LABELS = [BLOCKED_TAG, ...DISPATCH_SKIP_TAGS];

/**
 * The linked issue's side of a step answer (#619): the decision as a
 * comment, the way a collector ask's answer is posted, and on a hand-back
 * the hold labels off — the outbound sync rewrites labels only on a link
 * with sync on, so on 12.11.2026 they stayed after the node was released.
 */
async function stepIssueWrites(
  mapId: string,
  node: CoreNode,
  opts: { comment: string | null; line: string | null; dropLabels: boolean; heldTags?: string[] },
  writes: AskWrite[],
): Promise<void> {
  if (!opts.comment && !opts.dropLabels) return;
  const link = issueLinkOf({ externalLinks: node.externalLinks ?? [] });
  const num = link ? Number(/#(\d+)$/.exec(link.externalId)?.[1]) : NaN;
  if (!link || !Number.isInteger(num)) return;
  const target = `#${num}`;
  const ctx = await getGitHubContextForMap(mapId).catch(() => null);
  if (opts.comment) {
    const w: AskWrite = { kind: 'gh-comment', target, detail: opts.line ?? '', done: false };
    writes.push(w);
    if (!ctx) w.error = 'map has no issue tracker connected — comment not posted';
    else {
      try {
        await commentOnGitHubIssue(ctx.owner, ctx.repo, num, opts.comment, ctx.forge);
        w.done = true;
      } catch (err) {
        w.error = err instanceof Error ? err.message : String(err);
      }
    }
  }
  // The node's own needs-<person> tags (read before the answer took them off) are hold labels too.
  const labels = [...new Set([...HOLD_LABELS, ...(opts.heldTags ?? []).filter(isDispatchSkipTag)])];
  if (opts.dropLabels && ctx) writes.push(await removeIssueLabels(ctx, num, labels));
}

/**
 * Answer a derived row (stalled question or step). The row must still be
 * there — a node claimed, changed, finished or untagged since has nothing
 * left to answer.
 */
export async function answerDerivedAsk(key: asksDb.AskKey, input: AskAnswerInput, userId: string | null): Promise<AnswerAskOutcome> {
  if (gateAskMapId(key.askId)) return answerGateAsk(key, input, userId);
  if (deployProbeAskMapId(key.askId)) return answerDeployProbeAsk(key, input, userId);
  const nodeId = derivedAskNodeId(key.askId);
  if (!nodeId || !key.mapId) throw new AskNotFoundError(key.askId);
  const now = new Date();
  const [row] = (await derivedAskRows([key.mapId], now)).filter((r) => r.ask.id === key.askId);
  if (!row) throw new AskNotFoundError(key.askId);

  const by = input.by?.trim() || 'Dan';
  const answer: AskAnswerInput = { ...input, by };
  const date = now.toISOString().slice(0, 10);
  const writes: AskWrite[] = [];
  let node: AnswerAskOutcome['node'] = null;
  let changedFields: string[] = [];

  if (input.action === 'answered' && (questionAskNodeId(key.askId) || externalAskNodeId(key.askId))) {
    const decision = (input.decision ?? '').trim();
    const out = await answerBlockerQuestion(key.mapId, nodeId, key.askId, { by, decision, date, now }, userId, writes);
    node = out.node;
    changedFields = out.changedFields;
  } else if (input.action === 'answered' && !plannedFix(row.ask, input, (input.decision ?? '').trim())) {
    // A daily-check finding answered "Leave it": recorded, nothing written.
    writes.push({ kind: 'ledger-only', target: row.ask.id, detail: (input.decision ?? '').trim() || 'answered', done: true });
  } else if (input.action === 'answered') {
    const decision = (input.decision ?? '').trim();
    const { action, note, decided, text } = plannedFix(row.ask, input, decision)!;
    const line = decisionLine(by, text || decision, date);
    const w: AskWrite = { kind: 'mb-put', target: nodeId.slice(0, 8), detail: `${action} — ${line}`, done: false };
    writes.push(w);
    const heldTags = stepAskNodeId(key.askId) ? ((await nodeDb.getNode(nodeId).catch(() => null))?.tags ?? []) : [];
    try {
      const out = await applyLintFix(key.mapId, nodeId, action, userId, decided ? { note, decision: line } : { note });
      node = out.node;
      changedFields = out.changedFields;
      w.done = true;
      if (out.labelWrite) writes.push(out.labelWrite);
    } catch (err) {
      w.error = err instanceof Error ? err.message : String(err);
    }
    if (node && (stepAskNodeId(key.askId) || (blockerAskNodeId(key.askId) && decided))) {
      await stepIssueWrites(
        key.mapId,
        node,
        { comment: decided ? decisionCommentBody(by, text, date) : null, line, dropLabels: action === 'to-fleet', heldTags },
        writes,
      );
    }
  } else {
    writes.push({ kind: 'ledger-only', target: row.ask.id, detail: input.action + (input.delegateTo ? ` → ${input.delegateTo}` : ''), done: true });
  }

  const status = input.action === 'answered' ? 'answered' : input.action === 'later' ? 'later' : 'delegated';
  const saved = await asksDb.recordAnswer(key, row.ask, { status, answer, answeredBy: by, answeredAt: now, writes, workerPending: false });
  return { row: saved, plan: planAskWrites(row.ask, answer, null, date), ok: writes.every((w) => w.done), node, changedFields };
}

/**
 * Answer a gate row. Version them: every unversioned gated-out ticket gets
 * the map's active version. Widen the gate: each gate entry that names a
 * version also lets in the gated-out tickets' versions (`|version:<id>`).
 * Leave it, Later, Delegate: nothing written. Every answer is recorded, so
 * the row stays answered until the gated-out set changes.
 */
async function answerGateAsk(key: asksDb.AskKey, input: AskAnswerInput, userId: string | null): Promise<AnswerAskOutcome> {
  const mapId = gateAskMapId(key.askId);
  if (!mapId || key.mapId !== mapId) throw new AskNotFoundError(key.askId);
  const now = new Date();
  const [row] = (await derivedAskRows([mapId], now)).filter((r) => r.ask.id === key.askId);
  if (!row) throw new AskNotFoundError(key.askId);

  const by = input.by?.trim() || 'Dan';
  const answer: AskAnswerInput = { ...input, by };
  const date = now.toISOString().slice(0, 10);
  const writes: AskWrite[] = [];
  const decision = (input.decision ?? '').trim();
  const action = input.action === 'answered' ? gateAnswerAction(decision) : null;

  if (action === 'version-them' || action === 'widen-gate') {
    const data = await mapDb.getMap(mapId);
    if (!data) throw new AskNotFoundError(key.askId);
    const gated = gatedOutReady(data.nodes, { workflow: data.map.statusWorkflow ?? [], gate: data.map.dispatchGate ?? [] });
    if (action === 'version-them') await versionGatedOut(mapId, data.nodes, gated.ids, userId, writes);
    else await widenGate(data.map, Object.keys(gated.byVersion), userId, writes);
  } else {
    writes.push({ kind: 'ledger-only', target: row.ask.id, detail: (action ?? input.action) + (input.delegateTo ? ` → ${input.delegateTo}` : ''), done: true });
  }

  const status = input.action === 'answered' ? 'answered' : input.action === 'later' ? 'later' : 'delegated';
  const saved = await asksDb.recordAnswer(key, row.ask, { status, answer, answeredBy: by, answeredAt: now, writes, workerPending: false });
  return { row: saved, plan: planAskWrites(row.ask, answer, null, date), ok: writes.every((w) => w.done), node: null, changedFields: [] };
}

/** Version them: the unversioned gated-out tickets get the active version, like an edit by hand. */
async function versionGatedOut(mapId: string, nodes: CoreNode[], ids: string[], userId: string | null, writes: AskWrite[]): Promise<void> {
  const active = activeVersionOf(await versionDb.listVersions(mapId));
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const unversioned = ids.filter((id) => effectiveVersionId(id, nodeMap) === null);
  if (!active || unversioned.length === 0) {
    writes.push({
      kind: 'mb-put',
      target: mapId.slice(0, 8),
      detail: 'version them',
      done: false,
      error: !active ? 'the map has no active version — set one in Versions, or widen the gate' : 'no unversioned ticket outside the gate — widen the gate for the versioned ones',
    });
    return;
  }
  for (const id of unversioned) {
    const before = nodeMap.get(id)!;
    const w: AskWrite = { kind: 'mb-put', target: id.slice(0, 8), detail: `version → ${active.name}`, done: false };
    writes.push(w);
    try {
      const updated = await nodeDb.updateNode(id, { versionId: active.id });
      if (!updated) throw new Error('node vanished');
      await recordFieldChanges(mapId, id, userId, before, updated).catch(() => {});
      broadcast(mapId, { type: 'node:updated', nodeId: id, fields: ['versionId'], node: updated });
      w.done = true;
    } catch (err) {
      w.error = err instanceof Error ? err.message : String(err);
    }
  }
}

/** Widen the gate: each entry that names a version ORs in the gated-out tickets' versions. */
async function widenGate(map: MindMap, versionIds: string[], userId: string | null, writes: AskWrite[]): Promise<void> {
  const gate = map.dispatchGate ?? [];
  const w: AskWrite = { kind: 'mb-put', target: map.id.slice(0, 8), detail: 'dispatchGate', done: false };
  writes.push(w);
  const next = gate.map((entry) => {
    const named = gateVersionIds([entry]);
    if (named.length === 0 || parseGateEntry(entry).kind === 'unknown') return entry;
    const add = versionIds.filter((v) => !named.includes(v)).map((v) => GATE_VERSION_PREFIX + v);
    return add.length === 0 ? entry : [entry, ...add].join(GATE_OR);
  });
  if (versionIds.length === 0 || next.every((e, i) => e === gate[i])) {
    w.error = versionIds.length === 0
      ? 'the tickets outside the gate have no version — version them instead'
      : 'the gate names no version to widen — edit it in the Fleet tab';
    return;
  }
  try {
    const updated = await mapDb.updateMap(map.id, { dispatchGate: next }, userId);
    if (!updated) throw new Error('map vanished');
    broadcast(map.id, { type: 'map:updated', map: updated });
    w.detail = `dispatchGate → ${next.join(', ')}`;
    w.done = true;
  } catch (err) {
    w.error = err instanceof Error ? err.message : String(err);
  }
}

/**
 * "How is <map> deployed?": a URL becomes the map's deploy probe, "none"
 * says it is not deployed — either way the question is gone for good. Any
 * other text is refused (nothing to store), so the row stays open.
 */
async function answerDeployProbeAsk(key: asksDb.AskKey, input: AskAnswerInput, userId: string | null): Promise<AnswerAskOutcome> {
  const mapId = deployProbeAskMapId(key.askId);
  if (!mapId || mapId !== key.mapId) throw new AskNotFoundError(key.askId);
  const now = new Date();
  const [row] = (await derivedAskRows([mapId], now)).filter((r) => r.ask.id === key.askId);
  if (!row) throw new AskNotFoundError(key.askId);
  const by = input.by?.trim() || 'Dan';
  const answer: AskAnswerInput = { ...input, by };
  const writes: AskWrite[] = [];
  if (input.action === 'answered') {
    const probe = deployProbeFromAnswer(input.decision ?? '');
    if (!probe) throw new AskValidationError('answer with the probe URL (it returns the deployed commit) or "none"');
    const w: AskWrite = { kind: 'mb-put', target: 'map', detail: `deployProbe → ${probe}`, done: false };
    writes.push(w);
    try {
      if (!(await mapDb.updateMap(mapId, { deployProbe: probe }, userId))) w.error = 'map not found';
      else w.done = true;
    } catch (err) {
      w.error = err instanceof Error ? err.message : String(err);
    }
  } else {
    writes.push({ kind: 'ledger-only', target: row.ask.id, detail: input.action + (input.delegateTo ? ` → ${input.delegateTo}` : ''), done: true });
  }
  const status = input.action === 'answered' ? 'answered' : input.action === 'later' ? 'later' : 'delegated';
  const saved = await asksDb.recordAnswer(key, row.ask, { status, answer, answeredBy: by, answeredAt: now, writes, workerPending: false });
  return { row: saved, plan: planAskWrites(row.ask, answer, null, now.toISOString().slice(0, 10)), ok: writes.every((w) => w.done), node: null, changedFields: [] };
}

/**
 * The answer to a blocker question or an external re-check, written like a
 * collector ask's answer (services/asks.ts): the decision on top of the
 * description and as a comment on the linked issue, blocker and `blocked`
 * tag off, status back to todo unless done or claimed (core planUnblock).
 * An external wait answered "Still waiting" keeps its blocker and is asked
 * again EXTERNAL_RECHECK_DAYS later; "Unblocked" lifts it without a decision.
 */
async function answerBlockerQuestion(
  mapId: string,
  nodeId: string,
  askId: string,
  a: { by: string; decision: string; date: string; now: Date },
  userId: string | null,
  writes: AskWrite[],
): Promise<{ node: CoreNode | null; changedFields: string[] }> {
  const action = externalAskNodeId(askId) ? externalAnswerAction(a.decision) : 'decision';
  const line = decisionLine(a.by, a.decision, a.date);
  const w: AskWrite = { kind: 'mb-put', target: nodeId.slice(0, 8), detail: action === 'decision' ? `clear-blocker — ${line}` : action, done: false };
  writes.push(w);
  try {
    if (action === 'clear-blocker') {
      const out = await applyLintFix(mapId, nodeId, 'clear-blocker', userId);
      w.done = true;
      if (out.labelWrite) writes.push(out.labelWrite);
      return { node: out.node, changedFields: out.changedFields };
    }
    const before = await nodeDb.getNode(nodeId);
    if (!before || before.mapId !== mapId) throw new Error('node not found on this map');
    let patch: nodeDb.UpdateNodeInput;
    let changedFields: string[];
    if (action === 'still-waiting') {
      patch = { blockerInfo: { ...(before.blockerInfo ?? { kind: 'external' }), kind: 'external', recheckAt: externalRecheckAt(a.now) } };
      changedFields = ['blockerInfo'];
    } else {
      const unblock = planUnblock(before, (await mapDb.getStatusWorkflow(mapId)) ?? []);
      patch = { blockedReason: null, description: prependDecision(before.description, line) as nodeDb.UpdateNodeInput['description'] };
      changedFields = ['blockedReason', 'description'];
      if (unblock.tagsRemove.length > 0) {
        patch.tagsRemove = unblock.tagsRemove;
        changedFields.push('tags');
      }
      if (unblock.status !== undefined) {
        patch.status = unblock.status;
        changedFields.push('status');
      }
    }
    const updated = await nodeDb.updateNode(nodeId, patch);
    if (!updated) throw new Error('node vanished during update');
    await recordFieldChanges(mapId, nodeId, userId, before, updated).catch(() => {});
    broadcast(mapId, { type: 'node:updated', nodeId, fields: changedFields, node: updated });
    syncNodeToGitHub(updated, changedFields).catch(() => {});
    w.done = true;
    if (action === 'decision') {
      await stepIssueWrites(mapId, updated, { comment: decisionCommentBody(a.by, a.decision, a.date), line, dropLabels: changedFields.includes('tags') }, writes);
    }
    return { node: updated, changedFields };
  } catch (err) {
    w.error = err instanceof Error ? err.message : String(err);
    return { node: null, changedFields: [] };
  }
}

/** What "Let the fleet check all blockers" did. */
export interface FleetCheckOutcome {
  /** Blocker rows handed to the fleet, by fix: a held PR reworked, or a check run from the queue. */
  sent: Array<{ askId: string; mapId: string; action: 'fleet-fix' | 'fleet-check' }>;
  /** Rows whose fix failed, with why. */
  failed: Array<{ askId: string; mapId: string; error: string }>;
}

/**
 * Every open blocker row of these maps answered "Fleet can fix it" — rows
 * a collector's open question covers are not in the set (openDerivedAsks),
 * steps and stalled rows are a person's call and stay. The caller checked
 * edit on each map; every answer is recorded like a click.
 */
export async function sendBlockersToFleet(scope: asksDb.AskScope, mapIds: string[], userId: string | null, by: string): Promise<FleetCheckOutcome> {
  const rows = (await openDerivedAsks(scope, mapIds)).filter((r) => blockerAskNodeId(r.ask.id) !== null && r.mapId);
  return answerFleetCanFix(scope, rows, userId, by);
}

/**
 * The automatic check (fleet autoCheckBlockers): the same answer as "Let the
 * fleet check all", for fewer rows, each one that has sat
 * AUTO_CHECK_GRACE_MINUTES so a person can answer first —
 *
 *   - a fleet worker's give-up (core autoCheckable): never a person's
 *     blocker, a note on the worker's PR, or its agent's question. Once per
 *     ticket: when the check run gives up again, the row's last answer is
 *     still ours and the blocker stays with a person. A person's answer on
 *     the row replaces it and re-arms the check; otherwise it is pruned
 *     ANSWER_RETENTION_DAYS later. A check whose write failed does not count.
 *   - a stale one (core staleCheckable — its agent's question included): it
 *     names tickets ("#494"), every one MindBlown knows is done now, and one
 *     of them finished after the blocker's last change and after our last
 *     check. #493 on 29.10.2026 asked whether to wait for #494, which merged
 *     18 minutes later; nothing looked again. One more check per ticket
 *     finished, so it cannot loop. A collector's open question on the node
 *     does not hold it back: that question is the stale one.
 */
export async function autoCheckBlockers(scope: asksDb.AskScope, mapIds: string[], userId: string | null, now: Date = new Date()): Promise<FleetCheckOutcome> {
  const due = now.getTime() - AUTO_CHECK_GRACE_MINUTES * 60_000;
  const rows = (await derivedAskRows(mapIds, now)).filter((r) => blockerAskNodeId(r.ask.id) !== null && r.mapId && Date.parse(r.firstSeenAt) <= due);
  if (rows.length === 0) return { sent: [], failed: [] };
  const stored = await asksDb.listAsks(scope, { status: 'all' });
  const { snoozed, asked } = storedFilters(stored, now);
  const lastOurs = new Map(
    stored
      .filter((r) => r.status === 'answered' && r.answeredBy === AUTO_CHECK_BY && r.answeredAt && blockerAskNodeId(r.ask.id) !== null && r.writes.every((w) => w.done))
      .map((r) => [rowKey(r), Date.parse(r.answeredAt!)]),
  );
  const tickets = new Map<string, Promise<Map<number, TicketState>>>();
  const send: AskRow[] = [];
  for (const r of rows) {
    if (snoozed.has(rowKey(r))) continue;
    const ours = lastOurs.get(rowKey(r));
    if (ours === undefined && autoCheckable(r.ask) && !asked(r)) {
      send.push(r);
      continue;
    }
    if (!staleCheckable(r.ask)) continue;
    if (!tickets.has(r.mapId!)) tickets.set(r.mapId!, ticketsOf(r.mapId!));
    const byNumber = await tickets.get(r.mapId!)!;
    const named = namedTickets(r.ask).map((n) => byNumber.get(n)).filter((t): t is TicketState => !!t && t.nodeId !== r.ask.unblocks.node_id);
    const since = Math.max(Date.parse(r.firstSeenAt), ours ?? 0);
    if (named.length > 0 && named.every((t) => t.done) && named.some((t) => t.doneAt !== null && t.doneAt > since)) send.push(r);
  }
  return answerFleetCanFix(scope, send, userId, AUTO_CHECK_BY);
}

/** What the orphan requeue did. */
export interface OrphanRequeueOutcome {
  requeued: Array<{ askId: string; mapId: string }>;
  failed: Array<{ askId: string; mapId: string; error: string }>;
}

/**
 * Orphaned "in progress" back to the queue (with the auto-check, same
 * switch, same owner): a stalled leaf a worker held — no claim, no
 * blocker, no skip tag, no change for STALLED_AFTER_HOURS (lib/stalled) —
 * that no collector's open question names and no Later / Delegate snoozed
 * goes to todo, progress kept, as if its stalled row was answered "Back to
 * the queue". The pull skips in progress, so before this nothing took it
 * up until a person answered the stalled row a day later. What waits on a
 * person (never claimed, a "Decision:" ticket — core isOrphanRequeueable)
 * stays and becomes the stalled ask. The answer is recorded on the stalled
 * row, so the digest and the answered fold show the requeue.
 */
export async function requeueOrphans(scope: asksDb.AskScope, mapIds: string[], userId: string | null, now: Date = new Date()): Promise<OrphanRequeueOutcome> {
  const out: OrphanRequeueOutcome = { requeued: [], failed: [] };
  const rows: AskRow[] = [];
  for (const mapId of mapIds) {
    const data = await mapDb.getMap(mapId);
    if (!data || data.map.archivedAt) continue;
    const byId = new Map(data.nodes.map((n) => [n.id, n]));
    const stalled = await stalledForMap(data.map, data.nodes, now).catch(() => []);
    for (const s of stalled) {
      const node = byId.get(s.nodeId);
      if (node && isOrphanRequeueable(s, node.text)) rows.push(openRow(buildStalledAsk(node, s, mapId, now), mapId, now, s.lastChangeAt));
    }
  }
  if (rows.length === 0) return out;
  const { snoozed, asked } = storedFilters(await asksDb.listAsks(scope, { status: 'all' }), now);
  const decision = 'Back to the queue';
  for (const r of rows) {
    if (snoozed.has(rowKey(r)) || asked(r)) continue;
    const mapId = r.mapId!;
    const nodeId = r.ask.unblocks.node_id!;
    const w: AskWrite = { kind: 'mb-put', target: nodeId.slice(0, 8), detail: `requeue — status → todo (orphaned in progress)`, done: false };
    try {
      await applyLintFix(mapId, nodeId, 'requeue', userId);
      w.done = true;
      out.requeued.push({ askId: r.ask.id, mapId });
    } catch (err) {
      w.error = err instanceof Error ? err.message : String(err);
      out.failed.push({ askId: r.ask.id, mapId, error: w.error });
    }
    const answer: AskAnswerInput = { action: 'answered', decision, by: AUTO_CHECK_BY };
    await asksDb
      .recordAnswer({ fleetId: scope.fleetId, mapId, askId: r.ask.id }, r.ask, { status: 'answered', answer, answeredBy: AUTO_CHECK_BY, answeredAt: now, writes: [w], workerPending: false })
      .catch(() => {});
  }
  return out;
}

interface TicketState {
  nodeId: string;
  done: boolean;
  /** When MindBlown saw it done; null while open, or done at an unknown time (an import that arrived closed). */
  doneAt: number | null;
}

/** The map's tickets by issue number (its forge links, not PRs). */
async function ticketsOf(mapId: string): Promise<Map<number, TicketState>> {
  const out = new Map<number, TicketState>();
  const data = await mapDb.getMap(mapId);
  if (!data) return out;
  const isDone = buildIsDonePredicate(data.map.statusWorkflow ?? []);
  for (const n of data.nodes) {
    const done = isDone(n.status) || (n.childrenIds.length === 0 && (n.percentComplete ?? 0) >= 100);
    const doneAt = done && n.completedAt ? Date.parse(n.completedAt) : null;
    for (const l of n.externalLinks ?? []) {
      const num = isForgeLink(l) && !l.isPullRequest ? /#(\d+)$/.exec(l.externalId)?.[1] : undefined;
      if (num) out.set(Number(num), { nodeId: n.id, done, doneAt });
    }
  }
  return out;
}

async function answerFleetCanFix(scope: asksDb.AskScope, rows: AskRow[], userId: string | null, by: string): Promise<FleetCheckOutcome> {
  const out: FleetCheckOutcome = { sent: [], failed: [] };
  for (const r of rows) {
    const key = { fleetId: scope.fleetId, mapId: r.mapId!, askId: r.ask.id };
    try {
      const res = await answerDerivedAsk(key, { action: 'answered', decision: 'Fleet can fix it', by }, userId);
      if (res.ok) out.sent.push({ askId: r.ask.id, mapId: r.mapId!, action: blockerFleetAction(r.ask) });
      else out.failed.push({ askId: r.ask.id, mapId: r.mapId!, error: res.row.writes.find((w) => w.error)?.error ?? 'not written' });
    } catch (err) {
      out.failed.push({ askId: r.ask.id, mapId: r.mapId!, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}
