/**
 * Claim trail — the structured payloads the server writes into
 * `change_events` when a claim is taken, dropped, or delivered, and the
 * pure reading of those rows a node panel / MCP tool / fleet journal shows.
 *
 * `claimedBySession` is transient state: it is nulled on done, on release,
 * by the stale sweeper. Once it is gone the node itself cannot say WHICH
 * worker delivered it or when it was picked up — only these events can.
 * Payloads are self-describing (session already split into host / worker /
 * profile) so a later aggregation never has to re-parse the session
 * string convention of the day.
 */

export type ClaimVia = 'pull' | 'claim';

/**
 * Why a claim went away.
 *   release     — the holder called release_node (note carries its reason)
 *   done        — the node moved to done; the claim was cleared server-side
 *   stale_sweep — the stale-claim sweeper cleared it
 *   transfer    — another session claimed over it (claim_node soft-warn path)
 *   blocked     — the holder parked the node as blocked and dropped the claim
 */
export type ReleaseReason = 'release' | 'done' | 'stale_sweep' | 'transfer' | 'blocked';

export interface ParsedSession {
  host: string | null;
  worker: string | null;
  profile: string | null;
}

export interface ClaimedEvent {
  session: string;
  host: string | null;
  worker: string | null;
  profile: string | null;
  via: ClaimVia;
  previousSession: string | null;
}

export interface ReleasedEvent {
  session: string;
  host: string | null;
  worker: string | null;
  profile: string | null;
  reason: ReleaseReason;
  note: string | null;
  claimedAt: string | null;
  heldMinutes: number | null;
}

export interface PrMergedEvent {
  prNumber: number;
  repo: string;
  url: string | null;
  mergeCommitSha: string | null;
  externalId: string;
  /** The node was already done when the merge landed (the normal case — the worker marks done when it opens the PR). */
  alreadyDone: boolean;
}

export const CLAIM_EVENT_TYPES = ['node.claimed', 'node.released', 'node.pr_merged'] as const;
export type ClaimEventType = (typeof CLAIM_EVENT_TYPES)[number];

/** The subset of a change_events row the trail needs — every client's ChangeEvent satisfies it. */
export interface ChangeEventLike {
  eventType: string;
  fieldName: string | null;
  oldValue: unknown;
  newValue: unknown;
  createdAt: string;
  userId: string | null;
}

export interface ClaimTrailEntry {
  at: string;
  kind: 'claimed' | 'released' | 'delivered' | 'done';
  text: string;
  /** The worker session the entry is about (null for the done marker and unparseable rows). */
  session: string | null;
}

/**
 * Split a Leidang session id `host:worker-N:profile` (e.g.
 * `njoerd:worker-3:default`). A two-part `host:worker-N` is tolerated
 * (profile null). Anything else — a human's session id, an old script —
 * yields all-null parts; the caller keeps the raw string.
 */
export function parseSession(session: string): ParsedSession {
  const parts = session.split(':');
  if ((parts.length === 2 || parts.length === 3) && /^worker-\d+$/.test(parts[1]) && parts[0] !== '') {
    return { host: parts[0], worker: parts[1], profile: parts.length === 3 && parts[2] !== '' ? parts[2] : null };
  }
  return { host: null, worker: null, profile: null };
}

/** Whole minutes between the claim and `now`; null when the claim time is unknown or unparseable. */
export function heldMinutes(claimedAt: string | null | undefined, now: Date): number | null {
  if (!claimedAt) return null;
  const ms = now.getTime() - new Date(claimedAt).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.round(ms / 60_000));
}

export function buildClaimedEvent(
  session: string,
  via: ClaimVia,
  previousSession: string | null,
): ClaimedEvent {
  return { session, ...parseSession(session), via, previousSession };
}

export function buildReleasedEvent(
  session: string,
  claimedAt: string | null,
  reason: ReleaseReason,
  note: string | null,
  now: Date = new Date(),
): ReleasedEvent {
  return {
    session,
    ...parseSession(session),
    reason,
    note,
    claimedAt,
    heldMinutes: heldMinutes(claimedAt, now),
  };
}

// ── Reading ──────────────────────────────────────────────────────

/** `worker-3 on njoerd`, or the raw session when it does not follow the fleet convention. */
export function describeSession(p: { session: string; host: string | null; worker: string | null }): string {
  return p.worker && p.host ? `${p.worker} on ${p.host}` : p.session;
}

export function formatHeld(minutes: number | null): string | null {
  if (minutes == null) return null;
  if (minutes < 60) return `${minutes} min`;
  const h = minutes / 60;
  if (h < 48) return `${Number.isInteger(h) ? h : h.toFixed(1)} h`;
  return `${Math.floor(h / 24)} d`;
}

const RELEASE_LABEL: Record<ReleaseReason, string> = {
  release: 'released by worker',
  done: 'done',
  stale_sweep: 'stale claim swept',
  transfer: 'claim taken over',
  blocked: 'blocked',
};

