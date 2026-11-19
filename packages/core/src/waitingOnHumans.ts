/**
 * "The fleet is idle and waiting on you" — one reading of a fleet that
 * says whether its workers stand still and what people hold up: open
 * decisions and steps (asks), PRs that need a human merge (rollup claim
 * phase `pr` / ci `manual`), and proposed tickets waiting for approval.
 * Read by `waiting_on_humans` and the `fleet.waiting_on_human` webhook.
 *
 * Pure: the server gathers the inputs (services/waitingOnHumans.ts).
 */
import type { AskRow } from './asks.js';
import { hostFreshness, isWorkerDead } from './fleet.js';
import type { FleetRollup } from './fleet.js';

export type WaitingKind = 'decision' | 'step' | 'pr' | 'approval';

/** One thing a person holds up. */
export interface WaitingItem {
  kind: WaitingKind;
  /** Who acts: the ask's answerer; for PRs and approvals the map owner (or Dan). */
  person: string;
  /** The ask id; the node id for an approval; `owner/repo#12` for a PR. */
  ref: string;
  title: string;
  mapId: string | null;
  /** The ticket it unblocks, when known. */
  nodeId: string | null;
  /** ISO: since when it waits; null when unknown. */
  since: string | null;
  url: string | null;
}

export interface WaitingCounts {
  decisions: number;
  steps: number;
  prs: number;
  approvals: number;
}

export interface PersonWaiting extends WaitingCounts {
  person: string;
  /** Distinct tickets these items would unblock. */
  unblocks: number;
  /** The oldest WAITING_TOP_N of each kind. */
  top: { decisions: WaitingItem[]; steps: WaitingItem[]; prs: WaitingItem[]; approvals: WaitingItem[] };
}

export interface FleetIdleState {
  /** No active claims, no agent running, every reporting worker parked / idle / waiting — and at least one host reports. */
  idle: boolean;
  /** ISO: when the last worker stopped working (newest state_since); null when not idle or unknown. */
  idleSince: string | null;
  activeClaims: number;
  /** Fresh hosts only (a stale host says nothing). */
  hostsReporting: number;
  workers: { total: number; working: number; waiting: number };
}

export interface FleetWaitingOnHumans extends FleetIdleState {
  fleetId: string;
  fleetName: string;
  people: PersonWaiting[];
  total: WaitingCounts & { unblocks: number };
}

export interface WaitingOnHumansResult {
  fleets: FleetWaitingOnHumans[];
  now: string;
}

export const WAITING_TOP_N = 3;
/** Fallback person for a PR or approval whose map owner has no name. */
export const DEFAULT_WAITING_PERSON = 'Dan';
/** `fleet.waiting_on_human` fires at most once per this window per fleet and person. */
export const WAITING_ALERT_THROTTLE_MS = 2 * 3_600_000;

/** A worker in one of these states is not working: it waits (on a limit, a login, a prompt) or has nothing to do. */
export function isWaitingWorkerState(state: string): boolean {
  return state === 'idle' || state === 'prompt' || state.endsWith('parked');
}

/**
 * Is the fleet idle? `activeClaims` = claims holding a cap slot (a PR
 * waiting on a person does not). From the fresh hosts: no worker
 * working (a dead one is not working), no claim phase with an agent on it
 * or a merge running. No fresh host at all = unknown, not idle.
 */
export function fleetIdleState(
  hosts: Array<{ generatedAt: string; receivedAt: string; rollup: FleetRollup }>,
  activeClaims: number,
  now: Date,
): FleetIdleState {
  const fresh = hosts.filter((h) => !hostFreshness(h.generatedAt, h.receivedAt, now).stale);
  let total = 0;
  let working = 0;
  let waiting = 0;
  let agentOnClaim = false;
  let since: number | null = null;
  for (const h of fresh) {
    for (const w of h.rollup.workers ?? []) {
      total++;
      const dead = isWorkerDead(w, now);
      if (dead || isWaitingWorkerState(w.state)) {
        waiting++;
        const t = Date.parse(w.state_since ?? '');
        if (Number.isFinite(t) && (since === null || t > since)) since = t;
      } else {
        working++;
      }
    }
    for (const c of h.rollup.claims ?? []) {
      if (c.phase === 'starting' || c.phase === 'working' || c.phase === 'fixing' || c.phase === 'merging') agentOnClaim = true;
    }
  }
  const idle = fresh.length > 0 && activeClaims === 0 && working === 0 && !agentOnClaim;
  return {
    idle,
    idleSince: idle && since !== null ? new Date(since).toISOString() : null,
    activeClaims,
    hostsReporting: fresh.length,
    workers: { total, working, waiting },
  };
}

