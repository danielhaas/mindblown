/**
 * Pure helpers behind the cockpit's Dispatch and Fleet cards — the UI
 * reading of the three Leidang pull-queue knobs (maxActiveClaims,
 * dispatchGate, dispatchPolicy), the change_events audit trail behind
 * them, and the claim list. No store import so they are unit-testable.
 *
 * The queue semantics themselves (what is pullable, what the gate hides)
 * come from @mindblown/core `dispatchQueueSnapshot`, the same predicate the
 * server's get_next_ticket applies.
 */
import type { Node, Version } from '@mindblown/core';
import {
  parseGateEntry,
  compareVersions,
  GATE_BUGS_ONLY,
  GATE_VERSION_PREFIX,
  DISPATCH_POLICY_KEYS,
  DEFAULT_DISPATCH_POLICY,
} from '@mindblown/core';
import type { ChangeEvent, MapMember } from './api.js';

export const KNOB_FIELDS = ['maxActiveClaims', 'dispatchGate', 'dispatchPolicy'] as const;
export type KnobField = (typeof KNOB_FIELDS)[number];

export const KNOB_LABEL: Record<KnobField, string> = {
  maxActiveClaims: 'Cap',
  dispatchGate: 'Gate',
  dispatchPolicy: 'Policy',
};

/** Server default for the stale-claim sweeper (services/orchestration.ts). */
export const STALE_CLAIM_HOURS = 4;

// ── Gate ───────────────────────────────────────────────────────────

export interface GateChip {
  raw: string;
  kind: 'version' | 'bugs' | 'unknown';
  label: string;
  /** Second line: version status + target date. */
  detail: string | null;
  /** Non-null when this entry deserves a red chip. */
  warning: string | null;
}

/**
 * Render each gate entry with what a PM needs to tell two same-named
 * versions apart (status + target date) and with the two ways an entry
 * silently empties the queue called out: a version id that no longer
 * exists, and an entry the server cannot parse (fail-closed).
 */
export function gateChips(gate: string[], versions: Version[]): GateChip[] {
  const byId = new Map(versions.map((v) => [v.id, v]));
  return gate.map((raw) => {
    const p = parseGateEntry(raw);
    if (p.kind === 'bugs') return { raw, kind: 'bugs', label: 'Bugs only', detail: null, warning: null };
    if (p.kind === 'version') {
      const v = byId.get(p.versionId);
      if (!v) {
        return {
          raw,
          kind: 'unknown',
          label: `version ${p.versionId.slice(0, 8)}…`,
          detail: null,
          warning: 'No such version on this map — the queue is empty until this entry goes.',
        };
      }
      const detail = v.targetDate ? `${v.status} · ${v.targetDate}` : v.status;
      const warning =
        v.status === 'released' || v.status === 'archived'
          ? `Gate on a ${v.status} version — nothing new is versioned into it, the queue only drains.`
          : null;
      return { raw, kind: 'version', label: v.name, detail, warning };
    }
    return {
      raw,
      kind: 'unknown',
      label: raw,
      detail: null,
      warning: 'Unknown gate entry — the server matches nothing against it, so the queue is empty until it is removed.',
    };
  });
}

/** Add or remove one gate entry; order preserved, no duplicates. */
export function toggleGateEntry(gate: string[], raw: string): string[] {
  return gate.includes(raw) ? gate.filter((g) => g !== raw) : [...gate, raw];
}

export function versionGateEntry(versionId: string): string {
  return `${GATE_VERSION_PREFIX}${versionId}`;
}

export { GATE_BUGS_ONLY };

/**
 * Versions offered for a gate, in the order a PM picks them: the lane
 * being worked first, then planned ones, then released/archived (still
 * selectable — a drain gate is legitimate — but last).
 */
