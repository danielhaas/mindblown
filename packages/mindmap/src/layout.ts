import type { Node } from '@mindblown/core';

/**
 * A positioned node produced by the layout algorithm.
 */
export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  parentId: string | null;
  depth: number;
  hasChildren: boolean;
  collapsed: boolean;
}

// ── Configuration ──────────────────────────────────────────────

const NODE_BASE_WIDTH = 160;
const NODE_PARENT_WIDTH = 180;
const NODE_HEIGHT = 40;
const NODE_PARENT_HEIGHT = 44;
const HORIZONTAL_GAP = 60;
const VERTICAL_GAP = 14;
const CHAR_WIDTH = 7.5; // approximate px per character
const MIN_NODE_WIDTH = 100;
const MAX_NODE_WIDTH = 260;

// ── Measure node width ─────────────────────────────────────────

function measureNodeWidth(text: string, hasChildren: boolean): number {
  const textWidth = text.length * CHAR_WIDTH + 32; // 16px padding each side
  const baseWidth = hasChildren ? NODE_PARENT_WIDTH : NODE_BASE_WIDTH;
  return Math.min(MAX_NODE_WIDTH, Math.max(MIN_NODE_WIDTH, Math.max(baseWidth, textWidth)));
}

// ── Reingold-Tilford-style tree layout (left-to-right) ─────────

interface TreeNode {
  id: string;
  node: Node;
  children: TreeNode[];
  width: number;
  height: number;
  // Computed during layout
  x: number;
  y: number;
  subtreeHeight: number;
  depth: number;
}

function buildTree(
  nodeId: string,
  nodes: Record<string, Node>,
  depth: number = 0,
): TreeNode | null {
  const node = nodes[nodeId];
  if (!node) return null;

  const hasChildren = node.childrenIds.length > 0;
  const width = measureNodeWidth(node.text, hasChildren);
  const height = hasChildren ? NODE_PARENT_HEIGHT : NODE_HEIGHT;

  const children: TreeNode[] = [];
  if (!node.collapsed) {
    for (const childId of node.childrenIds) {
      const child = buildTree(childId, nodes, depth + 1);
      if (child) children.push(child);
    }
  }

  return {
    id: nodeId,
    node,
    children,
    width,
    height,
    x: 0,
    y: 0,
    subtreeHeight: 0,
    depth,
  };
}

/**
 * Compute subtree heights bottom-up.
 * A leaf's subtreeHeight = its own height.
 * A parent's subtreeHeight = sum of children's subtreeHeights + gaps between them.
 */
function computeSubtreeHeight(tree: TreeNode): number {
  if (tree.children.length === 0) {
    tree.subtreeHeight = tree.height;
    return tree.subtreeHeight;
  }

  let totalChildrenHeight = 0;
  for (let i = 0; i < tree.children.length; i++) {
    totalChildrenHeight += computeSubtreeHeight(tree.children[i]);
    if (i < tree.children.length - 1) {
      totalChildrenHeight += VERTICAL_GAP;
    }
  }

  tree.subtreeHeight = Math.max(tree.height, totalChildrenHeight);
  return tree.subtreeHeight;
}

/**
 * Assign positions top-down.
 * x is determined by depth (left-to-right).
 * y is determined by centering within the allocated vertical space.
 */
function assignPositions(
  tree: TreeNode,
  x: number,
  yStart: number,
): void {
  // Center this node vertically in its subtree band
  tree.x = x;
  tree.y = yStart + tree.subtreeHeight / 2 - tree.height / 2;

  if (tree.children.length === 0) return;

  // Compute total children height
  let totalChildrenHeight = 0;
  for (let i = 0; i < tree.children.length; i++) {
    totalChildrenHeight += tree.children[i].subtreeHeight;
    if (i < tree.children.length - 1) {
      totalChildrenHeight += VERTICAL_GAP;
    }
  }

  // Center the block of children vertically relative to this node
  let childY = yStart + (tree.subtreeHeight - totalChildrenHeight) / 2;
  const childX = x + tree.width + HORIZONTAL_GAP;

  for (const child of tree.children) {
    assignPositions(child, childX, childY);
    childY += child.subtreeHeight + VERTICAL_GAP;
  }
}

/**
 * Flatten the tree into an array of LayoutNodes.
 */
function flatten(tree: TreeNode): LayoutNode[] {
  const result: LayoutNode[] = [];
  const queue: TreeNode[] = [tree];

  while (queue.length > 0) {
    const t = queue.shift()!;
    result.push({
      id: t.id,
      x: t.x,
      y: t.y,
      width: t.width,
      height: t.height,
      parentId: t.node.parentId,
      depth: t.depth,
      hasChildren: t.node.childrenIds.length > 0,
      collapsed: t.node.collapsed,
    });
    queue.push(...t.children);
  }

  return result;
}

/**
 * Compute the full layout for a tree of nodes.
 * Returns an array of LayoutNodes with x,y positions.
 */
export function computeLayout(
  rootId: string,
  nodes: Record<string, Node>,
): LayoutNode[] {
  const tree = buildTree(rootId, nodes);
  if (!tree) return [];

  computeSubtreeHeight(tree);
  assignPositions(tree, 40, 40);

  return flatten(tree);
}

/**
 * Compute the bounding box of all layout nodes (for centering/fitting).
 */
export function computeBounds(
  layoutNodes: LayoutNode[],
): { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number } {
  if (layoutNodes.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of layoutNodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.width);
    maxY = Math.max(maxY, n.y + n.height);
  }

  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}
