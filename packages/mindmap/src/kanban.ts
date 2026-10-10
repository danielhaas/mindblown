/**
 * Kanban card rules shared by the desktop and mobile boards.
 *
 * ── Done groups ──
 * The Done column, split by when the work was finished: Today, This week
 * (since Monday, local time) and Earlier. A long-lived map's Done column
 * grows into hundreds of cards; what a reader wants from it is "what got
 * done today / this week", with the history one click away.
 *
 * Cards without a completedAt (imported already done) go to Earlier.
 * Within a group the most recently finished card comes first.
 */

import { BLOCKED_TAG, type BlockedBy } from '@mindblown/core';

export type DoneGroupKey = 'today' | 'week' | 'earlier';

export interface DoneGroup<T> {
  key: DoneGroupKey;
  label: string;
  items: T[];
}

/** Local midnight today and local Monday 00:00 of this week, as epoch ms. */
export function doneGroupBounds(now: Date = new Date()): { todayStart: number; weekStart: number } {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysSinceMonday = (today.getDay() + 6) % 7;
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysSinceMonday);
  return { todayStart: today.getTime(), weekStart: monday.getTime() };
}

export function groupDone<T>(
  items: T[],
  completedAt: (item: T) => string | null | undefined,
  now: Date = new Date(),
): DoneGroup<T>[] {
  const { todayStart, weekStart } = doneGroupBounds(now);
  const at = (item: T): number => {
    const iso = completedAt(item);
    const t = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(t) ? t : -Infinity;
  };
  const sorted = [...items].sort((a, b) => at(b) - at(a));
  const groups: DoneGroup<T>[] = [
    { key: 'today', label: 'Today', items: [] },
    { key: 'week', label: 'This week', items: [] },
    { key: 'earlier', label: 'Earlier', items: [] },
  ];
  for (const item of sorted) {
    const t = at(item);
    if (t >= todayStart) groups[0].items.push(item);
    else if (t >= weekStart) groups[1].items.push(item);
    else groups[2].items.push(item);
  }
  return groups;
}

// ── Blocked ──

/** What a card shows: a manual block, a dependency wait, or nothing. */
export type CardBlock = { kind: 'blocked' | 'waiting'; detail: string } | null;

interface BlockableNode {
  status: string | null;
  blockedReason?: string | null;
  tags: string[];
}

/**
 * The Blocked panel's rule (core computeIsBlocked), so the board and the
 * panel always show the same set:
 *   - blocked: a blocked reason (manual), plus the two other markers the
 *     fleet's park path writes — the `blocked` tag and a status named
 *     "blocked";
 *   - waiting: a finish-to-start predecessor that is not 100% done.
 * Done work is never shown as blocked.
 */
export function cardBlockState(
  node: BlockableNode,
  blockedBy: Pick<BlockedBy, 'manual' | 'predecessorIds'> | null | undefined,
  isDone: boolean,
  titleOf: (id: string) => string,
): CardBlock {
  if (isDone) return null;
  const manual =
    Boolean(blockedBy?.manual) ||
    (node.blockedReason ?? '').trim() !== '' ||
    node.tags.includes(BLOCKED_TAG) ||
    (node.status ?? '').toLowerCase() === 'blocked';
  if (manual) {
    const reason = (node.blockedReason ?? '').trim();
    return { kind: 'blocked', detail: reason ? `Blocked: ${reason}` : 'Blocked' };
  }
  const preds = blockedBy?.predecessorIds ?? [];
  if (preds.length > 0) {
    return { kind: 'waiting', detail: `Waiting on: ${preds.map(titleOf).join(', ')}` };
  }
  return null;
}