export function versionGateOptions(versions: Version[]): Version[] {
  const rank: Record<Version['status'], number> = { active: 0, planning: 1, released: 2, archived: 3 };
  // Within a status band, the codebase's canonical release order.
  return [...versions].sort((a, b) => rank[a.status] - rank[b.status] || compareVersions(a, b));
}

// ── Policy ─────────────────────────────────────────────────────────

const POLICY_KEY_SET = new Set<string>(DISPATCH_POLICY_KEYS);

/** Drop unknown keys and duplicates — the server would reject them. */
export function normalizePolicy(policy: string[]): string[] {
  const out: string[] = [];
  for (const k of policy) if (POLICY_KEY_SET.has(k) && !out.includes(k)) out.push(k);
  return out;
}

/** What the queue actually sorts by: an empty policy means the default. */
export function effectivePolicy(policy: string[]): string[] {
  const p = normalizePolicy(policy);
  return p.length > 0 ? p : [...DEFAULT_DISPATCH_POLICY];
}

export function movePolicyKey(policy: string[], key: string, dir: -1 | 1): string[] {
  const p = [...policy];
  const i = p.indexOf(key);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= p.length) return p;
  [p[i], p[j]] = [p[j], p[i]];
  return p;
}

export function togglePolicyKey(policy: string[], key: string): string[] {
  return policy.includes(key) ? policy.filter((k) => k !== key) : [...policy, key];
}

export function policyKeyLabel(key: string): string {
  switch (key) {
    case 'bugs':
      return 'bugs first';
    case 'size':
      return 'small first';
    case 'priority':
      return 'priority';
    case 'age':
      return 'oldest first';
    default:
      return key;
  }
}

// ── Presets ────────────────────────────────────────────────────────

/**
 * Operating phases from the Leidang design (Layer 1). A preset sets gate
 * and policy, never the cap — the cap is CI capacity, not a phase. "Next
 * release" was dropped on Jenna's review: the map has parallel lanes, so
 * "the next one" is not well-defined; Release push with a picked version
 * covers it.
 */
export type PresetId = 'release_push' | 'bug_sweep';

export interface Preset {
  id: PresetId;
  label: string;
  needsVersion: boolean;
  hint: string;
}

export const PRESETS: Preset[] = [
  {
    id: 'release_push',
    label: 'Release push',
    needsVersion: true,
    hint: 'Fence to one version; bugs first, then small tickets, to drain it fast.',
  },
  {
    id: 'bug_sweep',
    label: 'Bug sweep',
    needsVersion: false,
    hint: 'Bugs from any version; by priority, oldest first. Runs dry when the sweep is done.',
  },
];

export function applyPreset(id: PresetId, versionId: string | null): { gate: string[]; policy: string[] } | null {
  if (id === 'release_push') {
    if (!versionId) return null;
    return { gate: [versionGateEntry(versionId)], policy: ['bugs', 'size', 'priority', 'age'] };
  }
  return { gate: [GATE_BUGS_ONLY], policy: ['priority', 'age'] };
}

// ── Formatting ─────────────────────────────────────────────────────

