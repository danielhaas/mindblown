/**
 * Answering an ask — the server-side twin of claude-fleet
 * `bin/leidang-asks-apply`, so the browser round and the terminal round
 * write the same things to the same places:
 *
 *   ticket  → «Entscheid (by, date): …» comment (+ milestone / NEEDS-VERSION
 *             off when that was the question and a milestone came along)
 *   node    → decision at the top of the description, blockedReason null,
 *             `blocked` tag off, status → todo unless done / claimed / noRequeue
 *             (status rule: core `planUnblock`, the same one the Fleet tab uses)
 *   worker  → NOT written here. A PROMPT-BLOCKED worker gets its note from
 *             claudia (tmux is not reachable from the server); the row is
 *             flagged workerPending and the next orchestrator tick delivers.
 *
 * `later` and `delegate` only record. A moot ask (the PR behind the
 * worker's dialog is merged/closed) writes nothing, exactly like apply.
 * Every write is recorded on the row (`writes`) — the ledger.
 */
import { decisionLine, planAskWrites, planUnblock, prependDecision } from '@mindblown/core';
import type { AskAnswerInput, AskNodeState, AskRow, AskWrite, AskWritePlan, Node as CoreNode } from '@mindblown/core';
import { commentOnGitHubIssue, setGitHubIssueMilestone } from '@mindblown/integrations';
import * as asksDb from '../db/asks.js';
import * as nodeDb from '../db/nodes.js';
import * as mapDb from '../db/maps.js';
import { recordFieldChanges } from '../db/events.js';
import { getGitHubContextForMap } from '../lib/githubContext.js';

export class AskNotFoundError extends Error {
  constructor(askId: string) {
    super(`Ask ${askId} not found`);
    this.name = 'AskNotFoundError';
  }
}

export class AskValidationError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'AskValidationError';
  }
}

export interface AnswerAskOutcome {
  row: AskRow;
  plan: AskWritePlan;
  /** True when every planned write landed. */
  ok: boolean;
  /** The node after its update, for broadcast/GitHub-sync fan-out. */
  node: CoreNode | null;
  changedFields: string[];
}

const NEEDS_VERSION_LABEL = 'NEEDS-VERSION';

