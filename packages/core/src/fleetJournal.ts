/**
 * Fleet journal — what the Leidang fleet did in a time window, as one
 * document: the orchestrator's ticks, who picked up what, what was
 * delivered (with PR and actual effort), what got blocked, which follow-up
 * tickets appeared, and every knob write. This is the machine version of
 * the hand-written night report (2026-09-02: 22 ticks, 33 PRs merged, 48
 * follow-ups) — a PM reads it in the Fleet tab, an agent through
 * `fleet_journal`.
 *
 * Pure: the server loads rows (change_events, fleet_ticks, nodes) for the
 * window and hands them here; nothing in this module touches I/O. The
 * event payload shapes are the claim-trail ones (`claimTrail.ts`).
 */
import { summarizeTick } from './fleet.js';
import { parseSession } from './claimTrail.js';
import type { FleetTickPayload, TickSummary } from './fleet.js';
import type { ExternalLink } from './types.js';

export interface JournalWindow {
  from: string;
  to: string;
}

/** One change_events row, as far as the journal reads it. */
export interface JournalEventRow {
  eventType: string;
  nodeId: string | null;
  userId: string | null;
  fieldName: string | null;
  oldValue: unknown;
  newValue: unknown;
  createdAt: string;
}

/** One node row, as far as the journal reads it. */
export interface JournalNodeRow {
  id: string;
  text: string;
  status: string | null;
  completedAt: string | null;
  createdAt: string;
  createdBy: string | null;
  actualEffort: number | null;
  effortEstimate: number | null;
  priority: string | null;
  versionId: string | null;
  tags: string[];
  externalLinks: ExternalLink[];
  blockedReason: string | null;
  claimedBySession: string | null;
}

export interface JournalInput {
  window: { from: Date; to: Date };
  ticks: { tickAt: string; receivedAt: string; payload: FleetTickPayload }[];
  /** Events inside the window, plus the claim-trail events of delivered nodes (may predate the window). */
  events: JournalEventRow[];
  /** Every node an event or the window refers to (completed/created inside it). */
  nodes: JournalNodeRow[];
  versions: { id: string; name: string }[];
  users: { id: string; name: string }[];
  /** Set by the loader when a read limit cut the events or ticks — the lists are then the NEWEST part of the window. */
  truncated?: { events: boolean; ticks: boolean };
}

export interface JournalWorker {
  session: string;
  host: string | null;
  worker: string | null;
}

export interface JournalClaim extends JournalWorker {
  nodeId: string;
  text: string;
  via: 'pull' | 'claim' | 'unknown';
  at: string;
}

export interface JournalRelease extends JournalWorker {
  nodeId: string;
  text: string;
  reason: string;
  note: string | null;
  heldMinutes: number | null;
  at: string;
}

export interface JournalIssue {
  externalId: string;
  url: string;
}

export interface JournalDelivered {
  nodeId: string;
  text: string;
  completedAt: string;
  actualEffort: number | null;
  effortEstimate: number | null;
  deliveredBy: JournalWorker | null;
  pr: { number: number; url: string; repo: string | null; mergedAt: string | null } | null;
  issues: JournalIssue[];
  versionName: string | null;
}

export interface JournalCreated {
  nodeId: string;
  text: string;
  createdAt: string;
  createdBy: string | null;
  priority: string | null;
  versionName: string | null;
  effortEstimate: number | null;
  tags: string[];
  issues: JournalIssue[];
}

export interface JournalBlocked {
  nodeId: string;
  text: string;
  at: string;
  reason: string | null;
}

export interface JournalKnobWrite {
  at: string;
  field: string;
  oldValue: unknown;
  newValue: unknown;
  userId: string | null;
  userName: string | null;
}

/** One orchestrator tick, flattened — same shape the Fleet card's history uses. */
export type JournalTick = TickSummary;

