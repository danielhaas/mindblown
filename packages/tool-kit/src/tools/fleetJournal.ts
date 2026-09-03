/**
 * fleet_journal — the night report as a tool: what the Leidang fleet did
 * in a window. Rendering mirrors the hand-written 2026-09-02 report the PM
 * asked to have automated (tick table, merged PRs with node + effort,
 * closed issues, follow-ups by version/priority), so an agent asked
 * "what happened last night?" answers from one call.
 */
import { z } from 'zod';
import { journalWindow } from '@mindblown/core';
import type { FleetJournal, JournalTick } from '@mindblown/core';
import { defineTool } from '../spec.js';

function hhmm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(11, 16);
}
function dayOf(iso: string): string {
  return iso.slice(0, 10);
}
function fmtVal(v: unknown): string {
  if (v == null) return '∅';
  if (Array.isArray(v)) return v.length ? v.join(' › ') : '[]';
  return typeof v === 'string' ? v : JSON.stringify(v);
}
function worker(w: { session: string; host: string | null; worker: string | null } | null): string {
  if (!w) return 'unknown worker';
  return w.host && w.worker ? `${w.worker}@${w.host}` : w.session;
}
function tickLine(t: JournalTick): string {
  const bits = [`${hhmm(t.receivedAt)}  claims ${t.claims ?? '?'}/${t.cap ?? '?'}`];
  if (t.pullableInGate !== null) bits.push(`in-gate ${t.pullableInGate}`);
  if (t.needsBrief !== null) bits.push(`needs-brief ${t.needsBrief}`);
  if (t.capWrite) bits.push(`CAP → ${t.capWrite.set}${t.capWrite.reason ? ` (${t.capWrite.reason})` : ''}`);
  if (t.policyWrite) bits.push(`policy → ${t.policyWrite.set.join(' › ')}`);
  if (t.gateRecommendation) bits.push(`gate? ${t.gateRecommendation.set.join(' + ')}`);
  for (const a of t.anomalies) bits.push(`[${a.severity}] ${a.what}`);
  if (t.asksCount > 0) bits.push(`${t.asksCount} ask${t.asksCount === 1 ? '' : 's'}`);
  if (t.noJudgment) bits.push(`NO JUDGMENT (${t.noJudgment})`);
  return bits.join(' · ');
}

