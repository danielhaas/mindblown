import type {
  Node,
  NodeId,
  NodeMap,
  ScheduledNode,
  CriticalPathResult,
  EffortUnit,
} from './types.js';
import { hoursToBusinessDays } from './calendar.js';

/**
 * Check whether adding a dependency from `fromNodeId` -> `toNodeId` would
 * create a cycle in the dependency graph.
 *
 * "fromNodeId depends on toNodeId" means we add an edge from fromNodeId to toNodeId.
 * A cycle exists if toNodeId can already reach fromNodeId via existing dependency edges.
 *
 * Dependency edges go: a node's `dependencies` array lists what it depends ON (upstream).
 * So if node B has dependency { targetNodeId: A }, B depends on A (A -> B in schedule order).
 * For cycle detection when adding "fromNodeId depends on toNodeId":
 *   We check if fromNodeId is reachable from toNodeId by following existing dependency targets.
 */
export function hasCycle(
  fromNodeId: NodeId,
  toNodeId: NodeId,
  nodeMap: NodeMap,
): boolean {
  // Would adding "fromNodeId depends on toNodeId" create a cycle?
  // Check if toNodeId can reach fromNodeId via existing dependency edges.
  const visited = new Set<NodeId>();
  const stack: NodeId[] = [toNodeId];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === fromNodeId) return true; // cycle detected
    if (visited.has(current)) continue;
    visited.add(current);

    const node = nodeMap.get(current);
    if (!node) continue;
    for (const dep of node.dependencies) {
      stack.push(dep.targetNodeId);
    }
  }

  return false;
}

/**
 * Topological sort of nodes by dependency edges (Kahn's algorithm).
 *
 * Returns nodes in dependency order: a node appears after all of its dependencies.
 * Throws if a cycle is detected (should not happen if hasCycle is used correctly).
 */
export function topologicalSort(nodes: Node[]): Node[] {
  const nodeMap = new Map<NodeId, Node>();
  for (const node of nodes) {
    nodeMap.set(node.id, node);
  }

  // Build in-degree map: how many nodes depend on each node?
  // Actually, we need: for each node, how many of its dependencies exist in the set.
  // In-degree = number of dependencies a node has (that are in the set).
  const inDegree = new Map<NodeId, number>();
  // Reverse adjacency: for each target, which nodes depend on it?
  const dependents = new Map<NodeId, NodeId[]>();

  for (const node of nodes) {
    if (!inDegree.has(node.id)) inDegree.set(node.id, 0);
    if (!dependents.has(node.id)) dependents.set(node.id, []);

    for (const dep of node.dependencies) {
      if (!nodeMap.has(dep.targetNodeId)) continue; // skip external deps
      inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1);
      if (!dependents.has(dep.targetNodeId)) dependents.set(dep.targetNodeId, []);
      dependents.get(dep.targetNodeId)!.push(node.id);
    }
  }

  // Start with nodes that have no dependencies (in-degree 0)
  const queue: NodeId[] = [];
  for (const [nodeId, degree] of inDegree) {
    if (degree === 0) queue.push(nodeId);
  }

  const sorted: Node[] = [];

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    const currentNode = nodeMap.get(currentId)!;
    sorted.push(currentNode);

    for (const dependentId of dependents.get(currentId) ?? []) {
      const newDegree = (inDegree.get(dependentId) ?? 1) - 1;
      inDegree.set(dependentId, newDegree);
      if (newDegree === 0) {
        queue.push(dependentId);
      }
    }
  }

  if (sorted.length !== nodes.length) {
    throw new Error('Cycle detected in dependency graph — topological sort failed');
  }

  return sorted;
}

/**
 * Collect all leaf descendant IDs for a node (recursive).
 */
function getLeafDescendants(nodeId: NodeId, nodeMap: Map<NodeId, Node>): NodeId[] {
  const node = nodeMap.get(nodeId);
  if (!node) return [];
  if (node.childrenIds.length === 0) return [nodeId];

  const leaves: NodeId[] = [];
  for (const childId of node.childrenIds) {
    leaves.push(...getLeafDescendants(childId, nodeMap));
  }
  return leaves;
}

