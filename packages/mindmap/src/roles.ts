/**
 * Role lens — which view tabs and side panels a user sees.
 *
 * Modelled on Fulcrum CRM's `useActiveRole` + `ViewConfig`, but deliberately
 * a *lens*, not a permission: switching role never changes what the user may
 * read or write, only which chrome is in their face. Access control stays on
 * the map-membership role (`owner | admin | member | viewer`, core/types.ts).
 *
 * The tab/panel sets come from persona Round 1 (2026-08-26): three simulated
 * users (stakeholder, PM, developer) ran their real tasks against the prod
 * Fulcrum CRM map and reported which of the 9 tabs / 9 panels they actually
 * used. Gantt, Hill Chart and Workload were dropped by all three — nothing on
 * the map carries dates, hill positions or assignees, so those tabs were
 * "empty theatre". Config lives in code on purpose; promote to a DB table
 * only when someone asks to customise it.
 *
 * Later (Dan, 2026-08-26): a map will record who fills each role — a human
 * user or an AI agent (Jenna = PM, Kira/Leidang = developer). That is a
 * per-map `roles[]` with an occupant slot and will set the *default* lens
 * for the occupant; the lens itself stays a client preference.
 */
import type { ActiveView } from './store.js';

export type ViewRole = 'stakeholder' | 'pm' | 'developer' | 'all';

export type PanelKey =
  | 'sprint'
  | 'blocked'
  | 'triage'
  | 'planHealth'
  | 'property'
  | 'aiChat'
  | 'mapChat';
// Comments are not a panel of their own: they live inside Property
// (per-node) and Map chat (map-wide), so they follow those two keys.
// GitHub settings sit in the user menu, not the toolbar — not role-gated.

export interface RoleConfig {
  label: string;
  /** One line for the switcher tooltip — the question this role opens the app with. */
  hint: string;
  /** Tabs in display order. First entry is the default view. */
  tabs: ActiveView[];
  panels: PanelKey[];
}

export const ALL_VIEWS: ActiveView[] = [
  'digest',
  'cockpit',
  'fleet',
  'asks',
  'mindmap',
  'kanban',
  'gantt',
  'releases',
  'requirements',
  'guide',
  'list',
  'calendar',
  'hill',
  'workload',
];

export const ALL_PANELS: PanelKey[] = [
  'sprint',
  'blocked',
  'triage',
  'planHealth',
  'property',
  'aiChat',
  'mapChat',
];

export const ROLE_CONFIG: Record<ViewRole, RoleConfig> = {
  stakeholder: {
    label: 'Stakeholder',
    hint: 'When does it ship, is it on track, what threatens it?',
    // Round 2 (Thomas): Blocked is "219 developer paragraphs", Plan Health
    // unexplained — both dropped. Property stays so a click on a digest line
    // shows the node (review: otherwise the drill-down is a no-op).
    tabs: ['digest', 'releases'],
    panels: ['property'],
  },
  pm: {
    label: 'PM',
    hint: 'What slipped, who is blocked, what do I decide today?',
    // Fragen = the PM's decision inbox ("what do I decide today?" — literally).
    tabs: ['cockpit', 'fleet', 'asks', 'releases', 'list', 'kanban', 'mindmap'],
    panels: ['blocked', 'triage', 'sprint', 'planHealth', 'property', 'mapChat', 'aiChat'],
  },
  developer: {
    label: 'Developer',
    hint: 'What do I pick up next, why does it exist, where is the PR?',
    // Fleet is observability for developers ("who else is pulling, is the
    // queue alive?") — the steering knobs render read-only in this lens.
    // List stays tabs[0] = the landing page; on-screen ORDER comes from
    // App.tsx VIEW_TABS, not from this array.
    // Fragen too (Dan, 2026-09-03): the developer lens answers as well —
    // the questions are the fleet's, whoever is looking decides.
    tabs: ['list', 'kanban', 'mindmap', 'fleet', 'asks'],
    panels: ['blocked', 'property', 'mapChat'],
  },
  all: {
    label: 'All',
    hint: 'Every tab and panel — no filtering.',
    tabs: ALL_VIEWS,
    panels: ALL_PANELS,
  },
};

export const ROLE_ORDER: ViewRole[] = ['stakeholder', 'pm', 'developer', 'all'];

/** Existing users keep today's behaviour until they pick a role. */
export const DEFAULT_ROLE: ViewRole = 'all';

export function isViewRole(value: unknown): value is ViewRole {
  return typeof value === 'string' && (ROLE_ORDER as string[]).includes(value);
}

export function isTabVisible(role: ViewRole, view: ActiveView): boolean {
  return ROLE_CONFIG[role].tabs.includes(view);
}

export function isPanelVisible(role: ViewRole, panel: PanelKey): boolean {
  return ROLE_CONFIG[role].panels.includes(panel);
}

export function defaultViewForRole(role: ViewRole): ActiveView {
  return role === 'all' ? 'mindmap' : ROLE_CONFIG[role].tabs[0];
}

/**
 * The view to land on when the role changes: keep the current one if the new
 * role still shows it, otherwise the role's default.
 */
export function reconcileView(role: ViewRole, current: ActiveView): ActiveView {
  return isTabVisible(role, current) ? current : defaultViewForRole(role);
}

// ── "Current sprint" for the List view's one-click scope ─────────────

/**
 * The sprint a developer means by "this sprint": the one whose date range
 * contains today; failing that the one marked active. Sprint `status` is
 * unreliable on real maps (persona Round 1 found a sprint ending today still
 * `planned`), so dates win over status. When cycles overlap (Round 2: a
 * month-long leftover bucket next to two-week sprints), the one that
 * started most recently wins — that is the plan somebody made last.
 */
export function pickCurrentCycle<C extends { id: string; startDate: string; endDate: string; status: string }>(
  cycles: C[],
  today: Date = new Date(),
): C | null {
  const t = today.toISOString().slice(0, 10);
  const containing = cycles
    .filter((c) => c.startDate.slice(0, 10) <= t && t <= c.endDate.slice(0, 10))
    .sort((a, b) => b.startDate.localeCompare(a.startDate) || (a.status === 'active' ? -1 : 1));
  return containing[0] ?? cycles.find((c) => c.status === 'active') ?? null;
}

// ── Persistence (per browser, like Fulcrum's sidebar.showAll) ────────

export const VIEW_ROLE_STORAGE_KEY = 'mindblown.viewRole';

export function readStoredRole(storage: Pick<Storage, 'getItem'> | undefined = safeStorage()): ViewRole {
  try {
    const raw = storage?.getItem(VIEW_ROLE_STORAGE_KEY);
    return isViewRole(raw) ? raw : DEFAULT_ROLE;
  } catch {
    return DEFAULT_ROLE;
  }
}

export function writeStoredRole(role: ViewRole, storage: Pick<Storage, 'setItem'> | undefined = safeStorage()): void {
  try {
    storage?.setItem(VIEW_ROLE_STORAGE_KEY, role);
  } catch {
    // private mode / quota — the lens just won't survive a reload
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof window !== 'undefined' ? window.localStorage : undefined;
  } catch {
    return undefined;
  }
}
