import type { Node, NodeId, NodeMap } from './types.js';

/**
 * Build a NodeMap from a flat array of nodes.
 */
export function buildNodeMap(nodes: Node[]): NodeMap {
  const map: NodeMap = new Map();
  for (const node of nodes) {
    map.set(node.id, node);
  }
  return map;
}

/**
 * Check whether `candidateAncestorId` is an ancestor of `nodeId`.
 * Used to prevent cycles when re-parenting.
 */
export function isAncestor(
  candidateAncestorId: NodeId,
  nodeId: NodeId,
  nodeMap: NodeMap,
): boolean {
  let current = nodeMap.get(nodeId);
  while (current) {
    if (current.parentId === candidateAncestorId) return true;
    if (current.parentId == null) return false;
    current = nodeMap.get(current.parentId);
  }
  return false;
}

/**
 * Insert a new node into the tree.
 *
 * - Sets parentId on the new node.
 * - Inserts the node's id into the parent's childrenIds at `index`.
 * - index = -1 or undefined appends at end.
 * - Mutates nodes in `nodeMap` in place and returns the updated map.
 */
export function insertNode(
  nodeMap: NodeMap,
  newNode: Node,
  parentId: NodeId,
  index?: number,
): NodeMap {
  const parent = nodeMap.get(parentId);
  if (!parent) {
    throw new Error(`Parent node ${parentId} not found`);
  }

  // Set the new node's parent
  newNode.parentId = parentId;

  // Insert into parent's children
  if (index == null || index === -1 || index >= parent.childrenIds.length) {
    parent.childrenIds.push(newNode.id);
  } else {
    parent.childrenIds.splice(index, 0, newNode.id);
  }

  // Add to the map
  nodeMap.set(newNode.id, newNode);

  return nodeMap;
}

/**
 * Move a node to a new parent (re-parent).
 *
 * Validates that newParentId is not a descendant of nodeId (prevents cycles).
 * Removes from old parent's childrenIds, inserts into new parent's childrenIds.
 */
export function moveNode(
  nodeMap: NodeMap,
  nodeId: NodeId,
  newParentId: NodeId,
  index?: number,
): NodeMap {
  const node = nodeMap.get(nodeId);
  if (!node) throw new Error(`Node ${nodeId} not found`);

  const newParent = nodeMap.get(newParentId);
  if (!newParent) throw new Error(`New parent ${newParentId} not found`);

  // Validate: newParentId must not be a descendant of nodeId
  if (nodeId === newParentId) {
    throw new Error('Cannot move a node to be its own child');
  }
  if (isAncestor(nodeId, newParentId, nodeMap)) {
    throw new Error('Cannot move a node under its own descendant (would create cycle)');
  }

  // Remove from old parent
  if (node.parentId != null) {
    const oldParent = nodeMap.get(node.parentId);
    if (oldParent) {
      oldParent.childrenIds = oldParent.childrenIds.filter((id) => id !== nodeId);
    }
  }

  // Insert into new parent
  if (index == null || index === -1 || index >= newParent.childrenIds.length) {
    newParent.childrenIds.push(nodeId);
  } else {
    newParent.childrenIds.splice(index, 0, nodeId);
  }

  node.parentId = newParentId;

  return nodeMap;
}

/**
 * Delete a node and all its descendants.
 *
 * - Recursively collects all descendant IDs.
 * - Removes dependency edges pointing to/from deleted nodes across the whole map.
 * - Removes nodeId from parent's childrenIds.
 * - Deletes the node and all descendants from the map.
 */
export function deleteNode(nodeMap: NodeMap, nodeId: NodeId): NodeMap {
  const node = nodeMap.get(nodeId);
  if (!node) throw new Error(`Node ${nodeId} not found`);

  // Collect all descendants (BFS)
  const toDelete = new Set<NodeId>();
  const queue: NodeId[] = [nodeId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    toDelete.add(current);
    const currentNode = nodeMap.get(current);
    if (currentNode) {
      queue.push(...currentNode.childrenIds);
    }
  }

  // Remove from parent's childrenIds
  if (node.parentId != null) {
    const parent = nodeMap.get(node.parentId);
    if (parent) {
      parent.childrenIds = parent.childrenIds.filter((id) => id !== nodeId);
    }
  }

  // Remove dependency edges pointing to/from deleted nodes
  for (const [, n] of nodeMap) {
    if (toDelete.has(n.id)) continue;
    n.dependencies = n.dependencies.filter(
      (dep) => !toDelete.has(dep.targetNodeId),
    );
  }

  // Delete all collected nodes
  for (const id of toDelete) {
    nodeMap.delete(id);
  }

  return nodeMap;
}

/**
 * Reorder children of a parent node.
 *
 * Validates that newChildrenIds is a permutation of the existing childrenIds.
 */
export function reorderChildren(
  nodeMap: NodeMap,
  parentId: NodeId,
  newChildrenIds: NodeId[],
): NodeMap {
  const parent = nodeMap.get(parentId);
  if (!parent) throw new Error(`Parent node ${parentId} not found`);

  // Validate: must be a permutation
  const existing = new Set(parent.childrenIds);
  const incoming = new Set(newChildrenIds);

  if (existing.size !== incoming.size) {
    throw new Error('newChildrenIds must be a permutation of current childrenIds');
  }
  for (const id of incoming) {
    if (!existing.has(id)) {
      throw new Error(
        `newChildrenIds contains ${id} which is not a current child`,
      );
    }
  }

  parent.childrenIds = [...newChildrenIds];

  return nodeMap;
}
