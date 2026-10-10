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

interface BlockableNode {
  status: string | null;
  blockedReason?: string | null;
  tags: string[];
}

/**
 * Explicitly blocked: a blocked reason, the `blocked` tag the fleet sets
 * when it parks a ticket, or a status named `blocked` — the "manually
 * blocked" set of the Blocked panel. Waiting on unfinished dependencies is
 * not this (the dependency arrows already show it). Done work is never
 * shown as blocked.
 */
export function isBlockedCard(node: BlockableNode, isDone: boolean): boolean {
  if (isDone) return false;
  return (
    (node.blockedReason ?? '').trim() !== '' ||
    node.tags.includes('blocked') ||
    (node.status ?? '').toLowerCase() === 'blocked'
  );
}
