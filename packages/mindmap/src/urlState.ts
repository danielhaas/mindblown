import type { ActiveView } from './store.js';
import { defaultViewForRole } from './roles.js';
import type { ViewRole } from './roles.js';

/**
 * URL ⇄ view-state mirroring.
 *
 * Everything the app needs to put you back where you were when a link is
 * pasted or the page is reloaded. Pure functions only (no DOM, no store)
 * so the parse / serialize / validate rules are unit-testable; the wiring
 * lives in `useUrlState.ts` (desktop) and `mobile/MobileApp.tsx`.
 *
 * Design rules:
 *
 * - **Defaults are omitted from the URL.** A map opened on the mindmap at
 *   depth 1 still serializes to plain `?map=<id>`, exactly the URL shape
 *   that shipped before this module existed — old links keep working and
 *   new ones don't grow noise. The flip side: absent means *default*, not
 *   *unchanged*, so applying a parsed state must always write every key
 *   (otherwise going back from `?view=list` would leave you on the list).
 *
 * - **Unknown params survive a round trip.** `serializeUrlState` edits the
 *   caller's existing query string rather than building a fresh one, so
 *   `?m=1` (mobile override) and the GitHub OAuth `?gh=…` handshake aren't
 *   clobbered by a view switch.
 *
 * - **Ephemeral UI stays out.** Open panels, dialogs and modals are not
 *   mirrored: a shared link that reopens a half-filled Share dialog is
 *   worse than one that doesn't.
 */

// ── Param names ────────────────────────────────────────────────

const PARAM = {
  map: 'map',
  view: 'view',
  focus: 'focus',
  node: 'node',
  depth: 'depth',
  version: 'v',
  sprint: 's',
  phase: 'p',
  // Requirements register release filter — distinct from `v` (the canvas
  // scope filter): a version id, or 'none' for "no release assigned".
  reqVersion: 'rv',
  // 'exact' = "only this release"; absent = cumulative ("through").
  reqVersionMode: 'rvm',
} as const;

/** The literal `rv` value meaning "only requirements with no release". */
export const REQ_VERSION_NONE = 'none';

/** Every param this module owns — used to clear stale keys on write. */
const OWNED_PARAMS: readonly string[] = Object.values(PARAM);

// ── Defaults ───────────────────────────────────────────────────

export const DEFAULT_VIEW: ActiveView = 'mindmap';
export const DEFAULT_DEPTH = 1;

/** Upper bound for `depth`, mirroring the store's practical range. */
const MAX_DEPTH = 20;

const VIEW_IDS: ReadonlySet<string> = new Set<ActiveView>([
  'mindmap',
  'kanban',
  'gantt',
  'list',
  'calendar',
  'hill',
  'workload',
  'releases',
  'requirements',
  'guide',
  'digest',
  'cockpit',
  'fleet',
  'asks',
]);

// ── Shape ──────────────────────────────────────────────────────

/**
 * The mirrored slice of view state. `null` means "absent from the URL",
 * which for `view` and `depth` resolves to the default rather than to a
 * cleared value — see `resolveView` / `resolveDepth`.
 */
export interface UrlState {
  map: string | null;
  view: ActiveView | null;
  focus: string | null;
  node: string | null;
  depth: number | null;
  version: string | null;
  sprint: string | null;
  phase: string | null;
  /** Requirements register release filter: version id, 'none', or absent. */
  reqVersion: string | null;
  /** 'exact' when the register shows only the selected release; null = cumulative. */
  reqVersionMode: 'exact' | null;
}

export const EMPTY_URL_STATE: UrlState = {
  map: null,
  view: null,
  focus: null,
  node: null,
  depth: null,
  version: null,
  sprint: null,
  phase: null,
  reqVersion: null,
  reqVersionMode: null,
};

/** Keys that count as navigation — these push a history entry. */
export const NAV_KEYS: readonly (keyof UrlState)[] = ['map', 'view', 'focus', 'node'];

// ── Parse ──────────────────────────────────────────────────────