export interface JournalTotals {
  ticks: number;
  claims: number;
  releases: number;
  delivered: number;
  created: number;
  blocked: number;
  knobWrites: number;
  anomaliesWarn: number;
  capMin: number | null;
  capMax: number | null;
  claimsMax: number | null;
  actualEffortSum: number;
  /** Delivered nodes with a PR on record. */
  prsMerged: number;
  createdByVersion: Record<string, number>;
  createdByPriority: Record<string, number>;
  /** Distinct sessions that picked up or delivered something. */
  workers: number;
}

export interface FleetJournal {
  window: JournalWindow;
  ticks: JournalTick[];
  claims: JournalClaim[];
  releases: JournalRelease[];
  delivered: JournalDelivered[];
  created: JournalCreated[];
  blocked: JournalBlocked[];
  knobWrites: JournalKnobWrite[];
  totals: JournalTotals;
  /** A read limit cut the window: what is listed is the newest part, and the totals undercount. */
  truncated: { events: boolean; ticks: boolean };
}

export const JOURNAL_EVENT_TYPES = ['node.claimed', 'node.released', 'node.pr_merged', 'map.field_changed'] as const;

/** `host:worker-N:profile` → parts (claim-trail rule); anything else keeps the raw session and nulls. */
export function splitSession(session: string): JournalWorker {
  const p = parseSession(session);
  return { session, host: p.host, worker: p.worker };
}

function num(x: unknown): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}
function str(x: unknown): string | null {
  return typeof x === 'string' && x !== '' ? x : null;
}
function obj(x: unknown): Record<string, unknown> {
  return x && typeof x === 'object' ? (x as Record<string, unknown>) : {};
}

function inWindow(iso: string | null | undefined, from: Date, to: Date): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return !Number.isNaN(t) && t >= from.getTime() && t <= to.getTime();
}

function githubIssues(links: ExternalLink[]): JournalIssue[] {
  return links.filter((l) => l.provider === 'github').map((l) => ({ externalId: l.externalId, url: l.url }));
}

/** GitHub-mirrored `priority:P2` label → `P2`, when the node's own priority is unset. */
function priorityFromTags(tags: string[]): string | null {
  for (const t of tags) {
    const m = /^priority:\s*(P\d)$/i.exec(t);
    if (m) return m[1].toUpperCase();
  }
  return null;
}

/**
 * A block, as every surface understands it: status → blocked, OR a
 * blockedReason appearing — `flag_blocker` writes only the reason and
 * leaves the status alone, and blocked_digest / risk_scan key on that.
 */
function isBlockEvent(e: JournalEventRow): boolean {
  if (e.fieldName === 'status') return e.newValue === 'blocked';
  if (e.fieldName === 'blockedReason') return e.newValue != null && e.newValue !== '' && (e.oldValue == null || e.oldValue === '');
  return false;
}

/** owner/repo from `owner/repo#123`. */
function repoOf(externalId: string): string | null {
  const i = externalId.indexOf('#');
  return i > 0 ? externalId.slice(0, i) : null;
}

/**
 * Assemble the journal. Ordering: ticks ascending (a history reads top to
 * bottom), everything else by time ascending too. Delivered = every node
 * whose `completedAt` fell into the window — `completedAt` is written by
 * the server on the done transition regardless of who did it (done.sh,
 * the PR-merge webhook, a human), so it is the one signal that does not
 * depend on which path closed the ticket.
 */
