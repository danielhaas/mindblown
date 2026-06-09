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

export type LayoutType = 'tree-lr' | 'tree-tb' | 'radial' | 'org-chart';

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

// Wrap wide leaf-fans into multiple columns/rows. Only triggers when a node
// has > WRAP_THRESHOLD children AND all of those children are leaves —
// keeps the algorithm cascade-free since wrapped slots have no descendants.
const WRAP_THRESHOLD = 7;
const WRAP_COLUMN_GAP = HORIZONTAL_GAP;
const WRAP_ROW_GAP = VERTICAL_GAP * 3;

function shouldWrapChildren(tree: TreeNode): boolean {
  return (
    tree.children.length > WRAP_THRESHOLD &&
    tree.children.every((c) => c.children.length === 0)
  );
}

function computeWrapGrid(n: number): { major: number; minor: number } {
  // `major` is the long axis (columns for LR, rows for TB);
  // `minor` is how many items fit along the long axis before wrapping.
  const major = Math.ceil(n / WRAP_THRESHOLD);
  const minor = Math.ceil(n / major);
  return { major, minor };
}

// ── Measure node width ─────────────────────────────────────────

function measureNodeWidth(text: string, hasChildren: boolean): number {
  const textWidth = text.length * CHAR_WIDTH + 32; // 16px padding each side
  const baseWidth = hasChildren ? NODE_PARENT_WIDTH : NODE_BASE_WIDTH;
  return Math.min(MAX_NODE_WIDTH, Math.max(MIN_NODE_WIDTH, Math.max(baseWidth, textWidth)));
}

// ── Internal tree node ────────────────────────────────────────

interface TreeNode {
  id: string;
  node: Node;
  children: TreeNode[];
  width: number;
  height: number;
  x: number;
  y: number;
  subtreeHeight: number;
  subtreeWidth: number;
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
    subtreeWidth: 0,
    depth,
  };
}

// ── Flatten tree into LayoutNode[] ────────────────────────────

