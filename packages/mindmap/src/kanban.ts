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
  buildTodoIds,
  dispatchHold,
  effectiveVersionId,
  EPIC_HOLD_TAG,
  hasBrief,
  matchesDispatchGate,
  parseGateEntry,
  type BlockedBy,
  type Node,
  type NodeMap,
  type StatusDef,
} from '@mindblown/core';

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

/**
 * A cancelled ticket is off the board: a "cancelled" status the workflow
 * has no column for landed in Unset and counted as ready there (Navy,
 * 21.10.2026). A map whose workflow has a Cancelled column keeps showing it.
 */
export function hiddenFromBoard(node: { status: string | null }, workflow: readonly StatusDef[]): boolean {
  if (!node.status || !/^cancel+ed$/i.test(node.status)) return false;
  const status = node.status.toLowerCase();
  return !workflow.some((s) => s.id === node.status || s.name.toLowerCase() === status);
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

/**
 * What a card shows: a manual block, a hold for a person, a dependency
 * wait, or nothing.
 */
export type CardBlock = { kind: 'blocked' | 'human' | 'waiting' | 'later' | 'brief'; detail: string } | null;

interface BlockableNode {
  status: string | null;
  blockedReason?: string | null;
  tags: string[];
}

/**
 * Tickets held for a person, keyed by id, with the hover text: a skip tag
 * (needs-human, kira-skip …) on the ticket, or a skip tag or manual blocker
 * on an open parent — `dispatchHold`, the rule the pull queue skips by. An
 * epic leaf is held too, but for the fleet, not for a person: left out.
 */
export function personHolds(nodes: Node[], workflow: StatusDef[]): Map<string, string> {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const ancestors = { nodeMap, isDone: buildIsDonePredicate(workflow) };
  const holds = new Map<string, string>();
  for (const n of nodes) {
    const hold = dispatchHold(n, ancestors);
    if (!hold) continue;
    if (hold.heldBy) {
      const why = hold.tag ? `is tagged ${hold.tag}` : `is blocked: ${(hold.blockedReason ?? '').trim()}`;
      holds.set(n.id, `Needs a person: parent "${hold.heldBy.text}" ${why}`);
    } else if (hold.tag && hold.tag !== EPIC_HOLD_TAG) {
      holds.set(n.id, `Needs a person: tagged ${hold.tag}`);
    }
  }
  return holds;
}

/**
 * The Blocked panel's rule (core computeIsBlocked), so the board and the
 * panel always show the same set:
 *   - blocked: a blocked reason (manual), plus the two other markers the
 *     fleet's park path writes — the `blocked` tag and a status named
 *     "blocked";
 *   - human: held for a person (`personHolds`), passed in as its hover text;
 *   - waiting: a finish-to-start predecessor that is not 100% done;
 *   - later: outside the dispatch gate (`outsideGate`), passed in as its hover text;
 *   - brief: no description and no linked issue (`needsBriefOnBoard`).
 * Done work is never shown as blocked.
 */
export function cardBlockState(
  node: BlockableNode,
  blockedBy: Pick<BlockedBy, 'manual' | 'predecessorIds'> | null | undefined,
  isDone: boolean,
  titleOf: (id: string) => string,
  personHold: string | null = null,
  laterNote: string | null = null,
  needsBrief = false,
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
  if (personHold) return { kind: 'human', detail: personHold };
  const preds = blockedBy?.predecessorIds ?? [];
  if (preds.length > 0) {
    return { kind: 'waiting', detail: `Waiting on: ${preds.map(titleOf).join(', ')}` };
  }
  if (laterNote) return { kind: 'later', detail: laterNote };
  if (needsBrief) return { kind: 'brief', detail: NEEDS_BRIEF_NOTE };
  return null;
}

const NEEDS_BRIEF_NOTE = 'Needs a brief — no description and no linked issue, so the fleet will not take it';

/**
 * An open ticket the pull queue refuses for want of a brief (core
 * `hasBrief`): no description, no linked issue. Only in a todo-category or
 * the no-status column — running work already has its worker. Needs the
 * full node: a board loaded with `?omit=description` (mobile) cannot tell.
 */
export function needsBriefOnBoard(
  node: Pick<Node, 'description' | 'externalLinks'>,
  columnCategory: string | null,
): boolean {
  if (columnCategory !== null && columnCategory !== 'todo') return false;
  return !hasBrief(node);
}

/**
 * Open tickets the fleet will not take because the map's dispatch gate
 * fences them out — a later version, or no version while the gate names
 * one (21.10.2026: Navy's Unset and V3/V4 cards looked ready, the fleet sat
 * idle). Keyed by id, with the hover text. Only todo-category or no-status
 * tickets: the gate decides what is pulled, not what is already running.
 * An empty gate fences nothing.
 */
export function outsideGate(
  nodes: Node[],
  gate: readonly string[],
  workflow: StatusDef[],
  versionName: (id: string) => string | null = () => null,
): Map<string, string> {
  const out = new Map<string, string>();
  if (gate.length === 0) return out;
  const nodeMap = new Map(nodes.map((n) => [n.id, n])) as NodeMap;
  const todoIds = buildTodoIds(workflow);
  const term = (t: string): string => {
    const p = parseGateEntry(t);
    return p.kind === 'bugs' ? 'bugs' : p.kind === 'version' ? (versionName(p.versionId) ?? 'a version') : t;
  };
  const takes = gate
    .map((g) => {
      const p = parseGateEntry(g);
      return p.kind === 'any' ? p.options.map((o) => term(o.raw)).join(', ') : term(g);
    })
    .join(' and ');
  for (const n of nodes) {
    if (n.parentId === null || n.childrenIds.length > 0) continue;
    if (n.status !== null && !todoIds.has(n.status)) continue;
    if (matchesDispatchGate(n, [...gate], nodeMap)) continue;
    const v = effectiveVersionId(n.id, nodeMap);
    const is = v ? (versionName(v) ?? 'another version') : 'in no version';
    out.set(n.id, `Later — the fleet takes ${takes}; this ticket is ${is}`);
  }
  return out;
}
