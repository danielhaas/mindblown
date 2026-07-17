import type { Node } from '@mindblown/core';

/**
 * Shared scope-filter walk for the version / sprint / phase filters.
 *
 * This used to live as three near-identical copies: the store's
 * `getVisibleNodes` (`inheritDfs`), KanbanView's leaf pre-filter, and
 * GanttView's row pre-filter. All three now call `collectScopeMatches`
 * so the inheritance semantics can never drift apart again (the phase
 * filter is the third tag that would otherwise have to be added in
 * three places).
 *
 * Semantic: a node is a DIRECT match if its effective version, cycle,
 * and phase each match every active filter (AND), where "effective"
 * means the node's own tag OR the nearest tagged ancestor. This lets
 * users tag an epic/branch and see the entire subtree under it, while
 * still supporting leaf-level tags (a leaf's own tag overrides the
 * inherited one).
 *
 * Callers that need a connected tree (the store) expand the result with
 * ancestors themselves; flat views (Kanban, Gantt) use the direct
 * matches as-is.
 */
export interface ScopeFilters {
  versionId: string | null;
  cycleId: string | null;
  phaseId: string | null;
}

/** True when at least one scope filter is active. */
export function hasActiveScopeFilter(filters: ScopeFilters): boolean {
  return !!(filters.versionId || filters.cycleId || filters.phaseId);
}

/**
 * Resolve an active filter id to the chip that announces it in the UI.
 *
 * Keyed on the ACTIVE ID, not on whether the id still resolves against
 * the definition list: if the referenced definition vanishes from under
 * the filter (WS map sync / map reload — phases have no
 * delete-clears-filter hook the way deleteVersion has), the filter still
 * restricts every view, so the chip and the "Clear all filters" button
 * must stay visible and clickable. We fall back to `unknownLabel` for
 * the chip text instead of silently dropping the user's only UI path to
 * clearing the filter.
 *
 * Returns null only when no filter is active.
 */
export function resolveFilterChip(
  activeId: string | null,
  defs: { id: string; name: string }[],
  unknownLabel: string,
): { id: string; name: string } | null {
  if (!activeId) return null;
  const def = defs.find((d) => d.id === activeId);
  return def ? { id: def.id, name: def.name } : { id: activeId, name: unknownLabel };
}

/**
 * DFS from `rootId`, propagating inherited version/cycle/phase tags
 * downward, and collect the ids of every node whose effective tags
 * match ALL active filters (AND semantics). Inactive filters (null)
 * match everything. Returns an empty set when no filter is active —
 * callers guard with `hasActiveScopeFilter` before treating the set
 * as a restriction.
 */
export function collectScopeMatches(
  nodes: Record<string, Node>,
  rootId: string,
  filters: ScopeFilters,
): Set<string> {
  const matches = new Set<string>();
  if (!hasActiveScopeFilter(filters)) return matches;

  const { versionId, cycleId, phaseId } = filters;

  function walk(
    nodeId: string,
    inheritedVersion: string | null,
    inheritedCycle: string | null,
    inheritedPhase: string | null,
  ) {
    const node = nodes[nodeId];
    if (!node) return;
    const effVersion = node.versionId ?? inheritedVersion;
    const effCycle = node.cycleId ?? inheritedCycle;
    const effPhase = node.phaseId ?? inheritedPhase;
    const matchesVersion = !versionId || effVersion === versionId;
    const matchesCycle = !cycleId || effCycle === cycleId;
    const matchesPhase = !phaseId || effPhase === phaseId;
    if (matchesVersion && matchesCycle && matchesPhase) {
      matches.add(nodeId);
    }
    for (const childId of node.childrenIds) {
      walk(childId, effVersion, effCycle, effPhase);
    }
  }
  walk(rootId, null, null, null);

  return matches;
}
