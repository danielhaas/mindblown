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
 * Step: Done = mark-done, Fleet can do it = to-fleet, free text =
 * needs-human with the text as the new next step. Blocker: Unblocked =
 * clear-blocker, Done = mark-done, free text = needs-human.
 */
import {
  AUTO_CHECK_BY,
  AUTO_CHECK_GRACE_MINUTES,
  autoCheckable,
  blockerAnswerAction,
  blockerFleetAction,
  FLEET_CHECK_TAG,
  blockerAskNodeId,
  BLOCKER_ASK_OPTIONS,
  buildBlockerAsk,
  buildIsDonePredicate,
  buildStalledAsk,
  buildStepAsk,
  derivedAskNodeId,
  dispatchSkipTag,
  isStalledAskDue,
  planAskWrites,
  stalledAskAfterHours,
  stalledAnswerAction,
  stalledAnswerNote,
  stalledAskNodeId,
  STEP_ASK_OPTIONS,
  stepAnswerAction,
  stepAskNodeId,
} from '@mindblown/core';
import type { AskAnswerInput, AskRow, AskWrite, LintActionId } from '@mindblown/core';
import * as asksDb from '../db/asks.js';
import * as mapDb from '../db/maps.js';
import { stalledForMap } from '../lib/stalled.js';
import { applyLintFix } from '../lint/fix.js';
import { AskNotFoundError, type AnswerAskOutcome } from './asks.js';

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
  for (const mapId of mapIds) {
    const data = await mapDb.getMap(mapId);
    if (!data || data.map.archivedAt) continue;
    const byId = new Map(data.nodes.map((n) => [n.id, n]));

    const stalled = await stalledForMap(data.map, data.nodes, now).catch(() => []);
    for (const s of stalled) {
      const node = byId.get(s.nodeId);
      if (!node || !isStalledAskDue(s, now, node.text)) continue;
      const seen = new Date(Date.parse(s.lastChangeAt) + stalledAskAfterHours(node.text) * 3_600_000).toISOString();
      out.push(openRow(buildStalledAsk(node, s, mapId, now), mapId, now, seen));
    }

    const isDone = buildIsDonePredicate(data.map.statusWorkflow ?? []);
    for (const node of data.nodes) {
      if (isDone(node.status) || (node.childrenIds.length === 0 && (node.percentComplete ?? 0) >= 100)) continue;
      if (dispatchSkipTag(node) !== null) out.push(openRow(buildStepAsk(node, mapId), mapId, now, node.updatedAt));
      // fleet-check: the fleet has it already, nothing for a person until it reports back.
      else if (node.childrenIds.length === 0 && node.blockedReason?.trim() && !node.tags.includes(FLEET_CHECK_TAG)) out.push(openRow(buildBlockerAsk(node, mapId), mapId, now, node.updatedAt));
    }
  }
  return out;
}

/** The scope's open derived rows: minus snoozed ones, minus steps a collector's open question already covers. */
export async function openDerivedAsks(scope: asksDb.AskScope, mapIds: string[], now: Date = new Date()): Promise<AskRow[]> {
  const derived = await derivedAskRows(mapIds, now);
  if (derived.length === 0) return derived;
  const stored = await asksDb.listAsks(scope, { status: 'all' });
  const cutoff = now.getTime() - asksDb.ANSWER_RETENTION_DAYS * 86_400_000;
  const snoozed = new Set(
    stored
      .filter((r) => (r.status === 'later' || r.status === 'delegated') && r.answeredAt && Date.parse(r.answeredAt) >= cutoff)
      .map(rowKey),
  );
  const asked = new Set(stored.filter((r) => r.status === 'open' && r.ask.unblocks?.node_id).map((r) => `${r.mapId ?? ''}|${r.ask.unblocks.node_id}`));
  return derived.filter((r) => {
    if (snoozed.has(rowKey(r))) return false;
    return !((stepAskNodeId(r.ask.id) || blockerAskNodeId(r.ask.id) || stalledAskNodeId(r.ask.id)) && asked.has(`${r.mapId ?? ''}|${r.ask.unblocks.node_id}`));
  });
}

