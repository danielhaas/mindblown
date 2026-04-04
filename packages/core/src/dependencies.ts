import type {
  Node,
  NodeId,
  NodeMap,
  ScheduledNode,
  CriticalPathResult,
} from './types.js';

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
 * Forward-pass scheduling.
 *
 * Given nodes with effort estimates and dependencies, compute the earliest
 * possible start and end for each node.
 *
 * `projectStartDay` is day 0. All dates are in the map's effort unit (days/hours/points).
 * Returns a ScheduledNode for every input node.
 */
export function schedule(
  nodes: Node[],
  projectStartDay: number = 0,
): ScheduledNode[] {
  const sorted = topologicalSort(nodes);

  const nodeMap = new Map<NodeId, Node>();
  for (const node of nodes) {
    nodeMap.set(node.id, node);
  }

  const scheduled = new Map<NodeId, ScheduledNode>();

  for (const node of sorted) {
    const duration =
      node.childrenIds.length === 0
        ? (node.effortEstimate ?? 0)
        : 0; // parent nodes don't have their own duration for scheduling

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

    scheduled.set(node.id, {
      nodeId: node.id,
      computedStart: earliestStart,
      computedEnd: earliestStart + duration,
      duration,
    });
  }

  // Return in original node order
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

  const sorted = topologicalSort(nodes);
  const nodeMap = new Map<NodeId, Node>();
  for (const node of nodes) {
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
  for (const node of nodes) {
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