/** Text rendering — exported so the chat backend and tests share it. */
export function renderFleetJournal(j: FleetJournal): string {
  const t = j.totals;
  const lines: string[] = [];
  lines.push(`Fleet journal ${j.window.from.slice(0, 16).replace('T', ' ')} → ${j.window.to.slice(0, 16).replace('T', ' ')} (UTC)`);
  lines.push(
    `${t.ticks} ticks · cap ${t.capMin ?? '?'}${t.capMax !== null && t.capMax !== t.capMin ? `–${t.capMax}` : ''} · claims max ${t.claimsMax ?? '?'} · ` +
      `${t.delivered} delivered (${t.prsMerged} with PR, actual ${t.actualEffortSum}) · ${t.claims} picked up · ${t.releases} handed back · ` +
      `${t.blocked} blocked · ${t.created} follow-ups · ${t.knobWrites} knob writes · ${t.workers} workers`,
  );

  lines.push('');
  lines.push(`## Ticks (${j.ticks.length})`);
  if (j.ticks.length === 0) lines.push('  no orchestrator tick in the window');
  let day = '';
  for (const tk of j.ticks) {
    const d = dayOf(tk.receivedAt);
    if (d !== day) {
      day = d;
      lines.push(`  ${d}`);
    }
    lines.push(`  ${tickLine(tk)}`);
  }

  lines.push('');
  lines.push(`## Delivered (${j.delivered.length})`);
  if (j.delivered.length === 0) lines.push('  nothing moved to done in the window');
  for (const d of j.delivered) {
    const pr = d.pr ? `PR #${d.pr.number}` : 'no PR on record';
    const eff = d.actualEffort !== null ? `actual ${d.actualEffort}` : 'no actual';
    const issues = d.issues.length ? ` — ${d.issues.map((i) => i.externalId).join(', ')}` : '';
    lines.push(`  ${dayOf(d.completedAt)} ${hhmm(d.completedAt)}  ${pr}: ${d.text} — by ${worker(d.deliveredBy)} · ${eff}${d.versionName ? ` · ${d.versionName}` : ''}${issues}`);
  }
  const closed = j.delivered.flatMap((d) => d.issues.map((i) => i.externalId));
  if (closed.length > 0) {
    lines.push('');
    lines.push(`## Issues closed (${closed.length})`);
    lines.push(`  ${closed.join(', ')}`);
  }

  if (j.claims.length > 0 || j.releases.length > 0) {
    lines.push('');
    lines.push(`## Picked up (${j.claims.length}) / handed back (${j.releases.length})`);
    for (const c of j.claims) lines.push(`  ${hhmm(c.at)}  ${worker(c)} picked up ${c.text} (${c.via})`);
    for (const r of j.releases) {
      lines.push(`  ${hhmm(r.at)}  ${worker(r)} handed back ${r.text} — ${r.reason}${r.heldMinutes !== null ? ` after ${r.heldMinutes} min` : ''}${r.note ? `: ${r.note}` : ''}`);
    }
  }

  if (j.blocked.length > 0) {
    lines.push('');
    lines.push(`## Blocked (${j.blocked.length})`);
    for (const b of j.blocked) lines.push(`  ${hhmm(b.at)}  ${b.text}${b.reason ? ` — ${b.reason}` : ''}`);
  }

  lines.push('');
  lines.push(`## Follow-ups created (${j.created.length})`);
  if (j.created.length > 0) {
    const tally = (m: Record<string, number>) =>
      Object.entries(m)
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${k}: ${n}`)
        .join(', ');
    lines.push(`  by version: ${tally(t.createdByVersion)}`);
    lines.push(`  by priority: ${tally(t.createdByPriority)}`);
    for (const c of j.created) {
      const meta = [c.priority, c.effortEstimate !== null ? `est ${c.effortEstimate}` : null, c.versionName].filter(Boolean).join(' · ');
      lines.push(`  ${hhmm(c.createdAt)}  ${c.text}${meta ? ` [${meta}]` : ''}${c.createdBy ? ` — ${c.createdBy}` : ''}`);
    }
  } else {
    lines.push('  none');
  }

  if (j.knobWrites.length > 0) {
    lines.push('');
    lines.push(`## Knob writes (${j.knobWrites.length})`);
    for (const k of j.knobWrites) lines.push(`  ${hhmm(k.at)}  ${k.field}: ${fmtVal(k.oldValue)} → ${fmtVal(k.newValue)}${k.userName ? ` — ${k.userName}` : k.userId ? ` — ${k.userId.slice(0, 8)}` : ' — fleet'}`);
  }

  return lines.join('\n');
}

export const fleetJournalTool = defineTool({
  name: 'fleet_journal',
  description: [
    'What the Leidang fleet did in a time window, as one report: the',
    'orchestrator ticks (claims/cap, in-gate, needs-brief, cap/policy writes,',
    'warn+ anomalies), every node delivered (done) with the worker that held',
    'it, the merged PR and the actual effort, the issues closed, tickets picked',
    'up and handed back, nodes blocked, follow-up tickets created (by version',
    'and priority) and every dispatch-knob write. Read-only. Default window:',
    'the trailing 24 h; `preset` = last-night (yesterday 17:00 → today 07:00',
    'local), 24h, 7d; or explicit `from`/`to` (ISO 8601, max 31 days). Use',
    'this for "what happened last night?" instead of reading ticks one by one.',
  ].join('\n'),
  schema: {
    mapId: z.string().describe('The map ID the fleet pulls from'),
    preset: z.enum(['last-night', '24h', '7d']).optional().describe('Window preset; ignored when from/to are given'),
    from: z.string().optional().describe('Window start, ISO 8601'),
    to: z.string().optional().describe('Window end, ISO 8601 (default now)'),
  },
  handler: async (backend, { mapId, preset, from, to }) => {
    let opts: { from?: string; to?: string } = { from, to };
    if (!from && !to && preset) {
      const w = journalWindow(preset);
      opts = { from: w.from.toISOString(), to: w.to.toISOString() };
    }
    const r = await backend.getFleetJournal(mapId, opts);
    return renderFleetJournal(r.journal);
  },
});

export const fleetJournalTools = [fleetJournalTool];