/**
 * Propagate parent-node dependencies down to leaf nodes.
 *
 * When a dependency involves a parent node, we expand it so that:
 * - FS (A→B): All leaves in B depend on all leaves in A finishing
 * - SS (A→B): All leaves in B depend on the earliest leaf in A starting
 * - FF (A→B): All leaves in B's finish constrained by A's leaves finishing
 * - SF (A→B): All leaves in B's finish constrained by A's leaves starting
 *
 * Returns a new node array with synthetic dependencies added to leaf nodes.
 * The original nodes are not mutated.
 */
function expandParentDependencies(nodes: Node[]): Node[] {
  const nodeMap = new Map<NodeId, Node>();
  for (const n of nodes) nodeMap.set(n.id, n);

  // Cache leaf descendants per node
  const leafCache = new Map<NodeId, NodeId[]>();
  function leafsOf(id: NodeId): NodeId[] {
    if (!leafCache.has(id)) {
      leafCache.set(id, getLeafDescendants(id, nodeMap));
    }
    return leafCache.get(id)!;
  }

  // Collect synthetic deps to add: Map<leafNodeId, extra deps[]>
  const extraDeps = new Map<NodeId, Node['dependencies']>();

  for (const node of nodes) {
    for (const dep of node.dependencies) {
      const sourceIsParent = node.childrenIds.length > 0;
      const targetNode = nodeMap.get(dep.targetNodeId);
      const targetIsParent = targetNode ? targetNode.childrenIds.length > 0 : false;

      if (!sourceIsParent && !targetIsParent) continue; // both leaves, nothing to expand

      const sourceLeaves = leafsOf(node.id);
      const targetLeaves = leafsOf(dep.targetNodeId);

      if (sourceLeaves.length === 0 || targetLeaves.length === 0) continue;

      // For FS: each source leaf depends on every target leaf
      // (source can't start until target finishes)
      for (const srcLeaf of sourceLeaves) {
        if (!extraDeps.has(srcLeaf)) extraDeps.set(srcLeaf, []);
        for (const tgtLeaf of targetLeaves) {
          if (srcLeaf === tgtLeaf) continue;
          extraDeps.get(srcLeaf)!.push({
            targetNodeId: tgtLeaf,
            type: dep.type,
            lag: dep.lag,
          });
        }
      }
    }
  }

  if (extraDeps.size === 0) return nodes; // no parent deps, skip cloning

  // Clone nodes that need extra deps
  return nodes.map((n) => {
    const extra = extraDeps.get(n.id);
    if (!extra) return n;

    // Deduplicate: avoid adding deps that already exist
    const existingKeys = new Set(n.dependencies.map(d => `${d.targetNodeId}:${d.type}`));
    const newDeps = extra.filter(d => !existingKeys.has(`${d.targetNodeId}:${d.type}`));
    if (newDeps.length === 0) return n;

    return {
      ...n,
      dependencies: [...n.dependencies, ...newDeps],
    };
  });
}

/**
 * Per-node constraints that pin a node's schedule in place.
 *
 * - `minStart`: forces computedStart >= this value (e.g. user-set startDate)
 * - `maxEnd`: forces computedEnd >= this value (e.g. user-set dueDate acts as a
 *   target end; we bump duration or push start as needed in a minimal way)
 *
 * Values are in the same unit as the rest of the scheduler (days/hours/points
 * relative to projectStartDay). The caller converts calendar dates.
 */
export interface ScheduleConstraint {
  minStart?: number;
  maxEnd?: number;
}

/**
 * Optional context for the scheduler.
 *
 * - `effortUnit` / `hoursPerDay`: when the map stores effort in hours,
 *   leaf durations are converted to business days via
 *   `ceil(effortEstimate / hoursPerDay)` before scheduling. Ignored when
 *   `effortUnit` is `'days'` or `'points'`.
 */
export interface ScheduleContext {
  effortUnit?: EffortUnit;
  hoursPerDay?: number;
}

// Priority enum ordering for resolved sibling sort. Lower index = higher priority.
const PRIORITY_ORDER: Record<string, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};

