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
  /** Items in progress in this sprint. (The WIP limit is map-wide — compare it with the map's total, as get_wip_status and the Cockpit do.) */
  inProgress: number;
  /** In-progress items not touched for `stalledDays`. */
  stalled: number;
  stalledDays: number;
}

/** Same threshold as the Cockpit's sprint health (landing.sprintHealth). */
export const SPRINT_STALLED_DAYS = 14;

const day = (iso: string) => iso.slice(0, 10);

export function sprintSignals(input: {
  sprint: SprintLike;
  sprints: SprintLike[];
  items: SprintItem[];
  now?: Date;
  stalledDays?: number;
}): SprintSignals {
  const { sprint, sprints, items, now = new Date(), stalledDays = SPRINT_STALLED_DAYS } = input;
  const today = now.toISOString().slice(0, 10);
  const start = day(sprint.startDate);
  const end = day(sprint.endDate);

  let stateIssue: string | null = null;
  if (sprint.status === 'planned' && end < today) {
    stateIssue = `Ended ${end} but still planned — never started`;
  } else if (sprint.status === 'planned' && start < today) {
    // One day of grace: a sprint starting today is activated at the standup.
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
              // A shared boundary day (one ends, the next starts) is a handover, not an overlap.
              day(o.startDate) < end &&
              start < day(o.endDate),
          )
          .map((o) => o.name);

  const open = items.filter((i) => i.category !== 'done' && (i.percentComplete ?? 0) < 100);
  const inProgress = open.filter((i) => i.category === 'in_progress');
  const staleBefore = now.getTime() - stalledDays * 86_400_000;
  const stalled = inProgress.filter((i) => Date.parse(i.updatedAt) < staleBefore).length;

  return {
    stateIssue,
    overlaps,
    inProgress: inProgress.length,
    stalled,
    stalledDays,
  };
}