export function buildFleetJournal(input: JournalInput): FleetJournal {
  const { from, to } = input.window;
  const nodeById = new Map(input.nodes.map((n) => [n.id, n]));
  const versionName = new Map(input.versions.map((v) => [v.id, v.name]));
  const userName = new Map(input.users.map((u) => [u.id, u.name]));
  const textOf = (id: string) => nodeById.get(id)?.text ?? '(deleted node)';

  const events = [...input.events].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

  const claims: JournalClaim[] = [];
  const releases: JournalRelease[] = [];
  const blocked: JournalBlocked[] = [];
  const knobWrites: JournalKnobWrite[] = [];
  // Per node: the trail the delivered list reads (may predate the window).
  const lastClaim = new Map<string, JournalWorker>();
  const doneRelease = new Map<string, JournalWorker>();
  const prMerged = new Map<string, { number: number; url: string; repo: string | null; mergedAt: string }>();

  for (const e of events) {
    const inside = inWindow(e.createdAt, from, to);
    const v = obj(e.newValue);
    if (e.eventType === 'node.claimed' && e.nodeId) {
      const session = str(v.session);
      if (!session) continue;
      const w = splitSession(session);
      lastClaim.set(e.nodeId, w);
      if (inside) {
        const via = v.via === 'pull' || v.via === 'claim' ? v.via : 'unknown';
        claims.push({ ...w, nodeId: e.nodeId, text: textOf(e.nodeId), via, at: e.createdAt });
      }
    } else if (e.eventType === 'node.released' && e.nodeId) {
      const session = str(v.session);
      if (!session) continue;
      const w = splitSession(session);
      const reason = str(v.reason) ?? 'release';
      if (reason === 'done') doneRelease.set(e.nodeId, w);
      else if (inside) {
        releases.push({ ...w, nodeId: e.nodeId, text: textOf(e.nodeId), reason, note: str(v.note), heldMinutes: num(v.heldMinutes), at: e.createdAt });
      }
    } else if (e.eventType === 'node.pr_merged' && e.nodeId) {
      const number = num(v.prNumber);
      if (number === null) continue;
      const repo = str(v.repo);
      const url = str(v.url) ?? (repo ? `https://github.com/${repo}/pull/${number}` : `#${number}`);
      prMerged.set(e.nodeId, { number, url, repo, mergedAt: e.createdAt });
    } else if (e.eventType === 'map.field_changed' && inside) {
      knobWrites.push({
        at: e.createdAt,
        field: e.fieldName ?? '?',
        oldValue: e.oldValue,
        newValue: e.newValue,
        userId: e.userId,
        userName: e.userId ? (userName.get(e.userId) ?? null) : null,
      });
    } else if (e.eventType === 'node.field_changed' && e.nodeId && inside && isBlockEvent(e)) {
      // One entry per node even when status and blockedReason land as two rows of one PUT.
      const last = blocked[blocked.length - 1];
      if (last && last.nodeId === e.nodeId && Date.parse(e.createdAt) - Date.parse(last.at) < 5_000) continue;
      blocked.push({ nodeId: e.nodeId, text: textOf(e.nodeId), at: e.createdAt, reason: nodeById.get(e.nodeId)?.blockedReason ?? null });
    }
  }

  const delivered: JournalDelivered[] = input.nodes
    .filter((n) => inWindow(n.completedAt, from, to))
    .map((n) => {
      const issues = githubIssues(n.externalLinks);
      let pr: JournalDelivered['pr'] = prMerged.get(n.id) ?? null;
      if (!pr) {
        // The webhook stamps the merged PR on the issue link; the mirror
        // itself is cleared on a default-branch merge, so this is the
        // only place the number survives without a pr_merged event.
        const l = n.externalLinks.find((x) => x.provider === 'github' && typeof x.mergedPrNumber === 'number');
        if (l && typeof l.mergedPrNumber === 'number') {
          const repo = repoOf(l.externalId);
          pr = { number: l.mergedPrNumber, url: repo ? `https://github.com/${repo}/pull/${l.mergedPrNumber}` : `#${l.mergedPrNumber}`, repo, mergedAt: null };
        }
      }
      return {
        nodeId: n.id,
        text: n.text,
        completedAt: n.completedAt as string,
        actualEffort: n.actualEffort,
        effortEstimate: n.effortEstimate,
        deliveredBy: doneRelease.get(n.id) ?? lastClaim.get(n.id) ?? null,
        pr,
        issues,
        versionName: n.versionId ? (versionName.get(n.versionId) ?? null) : null,
      };
    })
    .sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt));

  const created: JournalCreated[] = input.nodes
    .filter((n) => inWindow(n.createdAt, from, to))
    .map((n) => ({
      nodeId: n.id,
      text: n.text,
      createdAt: n.createdAt,
      createdBy: n.createdBy ? (userName.get(n.createdBy) ?? null) : null,
      priority: n.priority ?? priorityFromTags(n.tags),
      versionName: n.versionId ? (versionName.get(n.versionId) ?? null) : null,
      effortEstimate: n.effortEstimate,
      tags: n.tags,
      issues: githubIssues(n.externalLinks),
    }))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

  const ticks = input.ticks
    .filter((t) => inWindow(t.receivedAt, from, to))
    .map(summarizeTick)
    .sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));

  const caps = ticks.map((t) => t.cap).filter((c): c is number => c !== null);
  const claimCounts = ticks.map((t) => t.claims).filter((c): c is number => c !== null);
  const count = (xs: (string | null)[]): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const x of xs) {
      const k = x ?? '(none)';
      out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  };
  const sessions = new Set<string>();
  for (const c of claims) sessions.add(c.session);
  for (const r of releases) sessions.add(r.session);
  for (const d of delivered) if (d.deliveredBy) sessions.add(d.deliveredBy.session);

  return {
    window: { from: from.toISOString(), to: to.toISOString() },
    ticks,
    claims,
    releases,
    delivered,
    created,
    blocked,
    knobWrites,
    truncated: input.truncated ?? { events: false, ticks: false },
    totals: {
      ticks: ticks.length,
      claims: claims.length,
      releases: releases.length,
      delivered: delivered.length,
      created: created.length,
      blocked: blocked.length,
      knobWrites: knobWrites.length,
      anomaliesWarn: ticks.reduce((n, t) => n + t.anomalies.length, 0),
      capMin: caps.length ? Math.min(...caps) : null,
      capMax: caps.length ? Math.max(...caps) : null,
      claimsMax: claimCounts.length ? Math.max(...claimCounts) : null,
      actualEffortSum: Math.round(delivered.reduce((s, d) => s + (d.actualEffort ?? 0), 0) * 100) / 100,
      prsMerged: delivered.filter((d) => d.pr).length,
      createdByVersion: count(created.map((c) => c.versionName)),
      createdByPriority: count(created.map((c) => c.priority)),
      workers: sessions.size,
    },
  };
}