/** Which fix an answer runs, and the note it carries. */
function plannedFix(ask: AskRow['ask'], decision: string): { action: LintActionId; note: string | undefined } {
  const askId = ask.id;
  if (stalledAskNodeId(askId)) return { action: stalledAnswerAction(decision), note: stalledAnswerNote(decision) ?? undefined };
  const blocker = blockerAskNodeId(askId) !== null;
  let action: LintActionId = blocker ? blockerAnswerAction(decision) : stepAnswerAction(decision);
  if (action === 'fleet-fix') action = blockerFleetAction(ask);
  const isOption = [...STEP_ASK_OPTIONS, ...BLOCKER_ASK_OPTIONS].some((o) => o.toLowerCase() === decision.toLowerCase());
  return { action, note: action === 'needs-human' && !isOption && decision ? decision : undefined };
}

/**
 * Answer a derived row (stalled question or step). The row must still be
 * there — a node claimed, changed, finished or untagged since has nothing
 * left to answer.
 */
export async function answerDerivedAsk(key: asksDb.AskKey, input: AskAnswerInput, userId: string | null): Promise<AnswerAskOutcome> {
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

  if (input.action === 'answered') {
    const decision = (input.decision ?? '').trim();
    const { action, note } = plannedFix(row.ask, decision);
    const w: AskWrite = { kind: 'mb-put', target: nodeId.slice(0, 8), detail: `${action} — Decision (${by}, ${date}): ${decision}`, done: false };
    writes.push(w);
    try {
      const out = await applyLintFix(key.mapId, nodeId, action, userId, { note });
      node = out.node;
      changedFields = out.changedFields;
      w.done = true;
    } catch (err) {
      w.error = err instanceof Error ? err.message : String(err);
    }
  } else {
    writes.push({ kind: 'ledger-only', target: row.ask.id, detail: input.action + (input.delegateTo ? ` → ${input.delegateTo}` : ''), done: true });
  }

  const status = input.action === 'answered' ? 'answered' : input.action === 'later' ? 'later' : 'delegated';
  const saved = await asksDb.recordAnswer(key, row.ask, { status, answer, answeredBy: by, answeredAt: now, writes, workerPending: false });
  return { row: saved, plan: planAskWrites(row.ask, answer, null, date), ok: writes.every((w) => w.done), node, changedFields };
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
 * fleet check all", for fewer rows —
 *   - a blocker that has sat AUTO_CHECK_GRACE_MINUTES, so a person can answer first;
 *   - not a fleet worker's own PR note (core autoCheckable);
 *   - one automatic check per blocker: when the check run could not get past
 *     it and wrote a blocker again, the row's last answer is still ours and
 *     it stays with a person. Any answer a person gives replaces that row
 *     and re-arms the check; so does pruning, ANSWER_RETENTION_DAYS later.
 */
export async function autoCheckBlockers(scope: asksDb.AskScope, mapIds: string[], userId: string | null, now: Date = new Date()): Promise<FleetCheckOutcome> {
  const due = now.getTime() - AUTO_CHECK_GRACE_MINUTES * 60_000;
  const open = (await openDerivedAsks(scope, mapIds, now)).filter(
    (r) => blockerAskNodeId(r.ask.id) !== null && r.mapId && autoCheckable(r.ask) && Date.parse(r.firstSeenAt) <= due,
  );
  if (open.length === 0) return { sent: [], failed: [] };
  const ours = new Set(
    (await asksDb.listAsks(scope, { status: 'answered' })).filter((r) => r.answeredBy === AUTO_CHECK_BY && blockerAskNodeId(r.ask.id) !== null).map(rowKey),
  );
  return answerFleetCanFix(scope, open.filter((r) => !ours.has(rowKey(r))), userId, AUTO_CHECK_BY);
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
