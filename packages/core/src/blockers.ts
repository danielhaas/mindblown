/**
 * Blockers grouped by root cause and unblocker (#322) — shared by the PM
 * Cockpit, the Blocked panel and the MCP blocked_digest. The PM decides on
 * causes ("12 PRs waiting on CI — Dan"), not on 200 free-text reasons.
 */

export type BlockerKind =
  | 'stalled'
  | 'orphaned_claim'
  | 'merge_blocked'
  | 'pr_open'
  | 'decision'
  | 'external'
  | 'dependency'
  | 'other';

export interface BlockerGroup {
  kind: BlockerKind;
  label: string;
  /** Who can unblock it, when the reason names someone. */
  unblocker: string | null;
  nodeIds: string[];
}

/**
 * Cause vocabulary, tested in order. Round 2 (Jenna) showed that keying on
 * the reason text collapses only byte-identical strings — 133 of 136 groups
 * were singletons while 41 nodes shared one cause ("CI red on main"). The
 * PM decides on causes, so the classifier names causes, not tickets.
 */
const BLOCKER_KINDS: { kind: BlockerKind; label: string; re: RegExp }[] = [
  { kind: 'orphaned_claim', label: 'Claim swept off a worker — in progress with nobody on it', re: /swept off|nobody on it|orphan/i },
  {
    kind: 'merge_blocked',
    label: 'Code done, cannot merge — CI red on main / migration fork / Actions not dispatching',
    re: /ci (is )?red|red ci|main (is )?red|cannot merge|can't merge|migration[- ]?(graph )?fork|not dispatch|workflow scope|merge[- ]blocked|blocks merging/i,
  },
  { kind: 'pr_open', label: 'PR open, waiting for review or checks', re: /\bPRs?\b.*(open|review|green|pending|approv)|pull request|awaiting review|in review/i },
  {
    kind: 'decision',
    label: 'Waiting on a named decision',
    re: /\bgate\b|entscheid|decision|decide|ruling|klärung|klaerung|wartet auf|waiting (on|for) (dan|thomas|rita|daniel|alpine|the )|needs? (dan|thomas|rita|daniel)|spec from|sign-?off/i,
  },
  { kind: 'external', label: 'External party, no date', re: /extern|pentest|vendor|provider|third[- ]party|supplier|lieferant|awaiting .* from/i },
];

// The person after a 'needs / waiting on / wartet auf / decision by' — no name list.
const NAME_RE = /(?:needs?|waiting (?:on|for)|wartet auf|entscheid|decision (?:by|from)|spec from|from)\s+(?!Entscheid|Decision|Gate|Spec|Review|The\b|Der\b|Die\b|Das\b)([A-ZÄÖÜ][a-zäöüß]+)/i;

export function classifyBlocker(reason: string): BlockerKind {
  for (const k of BLOCKER_KINDS) if (k.re.test(reason)) return k.kind;
  return 'other';
}

/** One open, blocked leaf — what the grouping needs to know about it. */
export interface BlockedItem {
  id: string;
  /** The manual blocker text, or null when only waiting on predecessors. */
  blockedReason: string | null;
  /** Unfinished finish-to-start predecessors. */
  predecessorIds: string[];
  /** In progress with nobody on it (core findStalled); used only when no reason or predecessor applies. */
  stalled?: boolean;
}

/** Label of the stalled cause group — the same words on every surface. */
export const STALLED_GROUP_LABEL = 'Stalled — in progress, nobody working on it';

/**
 * Group open blocked leaves by cause: a manual reason is classified
 * (decisions are split per named person); a leaf blocked only by
 * predecessors joins "Waiting on a predecessor task"; a stalled leaf
 * (findStalled) joins the stalled group. Stalled work and orphaned claims
 * first, then merge blocks, then by size.
 */
export function groupBlockers(items: BlockedItem[]): BlockerGroup[] {
  const byKey = new Map<string, BlockerGroup>();
  const add = (key: string, g: Omit<BlockerGroup, 'nodeIds'>, id: string) => {
    const cur = byKey.get(key) ?? { ...g, nodeIds: [] };
    cur.nodeIds.push(id);
    byKey.set(key, cur);
  };

  for (const n of items) {
    if (n.blockedReason) {
      const kind = classifyBlocker(n.blockedReason);
      const def = BLOCKER_KINDS.find((k) => k.kind === kind);
      const who = kind === 'decision' ? (NAME_RE.exec(n.blockedReason)?.[1] ?? null) : null;
      if (kind === 'other') {
        add('other', { kind, label: 'Other reasons (see Blocked panel)', unblocker: null }, n.id);
      } else {
        add(`${kind}:${who ?? ''}`, { kind, label: who ? `${def!.label} — ${who}` : def!.label, unblocker: who }, n.id);
      }
    } else if (n.predecessorIds.length) {
      add('dependency', { kind: 'dependency', label: 'Waiting on a predecessor task', unblocker: null }, n.id);
    } else if (n.stalled) {
      add('stalled', { kind: 'stalled', label: STALLED_GROUP_LABEL, unblocker: null }, n.id);
    }
  }

  const rank: Record<BlockerKind, number> = { stalled: 0, orphaned_claim: 0, merge_blocked: 1, decision: 2, pr_open: 3, external: 4, dependency: 5, other: 6 };
  return [...byKey.values()].sort((a, b) => rank[a.kind] - rank[b.kind] || b.nodeIds.length - a.nodeIds.length);
}
