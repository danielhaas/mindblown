import type { Node, NodeId, NodeMap, HealthSignal, ComputedNodeValues } from './types.js';

/**
 * Compute the effort rollup for a node.
 *
 * Leaf nodes return their effortEstimate (or 0 if unestimated).
 * Milestone nodes always return 0.
 * Parent nodes return the sum of all descendant leaf efforts.
 */
export function computeEffort(node: Node, nodeMap: NodeMap): number {
  if (node.isMilestone) return 0;

  if (node.childrenIds.length === 0) {
    // Leaf node: return stored estimate, or 0 if unestimated
    return node.effortEstimate ?? 0;
  }

  let total = 0;
  for (const childId of node.childrenIds) {
    const child = nodeMap.get(childId);
    if (child) {
      total += computeEffort(child, nodeMap);
    }
  }
  return total;
}

/**
 * Compute the weighted progress rollup for a node.
 *
 * Leaf nodes return their percentComplete (or 0 if unset).
 * Parent nodes return the effort-weighted average of descendant leaf progress.
 * If total effort is 0, returns 0 (no estimates = 0% progress).
 */
export function computeProgress(node: Node, nodeMap: NodeMap): number {
  if (node.childrenIds.length === 0) {
    // Leaf node
    return node.percentComplete ?? 0;
  }

  let totalEffort = 0;
  let weightedProgress = 0;

  for (const childId of node.childrenIds) {
    const child = nodeMap.get(childId);
    if (!child) continue;

    const childEffort = computeEffort(child, nodeMap);
    const childProgress = computeProgress(child, nodeMap);
    totalEffort += childEffort;
    weightedProgress += childEffort * childProgress;
  }

  if (totalEffort === 0) return 0;
  return Math.max(0, Math.min(100, weightedProgress / totalEffort));
}

/**
 * Compute health for a leaf node based on elapsed time vs progress.
 *
 * @param node        - The leaf node to evaluate.
 * @param threshold   - The at_risk threshold (default 0.2 = 20% behind pace).
 * @param now         - Override for current date (for testing). Defaults to Date.now().
 */
export function leafHealth(
  node: Node,
  threshold: number = 0.2,
  now?: Date,
): HealthSignal {
  if (node.dueDate == null) {
    return 'on_track'; // no deadline = can't be late
  }

  const currentDate = now ?? new Date();
  const dueDate = new Date(node.dueDate);
  const progress = node.percentComplete ?? 0;

  // Overdue check
  if (currentDate > dueDate && progress < 100) {
    return 'behind';
  }

  // Elapsed ratio calculation
  let startMs: number;
  if (node.startDate != null) {
    startMs = new Date(node.startDate).getTime();
  } else {
    startMs = new Date(node.createdAt).getTime();
  }

  const totalDuration = dueDate.getTime() - startMs;
  if (totalDuration <= 0) {
    // Zero or negative duration — if not complete, it's behind
    return progress >= 100 ? 'on_track' : 'behind';
  }

  const elapsed = currentDate.getTime() - startMs;
  const elapsedRatio = Math.max(0, Math.min(1, elapsed / totalDuration));
  const progressRatio = progress / 100;

  if (elapsedRatio - progressRatio > threshold) {
    return 'at_risk';
  }

  return 'on_track';
}

/**
 * Compute the health signal for a node with upward propagation.
 *
 * Leaf: uses leafHealth().
 * Parent: worst-child-wins (one 'behind' child makes the whole chain 'behind').
 */
export function computeHealth(
  node: Node,
  nodeMap: NodeMap,
  threshold: number = 0.2,
  now?: Date,
): HealthSignal {
  if (node.childrenIds.length === 0) {
    return leafHealth(node, threshold, now);
  }

  let worst: HealthSignal = 'on_track';

  for (const childId of node.childrenIds) {
    const child = nodeMap.get(childId);
    if (!child) continue;

    const childHealth = computeHealth(child, nodeMap, threshold, now);

    if (childHealth === 'behind') {
      return 'behind'; // short-circuit: can't get worse
    }
    if (childHealth === 'at_risk') {
      worst = 'at_risk';
    }
  }

  return worst;
}

/**
 * Compute effort, progress, and health for every node in a flat array.
 * Returns a map of NodeId -> ComputedNodeValues.
 */
export function computeTree(
  nodes: Node[],
  threshold: number = 0.2,
  now?: Date,
): Map<NodeId, ComputedNodeValues> {
  const nodeMap: NodeMap = new Map();
  for (const node of nodes) {
    nodeMap.set(node.id, node);
  }

  const result = new Map<NodeId, ComputedNodeValues>();

  for (const node of nodes) {
    result.set(node.id, {
      computedEffort: computeEffort(node, nodeMap),
      computedProgress: computeProgress(node, nodeMap),
      healthSignal: computeHealth(node, nodeMap, threshold, now),
    });
  }

  return result;
}
