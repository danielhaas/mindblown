/**
 * Requirement lifecycle stage — derived, never stored.
 *
 * Progress alone answers "is the code merged?", which is not the same
 * question as "did we get what we asked for". The register used to call
 * 100 % progress "done", and business read that as fulfilled. So the
 * stage folds two independent inputs together: the progress rollup, and
 * the sign-off verdicts recorded per gate in `requirement_acceptances`.
 *
 * The gates are deliberately NOT a pipeline. Verdicts that predate the
 * gate split were backfilled to 'business', so a business acceptance
 * without an IT verdict is a normal state, not a corrupt one — each gate
 * is an independent flag and the stage reports the furthest one reached.
 */
export type RequirementGate = 'it' | 'business';

export type RequirementStage =
  | 'open'
  | 'in_progress'
  | 'built'
  | 'it_verified'
  | 'accepted'
  | 'rejected';

/** The parts of a sign-off row the stage derivation needs. */
export interface RequirementVerdict {
  gate?: RequirementGate | null;
  decision?: 'accepted' | 'rejected' | null;
}

/** Progress at or above this counts as built (matches the register's rollup rounding). */
export const BUILT_THRESHOLD = 99.5;

/**
 * Derive the lifecycle stage from the progress rollup plus the ACTIVE
 * verdicts on the requirement. Callers pass only active rows (revoked
 * ones are filtered on the read side), so this is a pure fold.
 *
 * A rejection outranks everything: a requirement someone objected to is
 * not "done" no matter how green the rollup is — that objection is the
 * single most important thing the row can say.
 */
export function requirementStage(
  progress: number,
  verdicts: readonly RequirementVerdict[] = [],
): RequirementStage {
  if (verdicts.some((v) => v.decision === 'rejected')) return 'rejected';
  // A verdict row with no gate is a pre-split acceptance: treat it as the
  // business sign-off it was, so the backfill and the live path agree.
  const accepted = (gate: RequirementGate) =>
    verdicts.some(
      (v) => v.decision !== 'rejected' && (v.gate ?? 'business') === gate,
    );
  if (accepted('business')) return 'accepted';
  if (accepted('it')) return 'it_verified';
  if (progress >= BUILT_THRESHOLD) return 'built';
  return progress > 0 ? 'in_progress' : 'open';
}

/**
 * German labels — the register, the Word export and the MCP overview all
 * speak to the same (German-speaking) business readers, so the wording
 * lives in one place. "Gebaut" rather than "Umgesetzt"/"Done": at 100 %
 * progress the only thing the system actually knows is that the code
 * landed. "Abgenommen" is reserved for a real verdict.
 */
export const STAGE_LABEL: Record<RequirementStage, string> = {
  open: 'Offen',
  in_progress: 'In Umsetzung',
  built: 'Gebaut',
  it_verified: 'IT-geprüft',
  accepted: 'Abgenommen',
  rejected: 'Zurückgewiesen',
};

/**
 * Funnel order, least to most complete. Green is reserved for the last
 * two — see STAGE_COLOR: if "Gebaut" stayed green, renaming it would
 * change nothing for anyone skimming the column.
 */
export const STAGE_ORDER: RequirementStage[] = [
  'accepted',
  'it_verified',
  'built',
  'in_progress',
  'open',
  'rejected',
];

/** Chip colours, shared by the register UI and the docx cell shading. */
export const STAGE_COLOR: Record<RequirementStage, { bg: string; fg: string }> = {
  open: { bg: '#f1f5f9', fg: '#475569' },
  in_progress: { bg: '#fef3c7', fg: '#92400e' },
  built: { bg: '#dbeafe', fg: '#1e40af' },
  it_verified: { bg: '#ccfbf1', fg: '#0f766e' },
  accepted: { bg: '#d1fae5', fg: '#065f46' },
  rejected: { bg: '#fee2e2', fg: '#991b1b' },
};

/** Count requirements per stage, always returning every key (0 included). */
export function stageCounts(
  stages: readonly RequirementStage[],
): Record<RequirementStage, number> {
  const counts = {
    open: 0,
    in_progress: 0,
    built: 0,
    it_verified: 0,
    accepted: 0,
    rejected: 0,
  } as Record<RequirementStage, number>;
  for (const s of stages) counts[s]++;
  return counts;
}

/**
 * GitHub links for a requirement row.
 *
 * A requirement is a business statement; the issues that implement it
 * usually hang off the work nodes beneath it, not off the requirement
 * itself. Progress, effort and health already roll up from those
 * descendants — so the links have to as well, or a requirement that is
 * 100% done *because* three issues closed renders as having none.
 *
 * Own links come first and win: if the same issue is linked both on the
 * requirement and on a child, it is reported once, as not-inherited.
 */
export interface GhLinkSource {
  externalLinks?: Array<{
    provider: string;
    externalId: string;
    url: string;
    state?: 'open' | 'closed';
    isPullRequest?: boolean;
  }> | null;
  childrenIds?: string[] | null;
}

export interface RequirementGhLink {
  externalId: string;
  url: string;
  /** true = found on a descendant, not on the requirement node itself */
  inherited: boolean;
  /** Absent when the link predates the state field, or provider isn't synced */
  state?: 'open' | 'closed';
  /** True when the linked number is a pull request, not an issue */
  isPullRequest?: boolean;
}

export function collectRequirementGhLinks<T extends GhLinkSource>(
  nodeById: (id: string) => T | undefined,
  requirementId: string,
): RequirementGhLink[] {
  const node = nodeById(requirementId);
  if (!node) return [];

  const byId = new Map<string, RequirementGhLink>();
  for (const l of node.externalLinks ?? []) {
    if (l.provider === 'github' && !byId.has(l.externalId)) {
      byId.set(l.externalId, {
        externalId: l.externalId,
        url: l.url,
        inherited: false,
        state: l.state,
        isPullRequest: l.isPullRequest,
      });
    }
  }

  // Breadth-first over a queue, not a stack: a stack pops the last child
  // first and would surface sibling issues in reverse document order.
  const queue = [...(node.childrenIds ?? [])];
  const visited = new Set<string>([requirementId]);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    if (visited.has(id)) continue; // cycle guard — a malformed tree must not hang the view
    visited.add(id);
    const child = nodeById(id);
    if (!child) continue;
    for (const l of child.externalLinks ?? []) {
      if (l.provider === 'github' && !byId.has(l.externalId)) {
        byId.set(l.externalId, {
          externalId: l.externalId,
          url: l.url,
          inherited: true,
          state: l.state,
          isPullRequest: l.isPullRequest,
        });
      }
    }
    queue.push(...(child.childrenIds ?? []));
  }

  return [...byId.values()];
}
