import type { BraindumpNode } from '../api.js';

export type FlatRow = {
  path: number[];
  depth: number;
  node: BraindumpNode;
};

export function flatten(tree: BraindumpNode[], parentPath: number[] = []): FlatRow[] {
  const rows: FlatRow[] = [];
  tree.forEach((node, i) => {
    const path = [...parentPath, i];
    rows.push({ path, depth: parentPath.length, node });
    if (node.children.length > 0) rows.push(...flatten(node.children, path));
  });
  return rows;
}

export function updateAt(
  tree: BraindumpNode[],
  path: number[],
  updater: (n: BraindumpNode) => BraindumpNode,
): BraindumpNode[] {
  return tree.map((n, i) => {
    if (i !== path[0]) return n;
    if (path.length === 1) return updater(n);
    return { ...n, children: updateAt(n.children, path.slice(1), updater) };
  });
}

export function removeAt(tree: BraindumpNode[], path: number[]): BraindumpNode[] {
  if (path.length === 1) return tree.filter((_, i) => i !== path[0]);
  return tree.map((n, i) =>
    i === path[0] ? { ...n, children: removeAt(n.children, path.slice(1)) } : n,
  );
}

export function countNodes(tree: BraindumpNode[]): number {
  return tree.reduce((acc, n) => acc + 1 + countNodes(n.children), 0);
}