/**
 * Open asks a person must act on: `decision` rows and `ops-task` rows
 * (steps). Moot and stale asks (the PR or ticket behind them is gone) and
 * every other hint (waiting-external, no-question folds) are left out.
 */
export function waitingItemsFromAsks(rows: AskRow[]): WaitingItem[] {
  const out: WaitingItem[] = [];
  for (const r of rows) {
    const a = r.ask;
    if (r.status !== 'open' || a.moot || a.stale) continue;
    const kind: WaitingKind | null = a.hint === 'decision' ? 'decision' : a.hint === 'ops-task' ? 'step' : null;
    if (!kind) continue;
    out.push({
      kind,
      person: (a.answerer || DEFAULT_WAITING_PERSON).trim() || DEFAULT_WAITING_PERSON,
      ref: a.id,
      title: (a.title ?? a.question).trim(),
      mapId: r.mapId ?? null,
      nodeId: a.unblocks?.node_id ?? null,
      since: r.firstSeenAt ?? null,
      url: a.url,
    });
  }
  return out;
}

/** The person a map's merges and approvals wait on: the owner's answerer name (core answererName), else first name, else Dan. */
export function ownerPerson(ownerName: string | null | undefined, own?: string | null): string {
  const first = own?.trim() || (ownerName ?? '').trim().split(/\s+/)[0];
  return first || DEFAULT_WAITING_PERSON;
}

const KIND_KEY: Record<WaitingKind, keyof WaitingCounts> = { decision: 'decisions', step: 'steps', pr: 'prs', approval: 'approvals' };
const unblockKey = (i: WaitingItem): string => (i.nodeId ? `node:${i.nodeId}` : `${i.kind}:${i.mapId ?? ''}|${i.ref}`);
const bySince = (a: WaitingItem, b: WaitingItem): number => (Date.parse(a.since ?? '') || Infinity) - (Date.parse(b.since ?? '') || Infinity);

/** Per person: counts, the oldest few of each kind, the tickets they unblock. Most waiting first. */
export function summarizeWaiting(items: WaitingItem[]): { people: PersonWaiting[]; total: WaitingCounts & { unblocks: number } } {
  const groups = new Map<string, WaitingItem[]>();
  for (const i of items) groups.set(i.person, [...(groups.get(i.person) ?? []), i]);
  const people: PersonWaiting[] = [];
  for (const [person, list] of groups) {
    const p: PersonWaiting = { person, decisions: 0, steps: 0, prs: 0, approvals: 0, unblocks: 0, top: { decisions: [], steps: [], prs: [], approvals: [] } };
    for (const i of list) p[KIND_KEY[i.kind]]++;
    for (const key of ['decisions', 'steps', 'prs', 'approvals'] as const) {
      p.top[key] = list.filter((i) => KIND_KEY[i.kind] === key).sort(bySince).slice(0, WAITING_TOP_N);
    }
    p.unblocks = new Set(list.map(unblockKey)).size;
    people.push(p);
  }
  const sum = (p: WaitingCounts) => p.decisions + p.steps + p.prs + p.approvals;
  people.sort((a, b) => sum(b) - sum(a) || a.person.localeCompare(b.person));
  const total = { decisions: 0, steps: 0, prs: 0, approvals: 0, unblocks: new Set(items.map(unblockKey)).size };
  for (const p of people) for (const k of ['decisions', 'steps', 'prs', 'approvals'] as const) total[k] += p[k];
  return { people, total };
}

// ── fleet.waiting_on_human throttling ───────────────────────────

/** What the alert remembers per fleet and person. */
export interface WaitingAlertState {
  /** ISO of the last event sent; null = none sent yet. */
  sentAt: string | null;
  /** The counts the last event carried. */
  counts: WaitingCounts;
  /** An event went out during the current idle stretch. */
  notifiedThisIdle: boolean;
}

export function waitingCountsGrew(prev: WaitingCounts, next: WaitingCounts): boolean {
  return next.decisions > prev.decisions || next.steps > prev.steps || next.prs > prev.prs || next.approvals > prev.approvals;
}

/**
 * Does this person get a `fleet.waiting_on_human` now? Only while the
 * fleet is idle and something waits on them; when the idle stretch has
 * not been announced yet, or the counts grew since the last event — and
 * never twice inside WAITING_ALERT_THROTTLE_MS.
 */
export function waitingAlertDue(prev: WaitingAlertState | undefined, idle: boolean, counts: WaitingCounts, now: Date): boolean {
  if (!idle) return false;
  if (counts.decisions + counts.steps + counts.prs + counts.approvals === 0) return false;
  if (prev?.sentAt && now.getTime() - Date.parse(prev.sentAt) < WAITING_ALERT_THROTTLE_MS) return false;
  if (!prev || !prev.notifiedThisIdle) return true;
  return waitingCountsGrew(prev.counts, counts);
}
