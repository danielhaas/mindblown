import type {
  Node,
  NodeId,
  NodeMap,
  HealthSignal,
  ComputedNodeValues,
  BlockedBy,
} from './types.js';
import { isLeadTimeNode } from './types.js';

/**
 * Compute the effort rollup for a node — the user-facing total.
 *
 * Leaf nodes return their stored `effortEstimate`, or 0 if unestimated.
 * Parent nodes return the sum of all descendant leaf efforts.
 *
 * NOTE: This is the *truthful* effort total. It is intentionally distinct
 * from `effortWeight()` (below), which substitutes 1 for null leaves so
 * unestimated work still counts toward parent % complete. Consumers of
 * `computedEffort` (forecasts, "smallest ready node", capacity math) need
 * the truth — a leaf with no estimate has 0 known effort, not 1.
 */
export function computeEffort(node: Node, nodeMap: NodeMap, inParked: boolean = node.parked === true): number {
  if (node.childrenIds.length === 0) {
    // A wait on someone outside the team is not our effort (#654).
    if (isLeadTimeNode(node)) return 0;
    return node.effortEstimate ?? 0;
  }

  let total = 0;
  for (const childId of node.childrenIds) {
    const child = nodeMap.get(childId);
    if (child && !skipsParked(child, inParked)) {
      total += computeEffort(child, nodeMap, inParked);
    }
  }
  return total;
}

/**
 * A parked child (#655) is left out of its parent's rollups — effort,
 * progress, health, blocked — unless the parent sits in a parked branch
 * itself (then the branch's own totals count everything in it).
 */
function skipsParked(child: Node, inParked: boolean): boolean {
  return child.parked === true && !inParked;
}

/**
 * Effort in parked branches below a node (#655): what `computeEffort`
 * leaves out, shown separately ("parked: 10d"). 0 inside a parked branch,
 * where nothing is left out.
 */
export function computeParkedEffort(node: Node, nodeMap: NodeMap): number {
  if (node.parked === true) return 0;
  let total = 0;
  for (const childId of node.childrenIds) {
    const child = nodeMap.get(childId);
    if (!child) continue;
    total += child.parked === true ? computeEffort(child, nodeMap, true) : computeParkedEffort(child, nodeMap);
  }
  return total;
}

/**
 * Internal rollup weight: like `computeEffort` but substitutes 1 for
 * unestimated leaves. Used only as the weighting denominator inside
 * `computeProgress` so a subtree of all-unestimated leaves still
 * participates in the parent's weighted % complete (without this, a
 * partly-done parent next to fully-done estimated siblings reads as
 * 100% even though work remains).
 */
function effortWeight(node: Node, nodeMap: NodeMap, inParked: boolean): number {
  if (node.childrenIds.length === 0) {
    // A wait carries no weight in % complete (#654).
    if (isLeadTimeNode(node)) return 0;
    return node.effortEstimate ?? 1;
  }

  let total = 0;
  for (const childId of node.childrenIds) {
    const child = nodeMap.get(childId);
    if (child && !skipsParked(child, inParked)) {
      total += effortWeight(child, nodeMap, inParked);
    }
  }
  return total;
}

/**
 * Compute the weighted progress rollup for a node.
 *
 * Leaf nodes return their percentComplete (or 0 if unset).
 * Parent nodes return the effort-weighted average of descendant leaf progress,
 * where unestimated leaves count as weight 1 (see `effortWeight`).
 * If total weight is 0, returns 0.
 */
export function computeProgress(node: Node, nodeMap: NodeMap, inParked: boolean = node.parked === true): number {
  if (node.childrenIds.length === 0) {
    // Leaf node
    return node.percentComplete ?? 0;
  }

  let totalWeight = 0;
  let weightedProgress = 0;

  for (const childId of node.childrenIds) {
    const child = nodeMap.get(childId);
    if (!child || skipsParked(child, inParked)) continue;

    const childWeight = effortWeight(child, nodeMap, inParked);
    const childProgress = computeProgress(child, nodeMap, inParked);
    totalWeight += childWeight;
    weightedProgress += childWeight * childProgress;
  }

  if (totalWeight === 0) return 0;
  return Math.max(0, Math.min(100, weightedProgress / totalWeight));
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
  inParked: boolean = node.parked === true,
): HealthSignal {
  if (node.childrenIds.length === 0) {
    return leafHealth(node, threshold, now);
  }

  let worst: HealthSignal = 'on_track';

  for (const childId of node.childrenIds) {
    const child = nodeMap.get(childId);
    if (!child || skipsParked(child, inParked)) continue;

    const childHealth = computeHealth(child, nodeMap, threshold, now, inParked);

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
 * Compute whether a node is blocked.
 *
 * Leaf: blocked if `blockedReason` is set OR any FS predecessor's rolled-up
 * progress is below 100%.
 * Parent: blocked if any leaf descendant is blocked (worst-child-wins,
 * mirroring `computeHealth`).
 */
export function computeIsBlocked(
  node: Node,
  nodeMap: NodeMap,
  inParked: boolean = node.parked === true,
): { isBlocked: boolean; blockedBy: BlockedBy } {
  if (node.childrenIds.length === 0) {
    const manual = node.blockedReason != null;
    const predecessorIds: NodeId[] = [];
    for (const dep of node.dependencies) {
      if (dep.type !== 'FS') continue;
      const target = nodeMap.get(dep.targetNodeId);
      if (!target) continue; // external/missing target — ignore
      if (computeProgress(target, nodeMap) < 100) {
        predecessorIds.push(dep.targetNodeId);
      }
    }
    return {
      isBlocked: manual || predecessorIds.length > 0,
      blockedBy: { manual, predecessorIds, blockedDescendantCount: 0 },
    };
  }

  let blockedDescendantCount = 0;
  for (const childId of node.childrenIds) {
    const child = nodeMap.get(childId);
    if (!child || skipsParked(child, inParked)) continue;
    const childResult = computeIsBlocked(child, nodeMap, inParked);
    if (child.childrenIds.length === 0) {
      if (childResult.isBlocked) blockedDescendantCount += 1;
    } else {
      blockedDescendantCount += childResult.blockedBy.blockedDescendantCount;
    }
  }

  return {
    isBlocked: blockedDescendantCount > 0,
    blockedBy: {
      manual: false,
      predecessorIds: [],
      blockedDescendantCount,
    },
  };
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
    const blocked = computeIsBlocked(node, nodeMap);
    result.set(node.id, {
      computedEffort: computeEffort(node, nodeMap),
      computedProgress: computeProgress(node, nodeMap),
      healthSignal: computeHealth(node, nodeMap, threshold, now),
      isBlocked: blocked.isBlocked,
      blockedBy: blocked.blockedBy,
      parkedEffort: computeParkedEffort(node, nodeMap),
    });
  }

  return result;
}