/**
 * Return the resolved sibling order for the children of `parent`.
 *
 * Sort key: priorityRank ASC NULLS LAST → priority enum (P0 < P1 < P2 < P3) → createdAt ASC.
 *
 * Exported (as a named export + re-exported from index) so the orchestration
 * substrate's `ready_nodes` handler can reuse it for ordering results.
 */
export function resolvedSiblingOrder(children: Node[]): Node[] {
  return [...children].sort((a, b) => {
    // 1. priorityRank ASC NULLS LAST
    const ra = a.priorityRank;
    const rb = b.priorityRank;
    if (ra !== null && rb !== null) {
      if (ra !== rb) return ra - rb;
    } else if (ra !== null) {
      return -1; // a has rank, b doesn't → a first
    } else if (rb !== null) {
      return 1; // b has rank, a doesn't → b first
    }

    // 2. priority enum (P0 < P1 < P2 < P3), null last
    const pa = a.priority ? (PRIORITY_ORDER[a.priority] ?? 99) : 99;
    const pb = b.priority ? (PRIORITY_ORDER[b.priority] ?? 99) : 99;
    if (pa !== pb) return pa - pb;

    // 3. createdAt ASC
    return a.createdAt.localeCompare(b.createdAt);
  });
}

/**
 * For nodes whose parent has `childrenScheduling = 'sequential'`, inject
 * synthetic FS dependency edges so the scheduler chains them in resolved
 * sibling order. Explicit dependency edges are left untouched and continue
 * to take precedence (the topo sort enforces explicit deps first).
 *
 * Returns a new nodes array; original nodes are not mutated.
 */
function injectSequentialDeps(nodes: Node[]): Node[] {
  // Build a WORKING nodeMap whose dep arrays are mutable copies. As each
  // synthetic edge is added we mutate the working node's `dependencies`,
  // so subsequent hasCycle checks (for OTHER parents in the same pass)
  // see the synthetic edges added by earlier parents. Without this, the
  // cycle guard only catches cycles formed by EXISTING edges; cycles
  // formed by combining synthetic chains from sibling parents slip
  // through and crash topologicalSort downstream.
  const nodeMap = new Map<NodeId, Node>();
  for (const n of nodes) {
    nodeMap.set(n.id, { ...n, dependencies: [...n.dependencies] });
  }

  // Map from child id → extra synthetic deps to prepend
  const extras = new Map<NodeId, Node['dependencies']>();

  for (const parent of nodes) {
    if (parent.childrenScheduling !== 'sequential') continue;
    if (parent.childrenIds.length < 2) continue;

    // Resolve only children that are actually in our node set
    const presentChildren = parent.childrenIds
      .map((cid) => nodeMap.get(cid))
      .filter((n): n is Node => n !== undefined);

    if (presentChildren.length < 2) continue;

    const ordered = resolvedSiblingOrder(presentChildren);

    for (let i = 1; i < ordered.length; i++) {
      const predecessor = ordered[i - 1];
      const follower = ordered[i];

      // Only inject if the follower doesn't already have an explicit FS dep
      // on this predecessor (to avoid duplicates).
      const alreadyHas = follower.dependencies.some(
        (d) => d.targetNodeId === predecessor.id && d.type === 'FS',
      );
      if (alreadyHas) continue;

      // Skip if predecessor already (transitively) depends on follower —
      // injecting FS(follower → predecessor) would close a cycle and crash
      // topologicalSort. The user's explicit edge wins; siblings stay
      // parallel for this pair. Uses the working nodeMap so it sees
      // synthetic edges added by earlier parents in this same pass.
      if (hasCycle(follower.id, predecessor.id, nodeMap)) continue;

      const synthetic = {
        targetNodeId: predecessor.id,
        type: 'FS' as const,
        lag: 0,
      };

      if (!extras.has(follower.id)) extras.set(follower.id, []);
      extras.get(follower.id)!.push(synthetic);

      // CRITICAL: mutate the working nodeMap so subsequent hasCycle calls
      // see this edge. Without this, cross-parent cycles slip through.
      nodeMap.get(follower.id)!.dependencies.push(synthetic);
    }
  }

  if (extras.size === 0) return nodes;

  return nodes.map((n) => {
    const extra = extras.get(n.id);
    if (!extra) return n;
    return {
      ...n,
      dependencies: [...extra, ...n.dependencies],
    };
  });
}