export function formatAge(iso: string | null | undefined, now: Date): string {
  if (!iso) return '—';
  const ms = now.getTime() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '—';
  // A server timestamp a few hundred ms ahead of the client clock is
  // "just now", not unknowable.
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function formatKnobValue(field: KnobField, value: unknown, versions: Version[]): string {
  if (field === 'maxActiveClaims') {
    const n = typeof value === 'number' ? value : Number(value ?? 0);
    return n === 0 ? '0 (hold)' : String(n);
  }
  const list = Array.isArray(value) ? (value as string[]) : [];
  if (field === 'dispatchGate') {
    if (list.length === 0) return 'open';
    return gateChips(list, versions)
      .map((c) => c.label)
      .join(' + ');
  }
  return list.length === 0 ? `default (${DEFAULT_DISPATCH_POLICY.join(' › ')})` : list.join(' › ');
}

// ── Audit trail ────────────────────────────────────────────────────

export interface KnobWrite {
  field: KnobField;
  oldValue: unknown;
  newValue: unknown;
  at: string;
  /** Member name, or null for a write nobody on the map matches (API key of a non-member, system). */
  actor: string | null;
}

/** Latest write per knob from a `map.field_changed` event list (newest first or any order). */
export function lastKnobWrites(events: ChangeEvent[], members: MapMember[]): Partial<Record<KnobField, KnobWrite>> {
  const nameById = new Map(members.map((m) => [m.userId, m.name]));
  const out: Partial<Record<KnobField, KnobWrite>> = {};
  for (const e of events) {
    if (e.eventType !== 'map.field_changed') continue;
    const field = e.fieldName as KnobField | null;
    if (!field || !(KNOB_FIELDS as readonly string[]).includes(field)) continue;
    const prev = out[field];
    if (prev && prev.at >= e.createdAt) continue;
    out[field] = {
      field,
      oldValue: e.oldValue,
      newValue: e.newValue,
      at: e.createdAt,
      actor: e.userId ? (nameById.get(e.userId) ?? null) : null,
    };
  }
  return out;
}

/**
 * The cap to offer when lifting a hold: the most recent non-zero value the
 * audit has seen (old or new side). Null when there is none — no invented
 * number; the field stays empty.
 */
export function lastNonZeroCap(events: ChangeEvent[]): number | null {
  const sorted = events
    .filter((e) => e.eventType === 'map.field_changed' && e.fieldName === 'maxActiveClaims')
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  for (const e of sorted) {
    for (const v of [e.newValue, e.oldValue]) {
      if (typeof v === 'number' && v > 0) return v;
    }
  }
  return null;
}

/** Newest knob write overall — the Fleet card's "last write" fact line. */
export function newestKnobWrite(writes: Partial<Record<KnobField, KnobWrite>>): KnobWrite | null {
  let best: KnobWrite | null = null;
  for (const w of Object.values(writes)) if (w && (!best || w.at > best.at)) best = w;
  return best;
}

// ── Claims ─────────────────────────────────────────────────────────

export interface ClaimRow {
  node: Node;
  session: string;
  ageHours: number | null;
  /** Older than the sweeper threshold — the worker is probably gone. */
  stale: boolean;
}

/** Every claimed node, oldest claim first, flagged when past the sweeper threshold. */
export function claimRows(nodes: Record<string, Node>, now: Date, staleHours = STALE_CLAIM_HOURS): ClaimRow[] {
  const rows: ClaimRow[] = [];
  for (const node of Object.values(nodes)) {
    if (!node.claimedBySession) continue;
    const ms = node.claimedAt ? now.getTime() - new Date(node.claimedAt).getTime() : NaN;
    const ageHours = Number.isFinite(ms) ? ms / 3_600_000 : null;
    rows.push({ node, session: node.claimedBySession, ageHours, stale: ageHours !== null && ageHours > staleHours });
  }
  rows.sort((a, b) => (b.ageHours ?? -1) - (a.ageHours ?? -1));
  return rows;
}

/** Short session label matching the mindmap's ClaimBadge. */
export function shortSession(session: string): string {
  return session.length > 8 ? '…' + session.slice(-8) : session;
}

// ── GitHub refs in free text ───────────────────────────────────────

export type RefSegment = { text: string } | { ref: string; url: string };

/**
 * Split a blockedReason into text and `#NNNN` links against the map's
 * repo. Workers write "waiting on PR #8770" — without the link a PM lands
 * in the shell to look it up. No status lookup here, just the pointer.
 */
export function linkifyRefs(text: string, repo: { owner: string; name: string } | null): RefSegment[] {
  if (!repo) return [{ text }];
  const out: RefSegment[] = [];
  const re = /#(\d{2,6})\b/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ ref: `#${m[1]}`, url: `https://github.com/${repo.owner}/${repo.name}/issues/${m[1]}` });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out.length > 0 ? out : [{ text }];
}
