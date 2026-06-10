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

// All sizes baked at the "200%" feel — the previous default was half
// these values and felt too small at typical viewing distances. textScale
// is now a multiplier on top, so 1.0 is the comfortable default.
const NODE_BASE_WIDTH = 320;
const NODE_PARENT_WIDTH = 360;
const NODE_HEIGHT = 80;
const NODE_PARENT_HEIGHT = 88;
const HORIZONTAL_GAP = 120;
const VERTICAL_GAP = 28;
const CHAR_WIDTH = 17; // approximate px per character (calibrated for the 30/32 base label fontSize)
const MIN_NODE_WIDTH = 200;
const MAX_NODE_WIDTH = 520;

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

function measureNodeWidth(text: string, hasChildren: boolean, scale: number): number {
  const textWidth = text.length * CHAR_WIDTH * scale + 64 * scale; // 32px padding each side
  const baseWidth = (hasChildren ? NODE_PARENT_WIDTH : NODE_BASE_WIDTH) * scale;
  return Math.min(MAX_NODE_WIDTH * scale, Math.max(MIN_NODE_WIDTH * scale, Math.max(baseWidth, textWidth)));
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
  scale: number = 1,
): TreeNode | null {
  const node = nodes[nodeId];
  if (!node) return null;

  const hasChildren = node.childrenIds.length > 0;
  const width = measureNodeWidth(node.text, hasChildren, scale);
  const height = (hasChildren ? NODE_PARENT_HEIGHT : NODE_HEIGHT) * scale;

  const children: TreeNode[] = [];
  if (!node.collapsed) {
    for (const childId of node.childrenIds) {
      const child = buildTree(childId, nodes, depth + 1, scale);
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

function computeSubtreeHeightLR(tree: TreeNode, scale: number): number {
  if (tree.children.length === 0) {
    tree.subtreeHeight = tree.height;
    return tree.subtreeHeight;
  }

  for (const c of tree.children) computeSubtreeHeightLR(c, scale);

  if (shouldWrapChildren(tree)) {
    const { minor } = computeWrapGrid(tree.children.length);
    const colHeight = minor * NODE_HEIGHT * scale + (minor - 1) * VERTICAL_GAP * scale;
    tree.subtreeHeight = Math.max(tree.height, colHeight);
    return tree.subtreeHeight;
  }

  let totalChildrenHeight = 0;
  for (let i = 0; i < tree.children.length; i++) {
    totalChildrenHeight += tree.children[i].subtreeHeight;
    if (i < tree.children.length - 1) {
      totalChildrenHeight += VERTICAL_GAP * scale;
    }
  }

  tree.subtreeHeight = Math.max(tree.height, totalChildrenHeight);
  return tree.subtreeHeight;
}

function assignPositionsLR(tree: TreeNode, x: number, yStart: number, scale: number): void {
  tree.x = x;
  tree.y = yStart + tree.subtreeHeight / 2 - tree.height / 2;

  if (tree.children.length === 0) return;

  if (shouldWrapChildren(tree)) {
    const { major, minor } = computeWrapGrid(tree.children.length);
    const colWidth = Math.max(...tree.children.map((c) => c.width));
    const firstColX = x + tree.width + HORIZONTAL_GAP * scale;

    for (let i = 0; i < tree.children.length; i++) {
      const colIdx = Math.floor(i / minor);
      const rowIdx = i % minor;
      const child = tree.children[i];
      const itemsInCol = colIdx === major - 1 ? tree.children.length - colIdx * minor : minor;
      const thisColHeight = itemsInCol * NODE_HEIGHT * scale + (itemsInCol - 1) * VERTICAL_GAP * scale;
      // Center each column vertically inside the parent's subtreeHeight so
      // the trailing (shorter) column doesn't look stuck to the top.
      const colYTop = yStart + (tree.subtreeHeight - thisColHeight) / 2;
      child.x = firstColX + colIdx * (colWidth + WRAP_COLUMN_GAP * scale) + (colWidth - child.width) / 2;
      child.y = colYTop + rowIdx * (NODE_HEIGHT * scale + VERTICAL_GAP * scale);
    }
    return;
  }

  let totalChildrenHeight = 0;
  for (let i = 0; i < tree.children.length; i++) {
    totalChildrenHeight += tree.children[i].subtreeHeight;
    if (i < tree.children.length - 1) {
      totalChildrenHeight += VERTICAL_GAP * scale;
    }
  }

  let childY = yStart + (tree.subtreeHeight - totalChildrenHeight) / 2;
  const childX = x + tree.width + HORIZONTAL_GAP * scale;

  for (const child of tree.children) {
    assignPositionsLR(child, childX, childY, scale);
    childY += child.subtreeHeight + VERTICAL_GAP * scale;
  }
}

function layoutTreeLR(rootId: string, nodes: Record<string, Node>, scale: number): LayoutNode[] {
  const tree = buildTree(rootId, nodes, 0, scale);
  if (!tree) return [];
  computeSubtreeHeightLR(tree, scale);
  assignPositionsLR(tree, 40, 40, scale);
  return flatten(tree);
}

// ══════════════════════════════════════════════════════════════
// Tree Top-to-Bottom layout
// ══════════════════════════════════════════════════════════════

function computeSubtreeWidthTB(tree: TreeNode, scale: number): number {
  if (tree.children.length === 0) {
    tree.subtreeWidth = tree.width;
    return tree.subtreeWidth;
  }

  for (const c of tree.children) computeSubtreeWidthTB(c, scale);

  if (shouldWrapChildren(tree)) {
    const { minor } = computeWrapGrid(tree.children.length);
    const childWidth = Math.max(...tree.children.map((c) => c.width));
    const rowWidth = minor * childWidth + (minor - 1) * (HORIZONTAL_GAP * scale / 2);
    tree.subtreeWidth = Math.max(tree.width, rowWidth);
    return tree.subtreeWidth;
  }

  let totalChildrenWidth = 0;
  for (let i = 0; i < tree.children.length; i++) {
    totalChildrenWidth += tree.children[i].subtreeWidth;
    if (i < tree.children.length - 1) {
      totalChildrenWidth += HORIZONTAL_GAP * scale / 2;
    }
  }

  tree.subtreeWidth = Math.max(tree.width, totalChildrenWidth);
  return tree.subtreeWidth;
}

function assignPositionsTB(tree: TreeNode, xStart: number, y: number, scale: number): void {
  tree.x = xStart + tree.subtreeWidth / 2 - tree.width / 2;
  tree.y = y;

  if (tree.children.length === 0) return;

  if (shouldWrapChildren(tree)) {
    const { major, minor } = computeWrapGrid(tree.children.length);
    const childWidth = Math.max(...tree.children.map((c) => c.width));
    const firstRowY = y + tree.height + WRAP_ROW_GAP * scale;
    const rowStep = NODE_HEIGHT * scale + WRAP_ROW_GAP * scale;

    for (let i = 0; i < tree.children.length; i++) {
      const rowIdx = Math.floor(i / minor);
      const colIdx = i % minor;
      const child = tree.children[i];
      const itemsInRow = rowIdx === major - 1 ? tree.children.length - rowIdx * minor : minor;
      const thisRowWidth = itemsInRow * childWidth + (itemsInRow - 1) * (HORIZONTAL_GAP * scale / 2);
      const rowXStart = xStart + (tree.subtreeWidth - thisRowWidth) / 2;
      child.x = rowXStart + colIdx * (childWidth + HORIZONTAL_GAP * scale / 2) + (childWidth - child.width) / 2;
      child.y = firstRowY + rowIdx * rowStep;
    }
    return;
  }

  let totalChildrenWidth = 0;
  for (let i = 0; i < tree.children.length; i++) {
    totalChildrenWidth += tree.children[i].subtreeWidth;
    if (i < tree.children.length - 1) {
      totalChildrenWidth += HORIZONTAL_GAP * scale / 2;
    }
  }

  let childX = xStart + (tree.subtreeWidth - totalChildrenWidth) / 2;
  const childY = y + tree.height + VERTICAL_GAP * scale * 3;

  for (const child of tree.children) {
    assignPositionsTB(child, childX, childY, scale);
    childX += child.subtreeWidth + HORIZONTAL_GAP * scale / 2;
  }
}

function layoutTreeTB(rootId: string, nodes: Record<string, Node>, scale: number): LayoutNode[] {
  const tree = buildTree(rootId, nodes, 0, scale);
  if (!tree) return [];
  computeSubtreeWidthTB(tree, scale);
  assignPositionsTB(tree, 40, 40, scale);
  return flatten(tree);
}

// ══════════════════════════════════════════════════════════════
// Org Chart layout (top-to-bottom, wider spacing)
// ══════════════════════════════════════════════════════════════

function layoutOrgChart(rootId: string, nodes: Record<string, Node>, scale: number): LayoutNode[] {
  const tree = buildTree(rootId, nodes, 0, scale);
  if (!tree) return [];
  computeSubtreeWidthOC(tree, scale);
  assignPositionsOC(tree, 40, 40, scale);
  return flatten(tree);
}

function computeSubtreeWidthOC(tree: TreeNode, scale: number): number {
  if (tree.children.length === 0) {
    tree.subtreeWidth = tree.width;
    return tree.subtreeWidth;
  }

  let totalChildrenWidth = 0;
  for (let i = 0; i < tree.children.length; i++) {
    totalChildrenWidth += computeSubtreeWidthOC(tree.children[i], scale);
    if (i < tree.children.length - 1) {
      totalChildrenWidth += HORIZONTAL_GAP * scale;
    }
  }

  tree.subtreeWidth = Math.max(tree.width, totalChildrenWidth);
  return tree.subtreeWidth;
}

function assignPositionsOC(tree: TreeNode, xStart: number, y: number, scale: number): void {
  tree.x = xStart + tree.subtreeWidth / 2 - tree.width / 2;
  tree.y = y;

  if (tree.children.length === 0) return;

  let totalChildrenWidth = 0;
  for (let i = 0; i < tree.children.length; i++) {
    totalChildrenWidth += tree.children[i].subtreeWidth;
    if (i < tree.children.length - 1) {
      totalChildrenWidth += HORIZONTAL_GAP * scale;
    }
  }

  let childX = xStart + (tree.subtreeWidth - totalChildrenWidth) / 2;
  const childY = y + tree.height + VERTICAL_GAP * scale * 5;

  for (const child of tree.children) {
    assignPositionsOC(child, childX, childY, scale);
    childX += child.subtreeWidth + HORIZONTAL_GAP * scale;
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
  const childRadius = radius + Math.max(tree.width, 360) + 80;

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

function layoutRadial(rootId: string, nodes: Record<string, Node>, scale: number): LayoutNode[] {
  const tree = buildTree(rootId, nodes, 0, scale);
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
  textScale: number = 1,
): LayoutNode[] {
  switch (layoutType) {
    case 'tree-lr':
      return layoutTreeLR(rootId, nodes, textScale);
    case 'tree-tb':
      return layoutTreeTB(rootId, nodes, textScale);
    case 'radial':
      return layoutRadial(rootId, nodes, textScale);
    case 'org-chart':
      return layoutOrgChart(rootId, nodes, textScale);
    default:
      return layoutTreeLR(rootId, nodes, textScale);
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
    const ln = layoutMap.get(childId);
    if (!ln) continue; // child isn't visible; nothing to position
    // "Visually leaf-like" = no visible descendants. Covers true leaves,
    // collapsed nodes, and depth-limited nodes (data children exist but
    // none are laid out).
    const hasVisibleChildren = child.childrenIds.some((id) => layoutMap.has(id));
    if (hasVisibleChildren) continue;
    leafLayouts.push(ln);
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
 * Walk the subtree rooted at `subtreeRoot` and apply
 * distributeLeavesAroundParent at every node whose direct children include
 * any leaf-like ones. Lets one click on a tree root fan out every leaf
 * cluster in the subtree at once.
 */
export function distributeAllLeavesInSubtree(
  subtreeRoot: string,
  nodes: Record<string, Node>,
  layoutMap: Map<string, LayoutNode>,
): Array<{ id: string; x: number; y: number }> {
  const updates: Array<{ id: string; x: number; y: number }> = [];
  const stack: string[] = [subtreeRoot];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = nodes[id];
    if (!node) continue;
    for (const childId of node.childrenIds) stack.push(childId);
    updates.push(...distributeLeavesAroundParent(id, nodes, layoutMap));
  }
  return updates;
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
