/**
 * Asks inbox tools — `/leidang-asks` for agents: list the fleet's open
 * human questions as the collector pushed them, record an answer the way
 * `leidang-asks-apply` writes it, and sum a round up.
 */
import { z } from 'zod';
import { digestAsks, formatAskDigest, isNoQuestion, isVersionOnly, planAskWrites, sortAsks } from '@mindblown/core';
import type { AskRow } from '@mindblown/core';
import { defineTool } from '../spec.js';
import type { AskListResult } from '../backend.js';

const ANSWERERS = ['Dan', 'Rita', 'Susi', 'Dana', 'Thomas', 'Kunde'] as const;
const HINTS = ['decision', 'ops-task', 'waiting-external', 'already-decided', 'parked-plan'] as const;
const STATUSES = ['open', 'answered', 'later', 'delegated', 'all'] as const;

function ref(r: AskRow): string {
  const a = r.ask;
  return a.ticket != null ? `#${a.ticket}` : (a.requirement ?? a.id);
}

function title(r: AskRow): string {
  const t = (r.ask.title ?? '').trim();
  const x = ref(r);
  // The ref is printed in front of the title; don't print it twice.
  return t.startsWith(x + ' ') ? t.slice(x.length + 1) : t;
}

export function renderAskList(res: AskListResult, mapId: string): string {
  const rows = sortAsks(res.items);
  const lines: string[] = [];
  if (!res.pushedAt) {
    lines.push(`No asks pushed yet for map ${mapId} — the orchestrator's asks push (PUT /maps/:id/asks) is not wired, or the fleet is off.`);
    return lines.join('\n');
  }
  const c = res.counts;
  const byA = Object.entries(c.byAnswerer).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}`).join(', ');
  const byH = Object.entries(c.byHint).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}`).join(', ');
  lines.push(`Asks: ${c.total} (pushed ${res.pushedAt}${res.meta?.tick ? `, tick ${res.meta.tick}` : ''})`);
  if (c.total > 0) lines.push(`  by answerer: ${byA}`, `  by hint: ${byH}`);
  const questions = rows.filter((r) => !isNoQuestion(r.ask) && !isVersionOnly(r.ask));
  const noQuestion = rows.filter((r) => isNoQuestion(r.ask));
  const versionOnly = rows.filter((r) => isVersionOnly(r.ask) && !isNoQuestion(r.ask));
  let who = '';
  for (const r of questions) {
    const a = r.ask;
    if (a.answerer !== who) {
      who = a.answerer;
      lines.push('', `## ${who}`);
    }
    const bits: string[] = [];
    if (a.priority) bits.push(a.priority);
    if (a.idle_hours != null) bits.push(`idle ${a.idle_hours}h`);
    bits.push(`[${a.hint}]`);
    if (r.status !== 'open') bits.push(`[${r.status}${r.answeredBy ? ` by ${r.answeredBy}` : ''}${r.answeredAt ? ` ${r.answeredAt.slice(0, 10)}` : ''}]`);
    if (a.moot) bits.push('MOOT');
    if (a.stale) bits.push('STALE (ticket closed)');
    if (r.workerPending) bits.push('worker note pending');
    lines.push(`- ${a.id} · ${ref(r)} ${title(r).slice(0, 80)} · ${bits.join(' · ')}`);
    lines.push(`  Frage (${a.question_author ?? '?'}): ${a.question.slice(0, 400)}`);
    if (a.options.length > 0) lines.push(`  Optionen: ${a.options.join(' | ')}`);
    const unb: string[] = [];
    if (a.unblocks.node_id) unb.push(`node ${a.unblocks.node_id.slice(0, 8)}${a.unblocks.node_status ? ` (${a.unblocks.node_status})` : ''}`);
    if (a.unblocks.worker) unb.push(`worker ${a.unblocks.worker}`);
    if (a.unblocks.pr) unb.push(`PR ${a.unblocks.pr}${a.unblocks.pr_state ? ` ${a.unblocks.pr_state}` : ''}`);
    if (a.url) unb.push(a.url);
    if (unb.length) lines.push(`  entblockt: ${unb.join(' · ')}`);
    if (r.answer?.decision) lines.push(`  Entscheid: ${r.answer.decision}`);
  }
  if (noQuestion.length > 0) {
    lines.push('', `## Keine Frage — geparkte Planposten / Text ist schon der Entscheid (${noQuestion.length})`);
    for (const r of noQuestion) lines.push(`- ${r.ask.id} · ${ref(r)} [${r.ask.hint}] ${title(r).slice(0, 90)}`);
  }
  if (versionOnly.length > 0) {
    lines.push('', `## Nur Version fehlt — NEEDS-VERSION (${versionOnly.length}, Antwort = Milestone)`);
    for (const r of versionOnly) lines.push(`- ${r.ask.id} · ${ref(r)} ${title(r).slice(0, 90)}${r.ask.priority ? ` · ${r.ask.priority}` : ''}`);
  }
  return lines.join('\n');
}