function asClaimed(v: unknown): ClaimedEvent | null {
  const o = v as Partial<ClaimedEvent> | null;
  return o && typeof o.session === 'string'
    ? { host: null, worker: null, profile: null, via: 'claim', previousSession: null, ...o, session: o.session }
    : null;
}
function asReleased(v: unknown): ReleasedEvent | null {
  const o = v as Partial<ReleasedEvent> | null;
  return o && typeof o.session === 'string'
    ? { host: null, worker: null, profile: null, reason: 'release', note: null, claimedAt: null, heldMinutes: null, ...o, session: o.session }
    : null;
}
function asPrMerged(v: unknown): PrMergedEvent | null {
  const o = v as Partial<PrMergedEvent> | null;
  return o && typeof o.prNumber === 'number'
    ? { repo: '', url: null, mergeCommitSha: null, externalId: '', alreadyDone: false, ...o, prNumber: o.prNumber }
    : null;
}

/**
 * One human line for a claim event, or null when the row is not a claim
 * event (or its payload is unreadable). Shared by the node panel and the
 * MCP change_history tool so both say the same thing.
 */
export function describeClaimEvent(e: ChangeEventLike): string | null {
  if (e.eventType === 'node.claimed') {
    const p = asClaimed(e.newValue);
    if (!p) return null;
    const takeover =
      p.previousSession && p.previousSession !== p.session
        ? `, taken over from ${describeSession({ session: p.previousSession, ...parseSession(p.previousSession) })}`
        : '';
    return `picked up by ${describeSession(p)} (${p.via}${takeover})`;
  }
  if (e.eventType === 'node.released') {
    const p = asReleased(e.newValue);
    if (!p) return null;
    const held = formatHeld(p.heldMinutes);
    const why =
      p.reason === 'release' && p.note
        ? p.note
        : p.note
          ? `${RELEASE_LABEL[p.reason] ?? p.reason}: ${p.note}`
          : (RELEASE_LABEL[p.reason] ?? p.reason);
    return `released${held ? ` after ${held}` : ''} — ${why}`;
  }
  if (e.eventType === 'node.pr_merged') {
    const p = asPrMerged(e.newValue);
    if (!p) return null;
    return `PR #${p.prNumber} merged${p.repo ? ` (${p.repo})` : ''}`;
  }
  return null;
}

function sessionOf(e: ChangeEventLike): string | null {
  const v = e.newValue as { session?: unknown } | null;
  return v && typeof v.session === 'string' ? v.session : null;
}

/**
 * The ordered trail for one node: claim events (any order in, ascending
 * out) plus a `done` marker from the node itself when it is completed.
 * Rows that are not claim events are ignored, so a caller may hand over
 * the node's whole history.
 */
export function claimTrail(
  events: ChangeEventLike[],
  node?: { actualEffort?: number | null; completedAt?: string | null },
): ClaimTrailEntry[] {
  const entries: ClaimTrailEntry[] = [];
  for (const e of events) {
    const text = describeClaimEvent(e);
    if (text === null) continue;
    const kind: ClaimTrailEntry['kind'] =
      e.eventType === 'node.claimed' ? 'claimed' : e.eventType === 'node.released' ? 'released' : 'delivered';
    entries.push({ at: e.createdAt, kind, text, session: kind === 'delivered' ? null : sessionOf(e) });
  }
  if (node?.completedAt) {
    const actual = node.actualEffort != null ? ` · actual ${node.actualEffort}` : '';
    entries.push({ at: node.completedAt, kind: 'done', text: `done${actual}`, session: null });
  }
  return entries.sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * Who holds the node now (last claim not followed by a release) and who
 * delivered it last (the holder at the last merge or done-release). Both
 * read only from the events, so they agree with the trail even after
 * `claimedBySession` has been cleared.
 */
export function claimTrailSummary(events: ChangeEventLike[]): {
  currentHolder: string | null;
  lastDeliveredBy: string | null;
} {
  const sorted = [...events]
    .filter((e) => (CLAIM_EVENT_TYPES as readonly string[]).includes(e.eventType))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  let holder: string | null = null;
  let lastHolder: string | null = null;
  let lastDeliveredBy: string | null = null;
  for (const e of sorted) {
    if (e.eventType === 'node.claimed') {
      holder = sessionOf(e);
      lastHolder = holder;
    } else if (e.eventType === 'node.released') {
      const p = asReleased(e.newValue);
      if (p?.reason === 'done') lastDeliveredBy = p.session;
      if (holder === null || holder === p?.session) holder = null;
    } else if (e.eventType === 'node.pr_merged') {
      if (lastHolder) lastDeliveredBy = lastHolder;
    }
  }
  return { currentHolder: holder, lastDeliveredBy };
}
