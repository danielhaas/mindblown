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

// Priority enum ordering. Lower number = higher priority.
// P0 = 0 (highest), P1 = 1, P2 = 2, P3 = 3, null = 4 (lowest).
const PRIORITY_ENUM_ORDER: Record<string, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};

function priorityEnumNum(p: Node['priority']): number {
  if (!p) return 4;
  return PRIORITY_ENUM_ORDER[p] ?? 4;
}

/**
 * Sort a list of nodes (typically siblings under a single parent) by
 * priorityRank ASC NULLS LAST → priority enum (P0 < P1 < P2 < P3) → createdAt ASC.
 *
 * Used by the orchestration substrate (`ready_nodes`) to order what to
 * dispatch next; not used by the scheduler itself, which uses effective
 * priority via inheritance instead.
 */
export function resolvedSiblingOrder(children: Node[]): Node[] {
  return [...children].sort((a, b) => {
    const ra = a.priorityRank;
    const rb = b.priorityRank;
    if (ra !== null && rb !== null) {
      if (ra !== rb) return ra - rb;
    } else if (ra !== null) {
      return -1;
    } else if (rb !== null) {
      return 1;
    }
    const pa = priorityEnumNum(a.priority);
    const pb = priorityEnumNum(b.priority);
    if (pa !== pb) return pa - pb;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

/**
 * Priority-inheritance scheduler.
 *
 * Model: every node has a priority. The Gantt is a single linear queue
 * sorted by priority — item 1 starts at the project start, item 2 starts
 * when item 1 ends, item 3 when item 2 ends, and so on. Tree structure is
 * for visual grouping only; scheduling operates on leaf nodes (work items).
 *
 * Two mechanisms keep the queue honest:
 *
 * 1. **Priority inheritance.** If A (priority P1) depends on B (priority P5),
 *    the queue can't put A before B — A is blocked by B. Instead of pushing A
 *    to the back, B inherits A's priority: B's *effective* priority becomes
 *    `min(B.own, A.effective)` = P1. So both A and B land near the front,
 *    with B right before A. Chains propagate: A → B → C all converge to A's
 *    priority. Diamonds merge: if A and E both depend on B, B inherits
 *    `min(A.effective, E.effective)`.
 *
 * 2. **Dep constraints in the forward pass.** Once the leaf queue is sorted,
 *    each leaf's start is `max(track.cursor, max(dep.target.end + lag))`.
 *    The chosen track's cursor advances; deps add extra constraints that
 *    can push the start later (but never earlier).
 *
 * 3. **Multi-worker projection.** `workerCount=N` keeps N tracks each with
 *    its own cursor. Each leaf goes onto whichever track is currently
 *    earliest. N is a view knob — same priorities + estimates + deps
 *    produce different timelines depending on assumed parallelism, but
 *    the plan itself never changes.
 *
 * What this replaces: the synthetic-FS-chain machinery from #109/#121–#129.
 * The old model invented edges to mimic sequential ordering at each level,
 * and those invented edges fought with user explicit deps, creating cycles
 * the topo sort couldn't resolve. Priority inheritance achieves the same
 * "high-priority first" ordering with zero invented edges, so cycles are
 * impossible unless the user explicitly created a circular dep.
 *
 * Returns a ScheduledNode for every input node. Parents derive their
 * start/end from a bottom-up rollup of their children's positions.
 */
export function schedule(
  nodes: Node[],
  projectStartDay: number = 0,
  constraints?: Map<NodeId, ScheduleConstraint>,
  context?: ScheduleContext,
  workerCount: number = 1,
): ScheduledNode[] {
  // Step 1: Expand any parent-level user deps to leaves (handles the rare
  // case where someone wrote "Section A depends on Section B" at the parent
  // level — that becomes leaf-cascade deps).
  const expanded = expandParentDependencies(nodes);

  // Step 2: Build the forward dep graph (who depends on me) for priority
  // inheritance propagation.
  const dependents = new Map<NodeId, NodeId[]>();
  for (const n of expanded) {
    for (const dep of n.dependencies) {
      if (!dependents.has(dep.targetNodeId)) dependents.set(dep.targetNodeId, []);
      dependents.get(dep.targetNodeId)!.push(n.id);
    }
  }

  // Step 3: Topological sort. Will throw if the user has circular explicit
  // deps — that's a real data error, not something to paper over.
  const sorted = topologicalSort(expanded);

  // Step 4: Compute effective priority by walking in REVERSE topological
  // order. Reverse topo means dependents are processed BEFORE the nodes
  // they depend on, so by the time we visit a node N, every node that
  // depends on N has its effective priority already set. We propagate
  // `min(N.own, all dependent.effective)` to N.
  const effective = new Map<NodeId, number>();
  for (const n of expanded) effective.set(n.id, priorityEnumNum(n.priority));
  for (let i = sorted.length - 1; i >= 0; i--) {
    const node = sorted[i];
    let eff = effective.get(node.id)!;
    for (const dependentId of dependents.get(node.id) ?? []) {
      const depEff = effective.get(dependentId);
      if (depEff !== undefined && depEff < eff) eff = depEff;
    }
    effective.set(node.id, eff);
  }

  // Step 5: Build the global ordered queue. Sort starting from the
  // topo-sorted list (so equal-priority deps stay in dep order, since
  // Array.sort is stable). Within an effective-priority tier, use
  // priorityRank ASC NULLS LAST → createdAt ASC as the tiebreaker.
  const queue = [...sorted].sort((a, b) => {
    const ea = effective.get(a.id)!;
    const eb = effective.get(b.id)!;
    if (ea !== eb) return ea - eb;
    const ra = a.priorityRank;
    const rb = b.priorityRank;
    if (ra !== null && rb !== null) {
      if (ra !== rb) return ra - rb;
    } else if (ra !== null) {
      return -1;
    } else if (rb !== null) {
      return 1;
    }
    return a.createdAt.localeCompare(b.createdAt);
  });

  // Step 6: Schedule the leaves linearly. Parents derive from rollup.
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

  const scheduled = new Map<NodeId, ScheduledNode>();

  // Multi-worker list scheduling. N "tracks" each carry their own cursor
  // (initially projectStartDay). Each leaf in priority order is placed on
  // the track with the earliest cursor that satisfies the dep constraints.
  // workerCount=1 reduces to the single-cursor model exactly.
  const workers = Math.max(1, Math.floor(workerCount));
  const trackCursors: number[] = new Array(workers).fill(projectStartDay);

  for (const node of queue) {
    if (node.childrenIds.length > 0) continue;

    // Done leaves are completed work — they've already happened. Emit a
    // zero-width marker at the project anchor so parent rollup still has
    // data, but DON'T advance any track cursor. Otherwise done items
    // would consume capacity in the future-projected timeline, which is
    // wrong: completed work doesn't compete with future work for tracks.
    const isDone = (node.percentComplete ?? 0) >= 100;
    if (isDone) {
      scheduled.set(node.id, {
        nodeId: node.id,
        computedStart: projectStartDay,
        computedEnd: projectStartDay,
        duration: 0,
      });
      continue;
    }

    let duration = leafDuration(node.effortEstimate);
    let earliestStart = projectStartDay;

    // Dep constraints first — these don't depend on which track we pick.
    for (const dep of node.dependencies) {
      const target = scheduled.get(dep.targetNodeId);
      if (!target) continue;
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
      if (constraint > earliestStart) earliestStart = constraint;
    }

    // Pin constraints next.
    const pin = constraints?.get(node.id);
    if (pin) {
      if (pin.minStart !== undefined && pin.minStart > earliestStart) {
        earliestStart = pin.minStart;
      }
      if (pin.maxEnd !== undefined) {
        const requiredDuration = pin.maxEnd - earliestStart;
        if (requiredDuration > duration) duration = requiredDuration;
      }
    }

    // Pick the track whose cursor is earliest (greedy list scheduling).
    // Ties broken by lowest index — deterministic and gives leaf 0 to
    // track 0 when all cursors are tied (clean visual order on day 0).
    let bestTrack = 0;
    for (let t = 1; t < workers; t++) {
      if (trackCursors[t] < trackCursors[bestTrack]) bestTrack = t;
    }

    // Start = max(track cursor, dep/pin constraints).
    const start = Math.max(trackCursors[bestTrack], earliestStart);
    const end = start + duration;

    scheduled.set(node.id, {
      nodeId: node.id,
      computedStart: start,
      computedEnd: end,
      duration,
    });

    trackCursors[bestTrack] = end;
  }

  // Step 7: Roll up parents bottom-up (deepest first) so each parent
  // reads its children's already-rolled-up values.
  const treeDepth = new Map<NodeId, number>();
  const expandedMap = new Map<NodeId, Node>();
  for (const n of expanded) expandedMap.set(n.id, n);
  for (const n of expanded) {
    let d = 0;
    let cur: Node | undefined = n;
    while (cur && cur.parentId) {
      d++;
      cur = expandedMap.get(cur.parentId);
      if (d > 100) break;
    }
    treeDepth.set(n.id, d);
  }
  const parentsBottomUp = expanded
    .filter((n) => n.childrenIds.length > 0)
    .sort((a, b) => (treeDepth.get(b.id) ?? 0) - (treeDepth.get(a.id) ?? 0));

  for (const parent of parentsBottomUp) {
    let minStart = Infinity;
    let maxEnd = -Infinity;
    for (const childId of parent.childrenIds) {
      const child = scheduled.get(childId);
      if (!child) continue;
      if (child.computedStart < minStart) minStart = child.computedStart;
      if (child.computedEnd > maxEnd) maxEnd = child.computedEnd;
    }
    if (minStart !== Infinity) {
      scheduled.set(parent.id, {
        nodeId: parent.id,
        computedStart: minStart,
        computedEnd: maxEnd,
        duration: maxEnd - minStart,
      });
    } else {
      // Parent with no scheduled children: collapse to project start.
      scheduled.set(parent.id, {
        nodeId: parent.id,
        computedStart: projectStartDay,
        computedEnd: projectStartDay,
        duration: 0,
      });
    }
  }

  // Default for any node that didn't land in scheduled (shouldn't happen
  // but defensive).
  return nodes.map(
    (n) =>
      scheduled.get(n.id) ?? {
        nodeId: n.id,
        computedStart: projectStartDay,
        computedEnd: projectStartDay,
        duration: 0,
      },
  );
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