/**
 * Forward-pass scheduling.
 *
 * Given nodes with effort estimates and dependencies, compute the earliest
 * possible start and end for each node.
 *
 * `projectStartDay` is day 0. All dates are in the map's effort unit (days/hours/points).
 * Optional `constraints` pin individual nodes in place (manually-set dates).
 * Optional `context` enables business-day unit conversion (hours → business days).
 * Returns a ScheduledNode for every input node.
 */
export function schedule(
  nodes: Node[],
  projectStartDay: number = 0,
  constraints?: Map<NodeId, ScheduleConstraint>,
  context?: ScheduleContext,
): ScheduledNode[] {
  // Order matters: expand parent-level deps to leaves FIRST, then inject
  // implicit sequential FS chains. With expansion-first, the injection's
  // hasCycle guard sees the cartesian-product edges that expansion adds
  // (a parent-level dep becomes N×M leaf edges, one per leaf in source ×
  // each leaf in target), so it correctly skips synthetic edges that
  // would close cycles formed via those expanded edges.
  //
  // Doing it the other way around (inject → expand) made the cycle guard
  // blind to edges that only exist after expansion, and topological sort
  // crashed downstream once expansion added the missing leg of the cycle.
  //
  // The try/catch is defense in depth: if a cycle still slips through
  // (e.g. the pre-existing graph itself is cyclic), fall back to running
  // the topo sort without sequential injection. The API returns a partial
  // schedule instead of a 500, and the Gantt stays usable.
  let sorted: Node[];
  let expanded: Node[];
  try {
    expanded = expandParentDependencies(nodes);
    const sequenced = injectSequentialDeps(expanded);
    sorted = topologicalSort(sequenced);
    expanded = sequenced; // downstream uses `expanded` for the duration map
  } catch (err) {
    if (err instanceof Error && /Cycle detected/.test(err.message)) {
      // eslint-disable-next-line no-console
      console.warn(
        '[scheduler] cycle detected after sequential injection; falling back to no implicit chains for this run',
      );
      expanded = expandParentDependencies(nodes);
      sorted = topologicalSort(expanded);
    } else {
      throw err;
    }
  }

  const nodeMap = new Map<NodeId, Node>();
  for (const node of expanded) {
    nodeMap.set(node.id, node);
  }

  const scheduled = new Map<NodeId, ScheduledNode>();

  // Business-day conversion: when effortUnit is 'hours', convert leaf effort
  // to business days using ceil(hours / hoursPerDay). This makes a 12h estimate
  // with an 8h day render as 2 business-day bars instead of 12 unit-bars.
  const useHoursConversion =
    context?.effortUnit === 'hours' &&
    context.hoursPerDay !== undefined &&
    context.hoursPerDay > 0;

  function leafDuration(effortEstimate: number | null): number {
    const raw = effortEstimate ?? 0;
    if (useHoursConversion) {
      return hoursToBusinessDays(raw, context!.hoursPerDay!);
    }
    return raw;
  }

  for (const node of sorted) {
    let duration =
      node.childrenIds.length === 0
        ? leafDuration(node.effortEstimate)
        : 0;

    let earliestStart = projectStartDay;

    for (const dep of node.dependencies) {
      const target = scheduled.get(dep.targetNodeId);
      if (!target) continue; // dependency not in this set

      let constraint: number;
      switch (dep.type) {
        case 'FS':
          constraint = target.computedEnd + dep.lag;
          break;
        case 'SS':
          constraint = target.computedStart + dep.lag;
          break;
        case 'FF':
          constraint = target.computedEnd + dep.lag - duration;
          break;
        case 'SF':
          constraint = target.computedStart + dep.lag - duration;
          break;
      }

      earliestStart = Math.max(earliestStart, constraint);
    }

    // Apply per-node pinning constraints. minStart pushes the start forward;
    // maxEnd stretches duration to force end alignment (a manual due date
    // acts as a hard deadline the bar must reach).
    const pin = constraints?.get(node.id);
    if (pin) {
      if (pin.minStart !== undefined) {
        earliestStart = Math.max(earliestStart, pin.minStart);
      }
      if (pin.maxEnd !== undefined && node.childrenIds.length === 0) {
        const requiredDuration = pin.maxEnd - earliestStart;
        if (requiredDuration > duration) duration = requiredDuration;
      }
    }

    scheduled.set(node.id, {
      nodeId: node.id,
      computedStart: earliestStart,
      computedEnd: earliestStart + duration,
      duration,
    });
  }

  // For parent nodes, compute start/end from children
  for (const node of expanded) {
    if (node.childrenIds.length === 0) continue;
    const s = scheduled.get(node.id)!;
    let minStart = Infinity;
    let maxEnd = 0;
    for (const childId of node.childrenIds) {
      const child = scheduled.get(childId);
      if (!child) continue;
      minStart = Math.min(minStart, child.computedStart);
      maxEnd = Math.max(maxEnd, child.computedEnd);
    }
    if (minStart !== Infinity) {
      s.computedStart = minStart;
      s.computedEnd = maxEnd;
      s.duration = maxEnd - minStart;
    }
  }

  // Return in original node order (using original IDs)
  return nodes.map((n) => scheduled.get(n.id)!);
}

