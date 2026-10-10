/**
 * What a sprint's dates and contents say about it (#324) — shared by the
 * Sprint panel and the `sprint-state` Plan Health rule, so the two agree.
 *
 * Found in the wild: a sprint that ended "today" still `planned` (never
 * activated), its successor overlapping another sprint of the same version,
 * 76 items in progress against a WIP limit of 10 with 63 stalled — and the
 * Sprint panel showed dates only, Plan Health "3 warnings".
 */

export interface SprintLike {
  id: string;
  name: string;
  status: 'planned' | 'active' | 'completed';
  startDate: string;
  endDate: string;
  versionId: string | null;
}

export interface SprintItem {
  /** Category of the item's status: 'todo' | 'in_progress' | 'done' | null (no status). */
  category: string | null;
  percentComplete: number | null;
  updatedAt: string;
}

export interface SprintSignals {
  /** The sprint's state disagrees with its dates; null when they agree. */
  stateIssue: string | null;
  /** Names of other open sprints of the same version whose dates overlap. */
  overlaps: string[];
  /** Items in progress in this sprint, against the map's WIP limit (null = none set). */
  wip: { count: number; limit: number | null; over: boolean };
  /** In-progress items not touched for `stalledDays`. */
  stalled: number;
  stalledDays: number;
}

/** Same default as plan_lint's stale-progress rule. */
export const SPRINT_STALLED_DAYS = 7;

const day = (iso: string) => iso.slice(0, 10);

export function sprintSignals(input: {
  sprint: SprintLike;
  sprints: SprintLike[];
  items: SprintItem[];
  wipLimit: number | null;
  now?: Date;
  stalledDays?: number;
}): SprintSignals {
  const { sprint, sprints, items, wipLimit, now = new Date(), stalledDays = SPRINT_STALLED_DAYS } = input;
  const today = now.toISOString().slice(0, 10);
  const start = day(sprint.startDate);
  const end = day(sprint.endDate);

  let stateIssue: string | null = null;
  if (sprint.status === 'planned' && end < today) {
    stateIssue = `Ended ${end} but still planned — never started`;
  } else if (sprint.status === 'planned' && start <= today) {
    stateIssue = `Started ${start} on paper but still planned`;
  } else if (sprint.status === 'active' && end < today) {
    stateIssue = `Ended ${end} but still active`;
  }

  const overlaps =
    sprint.status === 'completed'
      ? []
      : sprints
          .filter(
            (o) =>
              o.id !== sprint.id &&
              o.status !== 'completed' &&
              o.versionId === sprint.versionId &&
              day(o.startDate) <= end &&
              start <= day(o.endDate),
          )
          .map((o) => o.name);

  const open = items.filter((i) => i.category !== 'done' && (i.percentComplete ?? 0) < 100);
  const inProgress = open.filter((i) => i.category === 'in_progress');
  const staleBefore = now.getTime() - stalledDays * 86_400_000;
  const stalled = inProgress.filter((i) => Date.parse(i.updatedAt) < staleBefore).length;

  return {
    stateIssue,
    overlaps,
    wip: { count: inProgress.length, limit: wipLimit, over: wipLimit != null && inProgress.length > wipLimit },
    stalled,
    stalledDays,
  };
}
