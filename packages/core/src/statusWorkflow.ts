/**
 * Status-workflow helpers.
 *
 * A map's status workflow is `StatusDef[]` (see types.ts). Multiple
 * server modules need to answer the same questions against it — "is
 * this status `done`?", "which IDs are in_progress?", "find the def
 * matching this string." Until #119 these lived inline in
 * `services/orchestration.ts` and `db/nodes.ts`, with slightly
 * different shapes. Promoted here so there's one source of truth and
 * future tools can import the same predicates.
 *
 * The string-key lookup is intentionally case-insensitive on name
 * (callers may pass "done", "Done", "DONE") AND accepts the def's
 * `id` directly — older callers store the id, newer ones the
 * display name.
 */

import type { StatusDef } from './types.js';

/**
 * Find the `StatusDef` matching a status key — either its `id` or its
 * `name` (case-insensitive). Returns undefined if no def matches; the
 * caller decides whether that's an error or a "no status" sentinel.
 */
export function resolveStatusDef(
  workflow: StatusDef[],
  statusKey: string | null,
): StatusDef | undefined {
  if (statusKey == null) return undefined;
  const lower = statusKey.toLowerCase();
  return workflow.find((s) => s.id === statusKey || s.name.toLowerCase() === lower);
}

/**
 * Return a predicate that maps a status key to whether it represents
 * the `done` category. Null/missing keys are never done.
 */
export function buildIsDonePredicate(
  workflow: StatusDef[],
): (status: string | null) => boolean {
  const doneIds = new Set(workflow.filter((s) => s.category === 'done').map((s) => s.id));
  const doneNames = new Set(
    workflow.filter((s) => s.category === 'done').map((s) => s.name.toLowerCase()),
  );
  return (status: string | null): boolean => {
    if (!status) return false;
    return doneIds.has(status) || doneNames.has(status.toLowerCase());
  };
}

/** Set of status IDs whose category is `in_progress`. */
export function buildInProgressIds(workflow: StatusDef[]): Set<string> {
  return new Set(workflow.filter((s) => s.category === 'in_progress').map((s) => s.id));
}

/** Set of status IDs whose category is `todo`. */
export function buildTodoIds(workflow: StatusDef[]): Set<string> {
  return new Set(workflow.filter((s) => s.category === 'todo').map((s) => s.id));
}