export const listAsksTool = defineTool({
  name: 'list_asks',
  description: [
    'The fleet\'s open human questions (/leidang-asks), as the orchestrator',
    'pushed them from claude-fleet leidang-asks-collect: one record per ticket,',
    'deduplicated across the tick, the satellite rollups, pending-notes and',
    'GitHub; grouped by who has to answer (Dan/Rita/Susi/Dana/Thomas/Kunde),',
    'ordered answerer → priority → idle age. `hint` says what kind of thing it',
    'is: decision (someone must choose), ops-task (a session with the right key',
    'can just do it), waiting-external, already-decided / parked-plan (folded',
    'as "keine Frage"). MindBlown never invents an ask — wording, options and',
    'answerer come from the collector. Read-only; answer with answer_ask.',
  ].join('\n'),
  schema: {
    mapId: z.string().describe('The map ID the fleet pulls from'),
    status: z.enum(STATUSES).optional().describe('Default open. all = including answered/later/delegated rows'),
    hint: z.enum(HINTS).optional().describe('Only one kind of ask'),
    answerer: z.enum(ANSWERERS).optional().describe('Only questions whose primary answerer is this person'),
    limit: z.number().int().min(1).max(500).optional(),
  },
  handler: async (backend, { mapId, status, hint, answerer, limit }) => {
    const res = await backend.listAsks(mapId, { status, hint, answerer, limit });
    return renderAskList(res, mapId);
  },
});

export const answerAskTool = defineTool({
  name: 'answer_ask',
  description: [
    'Record a human\'s answer to one ask and write it where the fleet picks it',
    'up — exactly what claude-fleet leidang-asks-apply does: GitHub comment',
    '«Entscheid (by, date): …» on the ticket (+ milestone and NEEDS-VERSION off',
    'when that was the question and a milestone is given); decision at the top',
    'of the node description, blockedReason cleared, `blocked` tag removed,',
    'status → todo unless the node is done, claimed, or noRequeue; a',
    'PROMPT-BLOCKED worker\'s note is flagged for the next orchestrator tick.',
    '`later` and `delegate` only record. A moot ask (PR behind the dialog',
    'merged/closed) writes nothing. NEVER call this without an explicit',
    'decision from the human — the tool records decisions, it does not make them.',
  ].join('\n'),
  schema: {
    mapId: z.string(),
    askId: z.string().describe('The ask id from list_asks (e.g. "#6823", "REQ-12", a node id)'),
    action: z.enum(['answered', 'later', 'delegate']),
    decision: z.string().optional().describe('The decision text (required for answered). Options from the ask, or free text'),
    by: z.string().optional().describe('Who decided — default Dan'),
    milestone: z.string().optional().describe('Milestone title to set on the ticket when it carried NEEDS-VERSION'),
    noRequeue: z.boolean().optional().describe('Record the answer but keep the node status — a human step still precedes the fleet'),
    delegateTo: z.enum(['Rita', 'Susi', 'Dana']).optional().describe('For delegate'),
  },
  handler: async (backend, { mapId, askId, action, decision, by, milestone, noRequeue, delegateTo }) => {
    const r = await backend.answerAsk(mapId, askId, { action, decision, by, milestone, noRequeue, delegateTo });
    const lines: string[] = [];
    lines.push(`${askId}: ${r.ask.status}${r.ask.answeredBy ? ` by ${r.ask.answeredBy}` : ''}${r.ok ? '' : ' — SOME WRITES FAILED'}`);
    for (const w of r.ask.writes) {
      lines.push(`  ${w.done ? 'wrote' : w.error ? 'FAILED' : 'pending'}: ${w.kind} ${w.target} — ${w.detail}${w.error ? ` (${w.error})` : ''}`);
    }
    if (r.node) lines.push(`  node ${r.node.id.slice(0, 8)} status now ${r.node.status ?? 'null'}`);
    return lines.join('\n');
  },
});

export const asksDigestTool = defineTool({
  name: 'asks_digest',
  description: [
    'Sum up a /leidang-asks round: how many answered / deferred / delegated',
    'since a timestamp, which tickets got a decision, which nodes are pullable',
    'again, which worker notes still wait for the next tick. Read-only.',
  ].join('\n'),
  schema: {
    mapId: z.string(),
    since: z.string().optional().describe('ISO 8601 — default: today 00:00 UTC'),
  },
  handler: async (backend, { mapId, since }) => {
    const from = since ?? `${new Date().toISOString().slice(0, 10)}T00:00:00Z`;
    const res = await backend.listAsks(mapId, { status: 'all', since: from });
    const d = digestAsks(res.items, from);
    return formatAskDigest(d, from.slice(0, 10));
  },
});

/** Exposed so a caller can preview what an answer would write without writing. */
export { planAskWrites };

export const asksTools = [listAsksTool, answerAskTool, asksDigestTool];