// ── Windows ─────────────────────────────────────────────────────

export type JournalPreset = 'last-night' | '24h' | '7d';

/**
 * "Last night" = yesterday 17:00 → today 07:00 in the caller's local time
 * (the fleet runs unattended between the PM's evening and morning). Before
 * 07:00 the window ends now — the night is still running. The other two
 * presets are plain trailing windows.
 */
export function journalWindow(preset: JournalPreset, now: Date = new Date(), timeZone?: string): { from: Date; to: Date } {
  if (preset === '24h') return { from: new Date(now.getTime() - 24 * 3_600_000), to: now };
  if (preset === '7d') return { from: new Date(now.getTime() - 7 * 86_400_000), to: now };
  if (!timeZone) {
    const morning = new Date(now);
    morning.setHours(7, 0, 0, 0);
    const to = now.getTime() < morning.getTime() ? now : morning;
    const from = new Date(to);
    from.setDate(from.getDate() - 1);
    from.setHours(17, 0, 0, 0);
    return { from, to };
  }
  // Explicit zone: the tool runs where the process is (a UTC container for
  // the chat backend) but the PM's night is in their zone.
  const today = zonedDate(now, timeZone);
  const morning = zonedWallClock(today.y, today.m, today.d, 7, timeZone);
  const to = now.getTime() < morning.getTime() ? now : morning;
  const y = zonedDate(new Date(to.getTime() - 86_400_000), timeZone);
  const from = zonedWallClock(y.y, y.m, y.d, 17, timeZone);
  return { from, to };
}

function zonedDate(d: Date, timeZone: string): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { y: get('year'), m: get('month'), d: get('day') };
}

/** The instant of `y-m-d hour:00` on the wall clock of `timeZone`. */
function zonedWallClock(y: number, m: number, d: number, hour: number, timeZone: string): Date {
  // Guess UTC, read back the wall clock in the zone, correct by the difference (DST-safe: two passes).
  let guess = Date.UTC(y, m - 1, d, hour);
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date(guess));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    const seen = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
    const want = Date.UTC(y, m - 1, d, hour);
    if (seen === want) break;
    guess += want - seen;
  }
  return new Date(guess);
}
