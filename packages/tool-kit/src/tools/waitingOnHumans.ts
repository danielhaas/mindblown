/**
 * waiting_on_humans — one signal for "the fleet is idle and waiting on
 * you": per fleet, is it idle (since when), and per person how many
 * decisions, steps, PR merges and approvals hold it up, the oldest of
 * each with ids, and how many tickets they would unblock.
 */
import { z } from 'zod';
import type { FleetWaitingOnHumans, WaitingItem, WaitingOnHumansResult } from '@mindblown/core';
import { defineTool } from '../spec.js';

const LABEL = { decisions: 'decisions', steps: 'steps', prs: 'PRs to merge', approvals: 'approvals' } as const;

function item(i: WaitingItem): string {
  const node = i.nodeId && i.nodeId !== i.ref ? ` · node ${i.nodeId}` : '';
  return `${i.ref} ${i.title.slice(0, 80)}${node}${i.since ? ` · since ${i.since.slice(0, 10)}` : ''}`;
}

function renderFleet(f: FleetWaitingOnHumans): string[] {
  const w = f.workers;
  const state = f.idle
    ? `IDLE${f.idleSince ? ` since ${f.idleSince.slice(0, 16).replace('T', ' ')}` : ''}`
    : f.hostsReporting === 0
      ? 'no host reporting (fleet off or silent) — idle unknown'
      : 'working';
  const lines = [
    `## ${f.fleetName} (id: ${f.fleetId}) — ${state}`,
    `  ${f.activeClaims} active claim(s) · workers ${w.working} working / ${w.waiting} parked or idle of ${w.total} · ${f.hostsReporting} host(s) reporting`,
  ];
  const t = f.total;
  if (f.people.length === 0) {
    lines.push('  Nothing waits on a person.');
    return lines;
  }
  lines.push(`  Waiting on people: ${t.decisions} decisions, ${t.steps} steps, ${t.prs} PRs to merge, ${t.approvals} approvals — would unblock ${t.unblocks} ticket(s)`);
  for (const p of f.people) {
    lines.push('', `  ### ${p.person}: ${p.decisions} decisions, ${p.steps} steps, ${p.prs} PRs, ${p.approvals} approvals — unblocks ${p.unblocks}`);
    for (const k of ['decisions', 'steps', 'prs', 'approvals'] as const) {
      if (p.top[k].length === 0) continue;
      lines.push(`    ${LABEL[k]}:`);
      for (const i of p.top[k]) lines.push(`    - ${item(i)}`);
    }
  }
  return lines;
}

export function renderWaitingOnHumans(res: WaitingOnHumansResult): string {
  if (res.fleets.length === 0) return 'No fleets you can see.';
  const idle = res.fleets.filter((f) => f.idle && f.people.length > 0).length;
  const head = idle > 0 ? `${idle} of ${res.fleets.length} fleet(s) idle and waiting on a person.` : `${res.fleets.length} fleet(s); none idle waiting on a person.`;
  return [head, ...res.fleets.flatMap((f) => ['', ...renderFleet(f)])].join('\n');
}

export const waitingOnHumansTool = defineTool({
  name: 'waiting_on_humans',
  description: [
    'Is the fleet idle because it waits on a person? Per fleet: idle (no active',
    'claims, every worker parked or idle) and since when; per person how many',
    'decisions and steps (open asks, hint decision / ops-task — the answerer),',
    'PRs waiting for a human merge and proposed tickets waiting for approval',
    '(both the map owner\'s, or Dan\'s), the oldest 3 of each with ids (ask id,',
    'node id, PR owner/repo#n), and how many tickets they would unblock.',
    'Read-only. Without fleetId: every fleet you can see. Act with answer_ask,',
    'list_pending_approvals (approve on /?approvals), or merge the PR.',
  ].join('\n'),
  schema: {
    fleetId: z.string().optional().describe('One fleet (list_fleets); omit for every fleet you can see'),
    person: z.string().min(1).max(100).optional().describe('Only this person\'s section — any name on the card (e.g. "Dan"; a map owner goes by their answerer_name), case-insensitive'),
  },
  handler: async (backend, { fleetId, person }) => {
    const res = await backend.waitingOnHumans(fleetId);
    if (!person) return renderWaitingOnHumans(res);
    const who = person.trim().toLowerCase();
    return renderWaitingOnHumans({ ...res, fleets: res.fleets.map((f) => ({ ...f, people: f.people.filter((p) => p.person.toLowerCase() === who) })) });
  },
});

export const waitingOnHumansTools = [waitingOnHumansTool];