export function validateAnswer(input: AskAnswerInput): void {
  if (!['answered', 'later', 'delegate'].includes(input.action)) {
    throw new AskValidationError('action must be answered | later | delegate');
  }
  if (input.action === 'answered' && !(input.decision ?? '').trim()) {
    throw new AskValidationError('answered needs a decision — never write an empty decision');
  }
  if (input.action === 'delegate' && !(input.delegateTo ?? '').trim()) {
    throw new AskValidationError('delegate needs delegateTo');
  }
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

async function nodeState(mapId: string, nodeId: string | null): Promise<{ node: CoreNode | null; state: AskNodeState | null }> {
  if (!nodeId) return { node: null, state: null };
  const node = await nodeDb.getNode(nodeId);
  if (!node || node.mapId !== mapId) return { node: null, state: null };
  const workflow = (await mapDb.getStatusWorkflow(mapId)) ?? [];
  const def = node.status === null ? undefined : workflow.find((s) => s.id === node.status || s.name.toLowerCase() === node.status!.toLowerCase());
  return { node, state: { status: node.status, claimedBySession: node.claimedBySession, isDone: def?.category === 'done' } };
}

export async function answerAsk(mapId: string, askId: string, input: AskAnswerInput, userId: string | null): Promise<AnswerAskOutcome> {
  validateAnswer(input);
  const row = await asksDb.getAsk(mapId, askId);
  if (!row) throw new AskNotFoundError(askId);
  const ask = row.ask;
  const by = input.by?.trim() || 'Dan';
  const date = todayIso();
  const answeredAt = new Date();
  const answer: AskAnswerInput = { ...input, by };
  const writes: AskWrite[] = [];

  if (input.action !== 'answered') {
    writes.push({ kind: 'ledger-only', target: ask.id, detail: input.action + (input.delegateTo ? ` → ${input.delegateTo}` : ''), done: true });
    const saved = await asksDb.setAnswer(mapId, askId, {
      status: input.action === 'later' ? 'later' : 'delegated',
      answer,
      answeredBy: by,
      answeredAt,
      writes,
      workerPending: false,
    });
    return { row: saved ?? row, plan: planAskWrites(ask, answer, null, date), ok: true, node: null, changedFields: [] };
  }

  const { node, state } = await nodeState(mapId, ask.unblocks.node_id);
  const plan = planAskWrites(ask, answer, state, date);
  const decision = (input.decision ?? '').trim();
  let updated: CoreNode | null = null;
  const changedFields: string[] = [];

  if (plan.skip) {
    writes.push({ kind: 'moot-skip', target: ask.id, detail: plan.skip, done: true });
  }

  if (plan.github) {
    const target = `#${plan.github.ticket}`;
    const w: AskWrite = { kind: 'gh-comment', target, detail: decisionLine(by, decision, date), done: false };
    writes.push(w);
    const ctx = await getGitHubContextForMap(mapId);
    if (!ctx) {
      w.error = 'map has no GitHub integration — comment not posted';
    } else {
      try {
        await commentOnGitHubIssue(ctx.owner, ctx.repo, plan.github.ticket, plan.github.body, ctx.token);
        w.done = true;
      } catch (err) {
        w.error = err instanceof Error ? err.message : String(err);
      }
      if (plan.github.milestone) {
        const e: AskWrite = { kind: 'gh-edit', target, detail: `--milestone ${plan.github.milestone} --remove-label ${NEEDS_VERSION_LABEL}`, done: false };
        writes.push(e);
        try {
          await setGitHubIssueMilestone(ctx.owner, ctx.repo, plan.github.ticket, plan.github.milestone, NEEDS_VERSION_LABEL, ctx.token);
          e.done = true;
        } catch (err) {
          e.error = err instanceof Error ? err.message : String(err);
        }
      }
    }
  }

  if (plan.node) {
    const short = plan.node.nodeId.slice(0, 8);
    if (!node) {
      writes.push({ kind: 'mb-skip', target: short, detail: 'node not found on this map', done: true });
    } else if (state?.isDone || node.status === 'cancelled') {
      writes.push({ kind: 'mb-skip', target: short, detail: plan.node.why, done: true });
    } else {
      const w: AskWrite = {
        kind: 'mb-put',
        target: short,
        detail: `blockedReason=null, tag blocked removed, decision in description; ${plan.node.why}`,
        done: false,
      };
      writes.push(w);
      try {
        const workflow = (await mapDb.getStatusWorkflow(mapId)) ?? [];
        const unblock = planUnblock(node, workflow);
        const patch: nodeDb.UpdateNodeInput = {
          blockedReason: null,
          description: prependDecision(node.description, decisionLine(by, decision, date)),
        };
        changedFields.push('blockedReason', 'description');
        if (unblock.tagsRemove.length > 0) {
          patch.tagsRemove = unblock.tagsRemove;
          changedFields.push('tags');
        }
        if (plan.node.requeue && unblock.status !== undefined) {
          patch.status = unblock.status;
          changedFields.push('status');
        }
        updated = await nodeDb.updateNode(node.id, patch);
        if (!updated) throw new Error('node vanished during update');
        await recordFieldChanges(mapId, node.id, userId, node, updated);
        w.done = true;
      } catch (err) {
        w.error = err instanceof Error ? err.message : String(err);
      }
    }
  }

  let workerPending = false;
  if (plan.worker) {
    workerPending = true;
    writes.push({
      kind: 'worker-note',
      target: plan.worker.worker,
      detail: 'ausstehend — der nächste Orchestrator-Tick liefert die Notiz in die Ops-Session',
      done: false,
    });
  }

  const saved = await asksDb.setAnswer(mapId, askId, { status: 'answered', answer, answeredBy: by, answeredAt, writes, workerPending });
  const ok = writes.every((w) => w.done || w.kind === 'worker-note');
  return { row: saved ?? row, plan, ok, node: updated, changedFields };
}
