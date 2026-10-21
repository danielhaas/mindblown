/**
 * Stalled work as questions on the Questions card (core `buildStalledAsk`).
 *
 * Derived on read for the maps of the inbox scope: in progress, nobody on
 * it, no change for STALLED_ASK_AFTER_HOURS. Nothing is stored while the
 * question is open, so a fleet push (which replaces the open set) cannot
 * wipe it and there is no second list to keep in step — answering writes
 * the node, the stall ends, and the question is gone on the next read.
 *
 * Every answer is recorded as an asks row anyway (status answered / later /
 * delegated) so the answered fold and the digest show the round, and so
 * Later and Delegate snooze the question: an open stalled ask is hidden
 * while the node has a later/delegated row younger than ANSWER_RETENTION_DAYS.
 *
 * The three answers are the lint fixes of the same name (lint/fix.ts):
 * Done = mark-done, Back to the queue = requeue, For a person = needs-human;
 * any other text is kept as the person's next step.
 */
import {
  buildStalledAsk,
  decisionLine,
  isStalledAskDue,
  planAskWrites,
  STALLED_ASK_AFTER_HOURS,
  stalledAnswerAction,
  stalledAnswerNote,
  stalledAskNodeId,
} from '@mindblown/core';
import type { AskAnswerInput, AskRow, AskWrite } from '@mindblown/core';
import * as asksDb from '../db/asks.js';
import * as mapDb from '../db/maps.js';
import { stalledForMap } from '../lib/stalled.js';
import { applyLintFix } from '../lint/fix.js';
import { AskNotFoundError, type AnswerAskOutcome } from './asks.js';

/** The open stalled asks of these maps, as inbox rows. A map whose change log can't be read is skipped. */
export async function stalledAskRows(mapIds: string[], now: Date = new Date()): Promise<AskRow[]> {
  const out: AskRow[] = [];
  for (const mapId of mapIds) {
    const data = await mapDb.getMap(mapId);
    if (!data) continue;
    const stalled = await stalledForMap(data.map, data.nodes, now).catch(() => []);
    const byId = new Map(data.nodes.map((n) => [n.id, n]));
    for (const s of stalled) {
      const node = byId.get(s.nodeId);
      if (!node || !isStalledAskDue(s, now)) continue;
      out.push({
        ask: buildStalledAsk(node, s, mapId, now),
        mapId,
        status: 'open',
        pushedAt: now.toISOString(),
        firstSeenAt: new Date(Date.parse(s.lastChangeAt) + STALLED_ASK_AFTER_HOURS * 3_600_000).toISOString(),
        answer: null,
        answeredBy: null,
        answeredAt: null,
        writes: [],
        workerPending: false,
      });
    }
  }
  return out;
}

/** The scope's derived rows, minus the ones a recent Later / Delegate snoozed. */
export async function openStalledAsks(scope: asksDb.AskScope, mapIds: string[], now: Date = new Date()): Promise<AskRow[]> {
  const derived = await stalledAskRows(mapIds, now);
  if (derived.length === 0) return derived;
  const cutoff = now.getTime() - asksDb.ANSWER_RETENTION_DAYS * 86_400_000;
  const snoozed = new Set(
    (await asksDb.listAsks(scope, { status: 'all' }))
      .filter((r) => (r.status === 'later' || r.status === 'delegated') && r.answeredAt && Date.parse(r.answeredAt) >= cutoff)
      .map((r) => `${r.mapId ?? ''}|${r.ask.id}`),
  );
  return derived.filter((r) => !snoozed.has(`${r.mapId ?? ''}|${r.ask.id}`));
}

/**
 * Answer a stalled ask: Done / Back to the queue / For a person (or free
 * text = the person's next step). The node must still be stalled — a node
 * claimed, changed or finished since has no question any more.
 */
export async function answerStalledAsk(key: asksDb.AskKey, input: AskAnswerInput, userId: string | null): Promise<AnswerAskOutcome> {
  const nodeId = stalledAskNodeId(key.askId);
  if (!nodeId || !key.mapId) throw new AskNotFoundError(key.askId);
  const now = new Date();
  const [row] = (await stalledAskRows([key.mapId], now)).filter((r) => r.ask.id === key.askId);
  if (!row) throw new AskNotFoundError(key.askId);

  const by = input.by?.trim() || 'Dan';
  const answer: AskAnswerInput = { ...input, by };
  const date = now.toISOString().slice(0, 10);
  const writes: AskWrite[] = [];
  let node: AnswerAskOutcome['node'] = null;
  let changedFields: string[] = [];

  if (input.action === 'answered') {
    const decision = (input.decision ?? '').trim();
    const action = stalledAnswerAction(decision);
    const w: AskWrite = { kind: 'mb-put', target: nodeId.slice(0, 8), detail: `${action} — ${decisionLine(by, decision, date)}`, done: false };
    writes.push(w);
    try {
      const out = await applyLintFix(key.mapId, nodeId, action, userId, { note: stalledAnswerNote(decision) ?? undefined });
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