function readId(params: URLSearchParams, key: string): string | null {
  const raw = params.get(key);
  if (raw === null) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Read the mirrored state out of a query string. Malformed values are
 * dropped rather than surfaced as errors — a hand-edited or truncated
 * link should degrade to "sensible default", never to a crash.
 */
export function parseUrlState(search: string): UrlState {
  const params = new URLSearchParams(search);

  const rawView = readId(params, PARAM.view);
  const view = rawView !== null && VIEW_IDS.has(rawView) ? (rawView as ActiveView) : null;

  const rawDepth = readId(params, PARAM.depth);
  let depth: number | null = null;
  if (rawDepth !== null) {
    const n = Number(rawDepth);
    // 0 is meaningful here — the store reads it as "unlimited".
    if (Number.isInteger(n) && n >= 0 && n <= MAX_DEPTH) depth = n;
  }

  return {
    map: readId(params, PARAM.map),
    view,
    focus: readId(params, PARAM.focus),
    node: readId(params, PARAM.node),
    depth,
    version: readId(params, PARAM.version),
    sprint: readId(params, PARAM.sprint),
    phase: readId(params, PARAM.phase),
    reqVersion: readId(params, PARAM.reqVersion),
    reqVersionMode: readId(params, PARAM.reqVersionMode) === 'exact' ? 'exact' : null,
  };
}

// ── Serialize ──────────────────────────────────────────────────

/**
 * Write `state` into `search`, preserving any param this module doesn't
 * own. Values equal to their default are deleted rather than written, so
 * the common case stays at `?map=<id>`.
 *
 * Returns a query string including the leading `?`, or `''` when empty.
 */
export function serializeUrlState(search: string, state: UrlState): string {
  const params = new URLSearchParams(search);

  for (const key of OWNED_PARAMS) params.delete(key);

  if (state.map) params.set(PARAM.map, state.map);
  // Always written: since roles, a bare URL means "the role's default view",
  // so eliding 'mindmap' would send a PM's copied mindmap link to the cockpit.
  if (state.view) params.set(PARAM.view, state.view);
  if (state.focus) params.set(PARAM.focus, state.focus);
  if (state.node) params.set(PARAM.node, state.node);
  if (state.depth !== null && state.depth !== DEFAULT_DEPTH) {
    params.set(PARAM.depth, String(state.depth));
  }
  if (state.version) params.set(PARAM.version, state.version);
  if (state.sprint) params.set(PARAM.sprint, state.sprint);
  if (state.phase) params.set(PARAM.phase, state.phase);
  if (state.reqVersion) {
    params.set(PARAM.reqVersion, state.reqVersion);
    // Mode only matters alongside a concrete release — 'none' and "all
    // releases" ignore it, so don't let it linger in the URL.
    if (state.reqVersionMode === 'exact' && state.reqVersion !== REQ_VERSION_NONE) {
      params.set(PARAM.reqVersionMode, state.reqVersionMode);
    }
  }

  const str = params.toString();
  return str === '' ? '' : `?${str}`;
}

// ── Validate ───────────────────────────────────────────────────

/**
 * What the loaded map actually contains, for checking a link against
 * reality. Built by the caller after the map (and its versions / sprints)
 * have loaded.
 */
export interface UrlStateContext {
  nodeIds: ReadonlySet<string>;
  versionIds: ReadonlySet<string>;
  sprintIds: ReadonlySet<string>;
  phaseIds: ReadonlySet<string>;
}

/**
 * Drop references that no longer resolve.
 *
 * This is the difference between a stale link degrading gracefully and one
 * that looks like data loss: a `?v=` pointing at a deleted version would
 * otherwise filter every node out and render an empty map. Unknown ids are
 * cleared, which falls back to root / no filter.
 *
 * `map` is deliberately not validated here — a wrong map id is a load
 * failure the caller surfaces as an error, not something to silently drop.
 */
export function validateUrlState(state: UrlState, ctx: UrlStateContext): UrlState {
  return {
    map: state.map,
    view: state.view,
    focus: state.focus && ctx.nodeIds.has(state.focus) ? state.focus : null,
    node: state.node && ctx.nodeIds.has(state.node) ? state.node : null,
    depth: state.depth,
    version: state.version && ctx.versionIds.has(state.version) ? state.version : null,
    sprint: state.sprint && ctx.sprintIds.has(state.sprint) ? state.sprint : null,
    phase: state.phase && ctx.phaseIds.has(state.phase) ? state.phase : null,
    reqVersion:
      state.reqVersion &&
      (state.reqVersion === REQ_VERSION_NONE || ctx.versionIds.has(state.reqVersion))
        ? state.reqVersion
        : null,
    reqVersionMode: state.reqVersionMode,
  };
}

// ── Resolve ────────────────────────────────────────────────────

export function resolveView(view: ActiveView | null, role: ViewRole = 'all'): ActiveView {
  return view ?? defaultViewForRole(role);
}

export function resolveDepth(depth: number | null): number {
  return depth ?? DEFAULT_DEPTH;
}

// ── Compare ────────────────────────────────────────────────────

/** True when `a` and `b` differ in at least one navigation key. */
export function isNavChange(a: UrlState, b: UrlState): boolean {
  return NAV_KEYS.some((k) => a[k] !== b[k]);
}
