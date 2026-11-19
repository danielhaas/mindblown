/**
 * The kanban board at a glance (#589) — what the Android home-screen widget
 * shows: what is in progress, what is blocked and why, WIP against the
 * limit, and how many cards wait for review. Read-only and compact; the
 * widget has room for a handful of rows, not the whole board.
 *
 * Same card rules as the boards (mindmap/src/kanban.ts): leaves only, the
 * root and cancelled tickets off the board, a status resolved by id or by
 * name. Blocked is `computeIsBlocked` on an open leaf, like the Blocked
 * panel.
 */

import { computeIsBlocked } from './compute.js';
import { resolveStatusDef } from './statusWorkflow.js';
import type { MindMap, Node, NodeMap } from './types.js';

export interface BoardSummaryItem {
  id: string;
  title: string;
  /** Short context: the parent's title (skipped when it is the root). */
  context: string | null;
}

export interface BoardSummaryBlocked extends BoardSummaryItem {
  /** The blocker text, or "Waiting on <predecessor>" when only a dependency blocks it. */
  reason: string;
}

export interface BoardSummary {
  mapId: string;
  mapName: string;
  generatedAt: string;
  inProgress: { count: number; items: BoardSummaryItem[] };
  blocked: { count: number; items: BoardSummaryBlocked[] };
  /** Open cards in an in-progress-category status whose name says review. */
  inReview: number;
  wip: { count: number; limit: number | null };
}

const REVIEW_RE = /review/i;
export const BOARD_SUMMARY_DEFAULT_LIMIT = 5;

/**
 * Summarise one map's board. `limit` caps each item list (the counts are
 * always the full numbers). In-progress cards most recently started first;
 * blocked cards with a manual reason before those only waiting on a
 * predecessor.
 */
export function summarizeBoard(
  map: Pick<MindMap, 'id' | 'name' | 'rootNodeId' | 'statusWorkflow' | 'wipLimit'>,
  nodes: Node[],
  opts: { limit?: number; now?: Date } = {},
): BoardSummary {
  const limit = opts.limit ?? BOARD_SUMMARY_DEFAULT_LIMIT;
  const byId: NodeMap = new Map(nodes.map((n) => [n.id, n]));
  const contextOf = (n: Node): string | null => {
    const parent = n.parentId ? byId.get(n.parentId) : undefined;
    return parent && parent.id !== map.rootNodeId ? parent.text : null;
  };
  const item = (n: Node): BoardSummaryItem => ({ id: n.id, title: n.text, context: contextOf(n) });

  const inProgress: Node[] = [];
  const blocked: { node: Node; reason: string; manual: boolean }[] = [];
  let inReview = 0;

  for (const n of nodes) {
    if (n.id === map.rootNodeId || n.childrenIds.length > 0) continue;
    const def = resolveStatusDef(map.statusWorkflow, n.status);
    if (!def && n.status && /^cancel+ed$/i.test(n.status)) continue;
    const done = def ? def.category === 'done' : (n.percentComplete ?? 0) >= 100;
    if (done) continue;

    if (def?.category === 'in_progress') {
      if (REVIEW_RE.test(def.name)) inReview += 1;
      else inProgress.push(n);
    }

    const { isBlocked, blockedBy } = computeIsBlocked(n, byId);
    if (isBlocked) {
      const reason = n.blockedReason?.trim()
        ? n.blockedReason.trim()
        : `Waiting on ${blockedBy.predecessorIds.map((id) => byId.get(id)?.text ?? id).join(', ')}`;
      blocked.push({ node: n, reason, manual: blockedBy.manual });
    }
  }

  const startedAt = (n: Node): number => (n.startedAt ? Date.parse(n.startedAt) : NaN) || 0;
  inProgress.sort((a, b) => startedAt(b) - startedAt(a));
  blocked.sort((a, b) => Number(b.manual) - Number(a.manual));

  return {
    mapId: map.id,
    mapName: map.name,
    generatedAt: (opts.now ?? new Date()).toISOString(),
    inProgress: { count: inProgress.length, items: inProgress.slice(0, limit).map(item) },
    blocked: {
      count: blocked.length,
      items: blocked.slice(0, limit).map((b) => ({ ...item(b.node), reason: b.reason })),
    },
    inReview,
    wip: { count: inProgress.length + inReview, limit: map.wipLimit ?? null },
  };
}