/**
 * Critical Path Method (CPM).
 *
 * 1. Forward pass: earliest start/end for each node.
 * 2. Backward pass: latest start/end without delaying the project.
 * 3. Float = latestStart - earliestStart. Zero float = critical path.
 * 4. Returns the chain of zero-float nodes and total project duration.
 */
export function criticalPath(nodes: Node[]): CriticalPathResult {
  if (nodes.length === 0) {
    return { path: [], totalDuration: 0, float: {} };
  }

  // Expand parent-node dependencies to leaf-node dependencies
  const expanded = expandParentDependencies(nodes);

  const sorted = topologicalSort(expanded);
  const nodeMap = new Map<NodeId, Node>();
  for (const node of expanded) {
    nodeMap.set(node.id, node);
  }

  // ── Forward pass ──────────────────────────────────────────
  const earliest = new Map<NodeId, { start: number; end: number; duration: number }>();

  for (const node of sorted) {
    const duration =
      node.childrenIds.length === 0
        ? (node.effortEstimate ?? 0)
        : 0;

    let earliestStart = 0;

    for (const dep of node.dependencies) {
      const target = earliest.get(dep.targetNodeId);
      if (!target) continue;

      let constraint: number;
      switch (dep.type) {
        case 'FS':
          constraint = target.end + dep.lag;
          break;
        case 'SS':
          constraint = target.start + dep.lag;
          break;
        case 'FF':
          constraint = target.end + dep.lag - duration;
          break;
        case 'SF':
          constraint = target.start + dep.lag - duration;
          break;
      }
      earliestStart = Math.max(earliestStart, constraint);
    }

    earliest.set(node.id, {
      start: earliestStart,
      end: earliestStart + duration,
      duration,
    });
  }

  // Project end = max of all earliest ends
  let projectEnd = 0;
  for (const [, val] of earliest) {
    projectEnd = Math.max(projectEnd, val.end);
  }

  // ── Backward pass ─────────────────────────────────────────
  // Build reverse dependency map: for each node, which nodes depend on it?
  const dependents = new Map<NodeId, { nodeId: NodeId; dep: Node['dependencies'][0] }[]>();
  for (const node of expanded) {
    for (const dep of node.dependencies) {
      if (!dependents.has(dep.targetNodeId)) {
        dependents.set(dep.targetNodeId, []);
      }
      dependents.get(dep.targetNodeId)!.push({ nodeId: node.id, dep });
    }
  }

  const latest = new Map<NodeId, { start: number; end: number }>();

  // Process in reverse topological order
  for (let i = sorted.length - 1; i >= 0; i--) {
    const node = sorted[i];
    const e = earliest.get(node.id)!;

    let latestEnd = projectEnd;

    // For each node that depends on this node, constrain our latest end
    for (const { nodeId: depNodeId, dep } of dependents.get(node.id) ?? []) {
      const depLatest = latest.get(depNodeId);
      if (!depLatest) continue;

      const depDuration = earliest.get(depNodeId)!.duration;
      let constraint: number;
      switch (dep.type) {
        case 'FS':
          constraint = depLatest.start - dep.lag;
          break;
        case 'SS':
          constraint = depLatest.start - dep.lag + e.duration;
          break;
        case 'FF':
          constraint = depLatest.end - dep.lag;
          break;
        case 'SF':
          constraint = depLatest.end - dep.lag + e.duration - depDuration;
          break;
      }
      latestEnd = Math.min(latestEnd, constraint);
    }

    latest.set(node.id, {
      start: latestEnd - e.duration,
      end: latestEnd,
    });
  }

  // ── Compute float and find critical path ──────────────────
  const floatMap: Record<NodeId, number> = {};
  const criticalNodes: NodeId[] = [];

  for (const node of sorted) {
    const e = earliest.get(node.id)!;
    const l = latest.get(node.id)!;
    const totalFloat = l.start - e.start;
    floatMap[node.id] = totalFloat;

    // Zero float (with small epsilon for floating point) and non-zero duration
    if (Math.abs(totalFloat) < 1e-9 && e.duration > 0) {
      criticalNodes.push(node.id);
    }
  }

  return {
    path: criticalNodes,
    totalDuration: projectEnd,
    float: floatMap,
  };
}

