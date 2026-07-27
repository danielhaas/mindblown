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
