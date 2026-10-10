import type { Node, ComputedNodeValues } from '@mindblown/core';

/**
 * Around a node (#322): what it waits on (unfinished finish-to-start
 * predecessors, followed transitively — the links that make a node
 * blocked) and what waits on it (FS dependents, transitively, finished or
 * not) — so a developer sees whose work their ticket holds up.
 */
export function dependencyNeighbourhood(
  nodes: Record<string, Node>,
  computed: Map<string, ComputedNodeValues>,
  id: string,
): { upstream: Node[]; downstream: Node[] } {
  const progress = (n: Node) => computed.get(n.id)?.computedProgress ?? n.percentComplete ?? 0;
  const dependents = new Map<string, string[]>();
  for (const n of Object.values(nodes)) {
    for (const d of n.dependencies.filter((x) => x.type === 'FS')) {
      const list = dependents.get(d.targetNodeId) ?? [];
      list.push(n.id);
      dependents.set(d.targetNodeId, list);
    }
  }
  const walk = (start: string, next: (n: Node) => string[], keep: (n: Node) => boolean): Node[] => {
    const seen = new Set<string>([start]);
    const out: Node[] = [];
    const queue = [start];
    while (queue.length > 0) {
      const cur = nodes[queue.shift()!];
      if (!cur) continue;
      for (const nid of next(cur)) {
        const n = nodes[nid];
        if (!n || seen.has(nid) || !keep(n)) continue;
        seen.add(nid);
        out.push(n);
        queue.push(nid);
      }
    }
    return out;
  };
  return {
    upstream: walk(id, (n) => n.dependencies.filter((d) => d.type === 'FS').map((d) => d.targetNodeId), (n) => progress(n) < 100),
    downstream: walk(id, (n) => dependents.get(n.id) ?? [], () => true),
  };
}