function flatten(tree: TreeNode): LayoutNode[] {
  const result: LayoutNode[] = [];
  const queue: TreeNode[] = [tree];

  while (queue.length > 0) {
    const t = queue.shift()!;
    const useManualPosition = t.node.x != null && t.node.y != null;
    result.push({
      id: t.id,
      x: useManualPosition ? t.node.x! : t.x,
      y: useManualPosition ? t.node.y! : t.y,
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

// ══════════════════════════════════════════════════════════════
// Tree Left-to-Right layout
// ══════════════════════════════════════════════════════════════

function computeSubtreeHeightLR(tree: TreeNode): number {
  if (tree.children.length === 0) {
    tree.subtreeHeight = tree.height;
    return tree.subtreeHeight;
  }

  for (const c of tree.children) computeSubtreeHeightLR(c);

  if (shouldWrapChildren(tree)) {
    const { minor } = computeWrapGrid(tree.children.length);
    const colHeight = minor * NODE_HEIGHT + (minor - 1) * VERTICAL_GAP;
    tree.subtreeHeight = Math.max(tree.height, colHeight);
    return tree.subtreeHeight;
  }

  let totalChildrenHeight = 0;
  for (let i = 0; i < tree.children.length; i++) {
    totalChildrenHeight += tree.children[i].subtreeHeight;
    if (i < tree.children.length - 1) {
      totalChildrenHeight += VERTICAL_GAP;
    }
  }

  tree.subtreeHeight = Math.max(tree.height, totalChildrenHeight);
  return tree.subtreeHeight;
}

function assignPositionsLR(tree: TreeNode, x: number, yStart: number): void {
  tree.x = x;
  tree.y = yStart + tree.subtreeHeight / 2 - tree.height / 2;

  if (tree.children.length === 0) return;

  if (shouldWrapChildren(tree)) {
    const { major, minor } = computeWrapGrid(tree.children.length);
    const colWidth = Math.max(...tree.children.map((c) => c.width));
    const firstColX = x + tree.width + HORIZONTAL_GAP;

    for (let i = 0; i < tree.children.length; i++) {
      const colIdx = Math.floor(i / minor);
      const rowIdx = i % minor;
      const child = tree.children[i];
      const itemsInCol = colIdx === major - 1 ? tree.children.length - colIdx * minor : minor;
      const thisColHeight = itemsInCol * NODE_HEIGHT + (itemsInCol - 1) * VERTICAL_GAP;
      // Center each column vertically inside the parent's subtreeHeight so
      // the trailing (shorter) column doesn't look stuck to the top.
      const colYTop = yStart + (tree.subtreeHeight - thisColHeight) / 2;
      child.x = firstColX + colIdx * (colWidth + WRAP_COLUMN_GAP) + (colWidth - child.width) / 2;
      child.y = colYTop + rowIdx * (NODE_HEIGHT + VERTICAL_GAP);
    }
    return;
  }

  let totalChildrenHeight = 0;
  for (let i = 0; i < tree.children.length; i++) {
    totalChildrenHeight += tree.children[i].subtreeHeight;
    if (i < tree.children.length - 1) {
      totalChildrenHeight += VERTICAL_GAP;
    }
  }

  let childY = yStart + (tree.subtreeHeight - totalChildrenHeight) / 2;
  const childX = x + tree.width + HORIZONTAL_GAP;

  for (const child of tree.children) {
    assignPositionsLR(child, childX, childY);
    childY += child.subtreeHeight + VERTICAL_GAP;
  }
}

function layoutTreeLR(rootId: string, nodes: Record<string, Node>): LayoutNode[] {
  const tree = buildTree(rootId, nodes);
  if (!tree) return [];
  computeSubtreeHeightLR(tree);
  assignPositionsLR(tree, 40, 40);
  return flatten(tree);
}

// ══════════════════════════════════════════════════════════════
// Tree Top-to-Bottom layout
// ══════════════════════════════════════════════════════════════

function computeSubtreeWidthTB(tree: TreeNode): number {
  if (tree.children.length === 0) {
    tree.subtreeWidth = tree.width;
    return tree.subtreeWidth;
  }

  for (const c of tree.children) computeSubtreeWidthTB(c);

  if (shouldWrapChildren(tree)) {
    const { minor } = computeWrapGrid(tree.children.length);
    const childWidth = Math.max(...tree.children.map((c) => c.width));
    const rowWidth = minor * childWidth + (minor - 1) * (HORIZONTAL_GAP / 2);
    tree.subtreeWidth = Math.max(tree.width, rowWidth);
    return tree.subtreeWidth;
  }

  let totalChildrenWidth = 0;
  for (let i = 0; i < tree.children.length; i++) {
    totalChildrenWidth += tree.children[i].subtreeWidth;
    if (i < tree.children.length - 1) {
      totalChildrenWidth += HORIZONTAL_GAP / 2;
    }
  }

  tree.subtreeWidth = Math.max(tree.width, totalChildrenWidth);
  return tree.subtreeWidth;
}

function assignPositionsTB(tree: TreeNode, xStart: number, y: number): void {
  tree.x = xStart + tree.subtreeWidth / 2 - tree.width / 2;
  tree.y = y;

  if (tree.children.length === 0) return;

  if (shouldWrapChildren(tree)) {
    const { major, minor } = computeWrapGrid(tree.children.length);
    const childWidth = Math.max(...tree.children.map((c) => c.width));
    const firstRowY = y + tree.height + WRAP_ROW_GAP;
    const rowStep = NODE_HEIGHT + WRAP_ROW_GAP;

    for (let i = 0; i < tree.children.length; i++) {
      const rowIdx = Math.floor(i / minor);
      const colIdx = i % minor;
      const child = tree.children[i];
      const itemsInRow = rowIdx === major - 1 ? tree.children.length - rowIdx * minor : minor;
      const thisRowWidth = itemsInRow * childWidth + (itemsInRow - 1) * (HORIZONTAL_GAP / 2);
      const rowXStart = xStart + (tree.subtreeWidth - thisRowWidth) / 2;
      child.x = rowXStart + colIdx * (childWidth + HORIZONTAL_GAP / 2) + (childWidth - child.width) / 2;
      child.y = firstRowY + rowIdx * rowStep;
    }
    return;
  }

  let totalChildrenWidth = 0;
  for (let i = 0; i < tree.children.length; i++) {
    totalChildrenWidth += tree.children[i].subtreeWidth;
    if (i < tree.children.length - 1) {
      totalChildrenWidth += HORIZONTAL_GAP / 2;
    }
  }

  let childX = xStart + (tree.subtreeWidth - totalChildrenWidth) / 2;
  const childY = y + tree.height + VERTICAL_GAP * 3;

  for (const child of tree.children) {
    assignPositionsTB(child, childX, childY);
    childX += child.subtreeWidth + HORIZONTAL_GAP / 2;
  }
}

function layoutTreeTB(rootId: string, nodes: Record<string, Node>): LayoutNode[] {
  const tree = buildTree(rootId, nodes);
  if (!tree) return [];
  computeSubtreeWidthTB(tree);
  assignPositionsTB(tree, 40, 40);
  return flatten(tree);
}

// ══════════════════════════════════════════════════════════════
// Org Chart layout (top-to-bottom, wider spacing)
// ══════════════════════════════════════════════════════════════

function layoutOrgChart(rootId: string, nodes: Record<string, Node>): LayoutNode[] {
  const tree = buildTree(rootId, nodes);
  if (!tree) return [];
  computeSubtreeWidthOC(tree);
  assignPositionsOC(tree, 40, 40);
  return flatten(tree);
}

function computeSubtreeWidthOC(tree: TreeNode): number {
  if (tree.children.length === 0) {
    tree.subtreeWidth = tree.width;
    return tree.subtreeWidth;
  }

  let totalChildrenWidth = 0;
  for (let i = 0; i < tree.children.length; i++) {
    totalChildrenWidth += computeSubtreeWidthOC(tree.children[i]);
    if (i < tree.children.length - 1) {
      totalChildrenWidth += HORIZONTAL_GAP;
    }
  }

  tree.subtreeWidth = Math.max(tree.width, totalChildrenWidth);
  return tree.subtreeWidth;
}

function assignPositionsOC(tree: TreeNode, xStart: number, y: number): void {
  tree.x = xStart + tree.subtreeWidth / 2 - tree.width / 2;
  tree.y = y;

  if (tree.children.length === 0) return;

  let totalChildrenWidth = 0;
  for (let i = 0; i < tree.children.length; i++) {
    totalChildrenWidth += tree.children[i].subtreeWidth;
    if (i < tree.children.length - 1) {
      totalChildrenWidth += HORIZONTAL_GAP;
    }
  }

  let childX = xStart + (tree.subtreeWidth - totalChildrenWidth) / 2;
  const childY = y + tree.height + VERTICAL_GAP * 5;

  for (const child of tree.children) {
    assignPositionsOC(child, childX, childY);
    childX += child.subtreeWidth + HORIZONTAL_GAP;
  }
}

// ══════════════════════════════════════════════════════════════
// Radial layout
// ══════════════════════════════════════════════════════════════

function countLeaves(tree: TreeNode): number {
  if (tree.children.length === 0) return 1;
  let sum = 0;
  for (const child of tree.children) sum += countLeaves(child);
  return sum;
}

function assignPositionsRadial(
  tree: TreeNode,
  cx: number,
  cy: number,
  startAngle: number,
  endAngle: number,
  radius: number,
): void {
  if (tree.depth === 0) {
    tree.x = cx - tree.width / 2;
    tree.y = cy - tree.height / 2;
  }

  if (tree.children.length === 0) return;

  const totalLeaves = tree.children.reduce((s, c) => s + countLeaves(c), 0);
  const childRadius = radius + Math.max(tree.width, 180) + 40;

  let currentAngle = startAngle;

  for (const child of tree.children) {
    const childLeaves = countLeaves(child);
    const sweep = ((endAngle - startAngle) * childLeaves) / totalLeaves;
    const midAngle = currentAngle + sweep / 2;

    child.x = cx + childRadius * Math.cos(midAngle) - child.width / 2;
    child.y = cy + childRadius * Math.sin(midAngle) - child.height / 2;

    assignPositionsRadial(child, cx, cy, currentAngle, currentAngle + sweep, childRadius);
    currentAngle += sweep;
  }
}

function layoutRadial(rootId: string, nodes: Record<string, Node>): LayoutNode[] {
  const tree = buildTree(rootId, nodes);
  if (!tree) return [];

  const cx = 400;
  const cy = 400;
  assignPositionsRadial(tree, cx, cy, -Math.PI, Math.PI, 0);
  return flatten(tree);
}

// ══════════════════════════════════════════════════════════════
// Public API
// ══════════════════════════════════════════════════════════════

/**
 * Compute the full layout for a tree of nodes.
 * Returns an array of LayoutNodes with x,y positions.
 */
export function computeLayout(
  rootId: string,
  nodes: Record<string, Node>,
  layoutType: LayoutType = 'tree-lr',
): LayoutNode[] {
  switch (layoutType) {
    case 'tree-lr':
      return layoutTreeLR(rootId, nodes);
    case 'tree-tb':
      return layoutTreeTB(rootId, nodes);
    case 'radial':
      return layoutRadial(rootId, nodes);
    case 'org-chart':
      return layoutOrgChart(rootId, nodes);
    default:
      return layoutTreeLR(rootId, nodes);
  }
}

/**
 * Compute radial positions for the leaf-like children of a parent node,
 * spread evenly around 360°. "Leaf-like" = child has no children OR is
 * collapsed (so it's visually a single node). Non-leaf expanded children
 * are skipped so their subtrees are left alone.
 *
 * Returns updates the caller can persist via updateNode. Returns [] when
 * there's nothing useful to distribute.
 */
export function distributeLeavesAroundParent(
  parentId: string,
  nodes: Record<string, Node>,
  layoutMap: Map<string, LayoutNode>,
): Array<{ id: string; x: number; y: number }> {
  const parent = nodes[parentId];
  if (!parent) return [];
  const parentLayout = layoutMap.get(parentId);
  if (!parentLayout) return [];

  const leafLayouts: LayoutNode[] = [];
  for (const childId of parent.childrenIds) {
    const child = nodes[childId];
    if (!child) continue;
    const isLeafLike = child.childrenIds.length === 0 || child.collapsed;
    if (!isLeafLike) continue;
    const ln = layoutMap.get(childId);
    if (ln) leafLayouts.push(ln);
  }
  if (leafLayouts.length === 0) return [];

  const maxLeafW = Math.max(...leafLayouts.map((l) => l.width));
  const maxLeafH = Math.max(...leafLayouts.map((l) => l.height));
  const N = leafLayouts.length;

  const cx = parentLayout.x + parentLayout.width / 2;
  const cy = parentLayout.y + parentLayout.height / 2;

  // Radius must clear the parent and (for N≥2) give each chord enough room
  // for one leaf bounding box plus a small gap.
  const SPACING = 16;
  const PARENT_GAP = 40;
  const radiusForParent =
    Math.max(parentLayout.width, parentLayout.height) / 2 +
    Math.max(maxLeafW, maxLeafH) / 2 +
    PARENT_GAP;
  const minChord = Math.max(maxLeafW, maxLeafH) + SPACING;
  const radiusForFit = N >= 2 ? minChord / (2 * Math.sin(Math.PI / N)) : 0;
  const radius = Math.max(radiusForParent, radiusForFit);

  // Start at the top (−π/2) and walk clockwise so the distribution is stable
  // and visually predictable regardless of layout direction.
  const startAngle = -Math.PI / 2;

  return leafLayouts.map((ln, i) => {
    const angle = startAngle + (i / N) * 2 * Math.PI;
    return {
      id: ln.id,
      x: cx + radius * Math.cos(angle) - ln.width / 2,
      y: cy + radius * Math.sin(angle) - ln.height / 2,
    };
  });
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