// ── Orchestration substrate (#111) ──────────────────────────────

/**
 * Check whether `node` is "ready" to start given the current state of the
 * node map and its dependency edges.
 *
 * A node is ready when ALL of the following hold:
 *   1. Its status category is NOT 'done' and NOT 'in_progress'
 *      (callers use status strings; this predicate treats any non-null
 *       status mapping to a 'done' statusDef category as satisfied).
 *      Since the predicate itself doesn't know the map's statusWorkflow,
 *      callers supply a `isDone(status)` predicate for the "is predecessor
 *      done" check. A node whose own status is done is NOT returned
 *      (callers should filter by status='todo' before calling).
 *   2. `claimedBySession` is null (not currently claimed by any session).
 *   3. Every predecessor (per dependency edges, all 4 types) is done.
 *      "Done" is determined purely by `status`: a predecessor is satisfied
 *      if `isDone(predecessor.status)` returns true. Start/end semantics
 *      of FS/SS/FF/SF are not interpreted for ready-checking; we only
 *      ask "did the predecessor complete?".
 *
 * @param node - Candidate node to test.
 * @param nodeMap - All nodes in the map (for predecessor lookup).
 * @param isDone - Callback that returns true when a status string maps to a
 *   'done' category in the map's workflow. Returns false for null status.
 */
export function isReady(
  node: Node,
  nodeMap: NodeMap,
  isDone: (status: string | null) => boolean,
): boolean {
  // Claimed nodes are not available
  if (node.claimedBySession !== null) return false;

  // All direct dependency predecessors must be done.
  // We check all 4 dep types — the ready-check semantics are uniform:
  // "was the predecessor completed?" regardless of FS/SS/FF/SF.
  for (const dep of node.dependencies) {
    const predecessor = nodeMap.get(dep.targetNodeId);
    if (!predecessor) continue; // predecessor not in this map — skip
    if (!isDone(predecessor.status)) return false;
  }

  return true;
}

/**
 * Compute the scope overlap between two sets of scope tags.
 *
 * Returns the set of tags that appear in both `a` and `b`.
 * An empty result means no overlap.
 * If either set is empty, there is no overlap (empty-vs-anything = no conflict).
 *
 * Symmetry: scopeOverlap(a, b) produces the same elements as scopeOverlap(b, a).
 */
export function scopeOverlap(a: string[], b: string[]): string[] {
  if (a.length === 0 || b.length === 0) return [];
  const setA = new Set(a);
  return b.filter((tag) => setA.has(tag));
}
