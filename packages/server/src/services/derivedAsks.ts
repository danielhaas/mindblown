/**
 * The rows MindBlown adds to the Questions card itself, derived on read:
 *
 *   stalled-<node>  in progress, nobody on it, no change for
 *                   STALLED_ASK_AFTER_HOURS (core stalled.ts) — a question
 *   step-<node>     an open ticket carrying a skip tag (needs-human …):
 *                   a step only a person can do (core humanSteps.ts)
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
 * needs-human with the text as the new next step.
 */
import {
  buildIsDonePredicate,
  buildStalledAsk,
  buildStepAsk,
  decisionLine,
  dispatchSkipTag,
  isStalledAskDue,
  planAskWrites,
  STALLED_ASK_AFTER_HOURS,
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
      if (!node || !isStalledAskDue(s, now)) continue;
      const seen = new Date(Date.parse(s.lastChangeAt) + STALLED_ASK_AFTER_HOURS * 3_600_000).toISOString();
      out.push(openRow(buildStalledAsk(node, s, mapId, now), mapId, now, seen));
    }

    const isDone = buildIsDonePredicate(data.map.statusWorkflow ?? []);
    for (const node of data.nodes) {
      if (dispatchSkipTag(node) === null) continue;
      if (isDone(node.status) || (node.childrenIds.length === 0 && (node.percentComplete ?? 0) >= 100)) continue;
      out.push(openRow(buildStepAsk(node, mapId), mapId, now, node.updatedAt));
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
    return !(stepAskNodeId(r.ask.id) && asked.has(`${r.mapId ?? ''}|${r.ask.unblocks.node_id}`));
  });
}

/** Which fix an answer runs, and the note it carries. */
function plannedFix(askId: string, decision: string): { action: LintActionId; note: string | undefined } {
  if (stalledAskNodeId(askId)) return { action: stalledAnswerAction(decision), note: stalledAnswerNote(decision) ?? undefined };
  const action = stepAnswerAction(decision);
  const isOption = STEP_ASK_OPTIONS.some((o) => o.toLowerCase() === decision.toLowerCase());
  return { action, note: action === 'needs-human' && !isOption && decision ? decision : undefined };
}

/**
 * Answer a derived row (stalled question or step). The row must still be
 * there — a node claimed, changed, finished or untagged since has nothing
 * left to answer.
 */
export async function answerDerivedAsk(key: asksDb.AskKey, input: AskAnswerInput, userId: string | null): Promise<AnswerAskOutcome> {
  const nodeId = stalledAskNodeId(key.askId) ?? stepAskNodeId(key.askId);
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
    const { action, note } = plannedFix(key.askId, decision);
    const w: AskWrite = { kind: 'mb-put', target: nodeId.slice(0, 8), detail: `${action} — ${decisionLine(by, decision, date)}`, done: false };
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
