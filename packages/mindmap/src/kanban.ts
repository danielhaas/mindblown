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

import {
  BLOCKED_TAG,
  buildIsDonePredicate,
  dispatchHold,
  hasBrief,
  pullableNodes,
  type BlockedBy,
  type Node,
  type StatusDef,
} from '@mindblown/core';

/**
 * Tickets that can be picked up right now: not started (todo or no status),
 * unclaimed, every dependency done, a brief to work from, and nothing that
 * waits for a person — no blocker, no needs-human / kira-skip … tag, on the
 * ticket or an open parent, and not an epic sitting as a leaf. The same
 * predicates the pull queue grants by (core `dispatch.ts`), minus the map's
 * dispatch gate: that fences what the fleet takes, not what is ready.
 *
 * Needs the full nodes (description, externalLinks) — not the mobile
 * board's `?omit=` payload.
 */
export function readyNodeIds(nodes: Node[], workflow: StatusDef[]): Set<string> {
  const { pullable, nodeMap } = pullableNodes(nodes, workflow);
  const ancestors = { nodeMap, isDone: buildIsDonePredicate(workflow) };
  return new Set(
    pullable.filter((n) => hasBrief(n) && dispatchHold(n, ancestors) === null).map((n) => n.id),
  );
}

/**
 * Which column a leaf's card sits in: the workflow step its status names
 * (by id, or by name case-insensitively), or `null` for the no-status column.
 *
 * A leaf with no recognised status that reached 100 % goes to the first
 * done-category column — it is done by the shared `isLeafDone` rule
 * (viewScope.ts), and parking it under "no status" made a finished map look
 * full of open tickets. An explicit status always wins, so dragging such a
 * card back out of Done sticks instead of snapping back.
 */
export function kanbanColumnId(
  node: { status: string | null; percentComplete: number | null },
  workflow: readonly StatusDef[],
): string | null {
  if (node.status) {
    const status = node.status.toLowerCase();
    const match = workflow.find((s) => s.id === node.status || s.name.toLowerCase() === status);
    if (match) return match.id;
  }
  if ((node.percentComplete ?? 0) >= 100) {
    return workflow.find((s) => s.category === 'done')?.id ?? null;
  }
  return null;
}

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

// ── Started ──

/**
 * When work on an in-progress card began (node.startedAt): a short relative
 * label for the card ("started 3h ago", "started Oct 3" once older than two
 * weeks) and the exact local date and time for the hover title.
 * null when the node has no start on record.
 */
export function startedLabel(
  startedAt: string | null | undefined,
  now: Date = new Date(),
): { short: string; full: string } | null {
  const t = startedAt ? Date.parse(startedAt) : NaN;
  if (!Number.isFinite(t)) return null;
  const started = new Date(t);
  const minutes = Math.max(0, Math.floor((now.getTime() - t) / 60_000));
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const ago =
    minutes < 1 ? 'just now'
      : minutes < 60 ? `${minutes}m ago`
        : hours < 24 ? `${hours}h ago`
          : days < 14 ? `${days}d ago`
            : started.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const full = started.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  return { short: `started ${ago}`, full: `Started ${full}` };
}

// ── ETA ──

/**
 * The worker's own ETA on an in-progress card (node.expectedDoneAt): "ETA
 * 15:40" today, "ETA Oct 22, 15:40" on another day, "overdue 2h" once
 * past; the exact time for the hover title. null without an ETA.
 */
export function etaLabel(
  expectedDoneAt: string | null | undefined,
  now: Date = new Date(),
): { short: string; full: string; overdue: boolean } | null {
  const t = expectedDoneAt ? Date.parse(expectedDoneAt) : NaN;
  if (!Number.isFinite(t)) return null;
  const eta = new Date(t);
  const full = `ETA ${eta.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })}`;
  if (t < now.getTime()) {
    const minutes = Math.floor((now.getTime() - t) / 60_000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    const late = minutes < 60 ? `${Math.max(1, minutes)}m` : hours < 24 ? `${hours}h` : `${days}d`;
    return { short: `overdue ${late}`, full, overdue: true };
  }
  const time = eta.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  const sameDay = eta.toDateString() === now.toDateString();
  const day = sameDay ? '' : `${eta.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, `;
  return { short: `ETA ${day}${time}`, full, overdue: false };
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
