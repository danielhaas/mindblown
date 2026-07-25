import { useEffect, useRef } from 'react';
import { useMindmapStore } from './store.js';
import {
  EMPTY_URL_STATE,
  isNavChange,
  parseUrlState,
  resolveDepth,
  resolveView,
  serializeUrlState,
  validateUrlState,
  type UrlState,
  type UrlStateContext,
} from './urlState.js';

/**
 * Keeps the browser URL and the view state in sync, both directions, so a
 * copied link or a reload puts you back where you were.
 *
 * Owns three flows:
 *
 * 1. **Hydrate** — once, after auth: read the URL, load the map it names,
 *    then apply the rest *after* the load resolves. Ordering matters:
 *    `loadMap` resets focus, depth and selection, so applying first would
 *    be silently undone.
 * 2. **Mirror** — subscribe to the store and write changes back to the URL.
 *    Navigation (map / view / focus / node) pushes a history entry; lens
 *    adjustments (depth, filters) replace, so the back stack doesn't fill
 *    with slider noise.
 * 3. **Restore** — on `popstate`, apply the URL back onto the store.
 *
 * Because focus changes push history entries, browser Back now walks the
 * drill-down trail natively. That replaced an in-store `focusHistory` stack
 * driven by a mousedown handler on XButton1; two competing back-stacks
 * fought each other, and the mouse-button approach never worked on mobile.
 *
 * Also owns opening the map when the URL doesn't name one (single-map
 * auto-open), so that all "which map am I on" logic sits in one place
 * rather than racing an effect in App.tsx.
 */

/** Debounce for non-navigation writes (filters, depth, selection churn). */
const MIRROR_DEBOUNCE_MS = 300;

function buildContext(): UrlStateContext {
  const s = useMindmapStore.getState();
  return {
    nodeIds: new Set(Object.keys(s.nodes)),
    versionIds: new Set(s.versions.map((v) => v.id)),
    sprintIds: new Set(s.cycles.map((c) => c.id)),
    phaseIds: new Set((s.currentMap?.phases ?? []).map((p) => p.id)),
  };
}

/** The store's current view state, in URL terms. */
function readStoreUrlState(): UrlState {
  const s = useMindmapStore.getState();
  return {
    map: s.currentMapId,
    view: s.activeView,
    focus: s.focusNodeId,
    node: s.selectedNodeId,
    depth: s.maxDepth,
    version: s.activeVersionFilter,
    sprint: s.activeCycleFilter,
    phase: s.activePhaseFilter,
    reqVersion: s.reqVersionFilter,
    reqVersionMode: s.reqVersionMode === 'exact' ? 'exact' : null,
  };
}

/**
 * Push a parsed URL state onto the store. Every key is written — absent
 * params resolve to their default — so going back from `?view=list` to a
 * bare URL actually returns you to the mindmap.
 */
function applyToStore(state: UrlState): void {
  const s = useMindmapStore.getState();
  s.setActiveView(resolveView(state.view));
  s.setMaxDepth(resolveDepth(state.depth));
  s.setActiveVersionFilter(state.version);
  s.setActiveCycleFilter(state.sprint);
  s.setActivePhaseFilter(state.phase);
  s.setReqVersionFilter(state.reqVersion);
  s.setReqVersionMode(state.reqVersionMode === 'exact' ? 'exact' : 'cumulative');
  s.setFocusNode(state.focus);
  s.selectNode(state.node);
}

/** Load the sprint/version lists a filter id has to be validated against. */
async function loadScopeLists(): Promise<void> {
  const s = useMindmapStore.getState();
  await Promise.all([s.loadCycles(), s.loadVersions()]);
}

export function useUrlState(): void {
  const user = useMindmapStore((s) => s.user);
  const maps = useMindmapStore((s) => s.maps);
  const currentMapId = useMindmapStore((s) => s.currentMapId);
  const loading = useMindmapStore((s) => s.loading);

  /** Blocks store → URL writes while we're driving the store ourselves. */
  const suspended = useRef(true);
  /** Last state we wrote, to classify the next change as nav vs lens. */
  const lastWritten = useRef<UrlState>(EMPTY_URL_STATE);
  /** The landing URL is replaced, not pushed — no duplicate history entry. */
  const firstWrite = useRef(true);
  const hydrateStarted = useRef(false);
  /** Set once a map has been opened, so auto-open doesn't fight hydration. */
  const mapClaimed = useRef(false);

  const writeUrl = useRef((): void => {
    const current = readStoreUrlState();
    const search = serializeUrlState(window.location.search, current);
    // Landing on an already-correct URL still counts as the first write:
    // clear the flag here too, or the next real navigation replaces the
    // landing entry instead of pushing and Back skips straight out of the app.
    const isFirst = firstWrite.current;
    firstWrite.current = false;
    if (search === window.location.search) {
      lastWritten.current = current;
      return;
    }
    const href = window.location.pathname + search + window.location.hash;
    const replace = isFirst || !isNavChange(current, lastWritten.current);
    if (replace) {
      window.history.replaceState({}, '', href);
    } else {
      window.history.pushState({}, '', href);
    }
    lastWritten.current = current;
  }).current;

  // ── 1. Hydrate: URL → store, once, after auth ────────────────
  useEffect(() => {
    if (!user || hydrateStarted.current) return;
    hydrateStarted.current = true;

    void (async () => {
      const target = parseUrlState(window.location.search);

      if (target.map) {
        mapClaimed.current = true;
        await useMindmapStore.getState().loadMap(target.map);
        // A dead map id leaves currentMapId unset and an error on the
        // store — surface that rather than applying view state onto
        // nothing.
        if (useMindmapStore.getState().currentMapId === target.map) {
          await loadScopeLists();
          applyToStore(validateUrlState(target, buildContext()));
        }
      }

      suspended.current = false;
      writeUrl();
    })();
  }, [user, writeUrl]);

  // ── Auto-open the only map, when the URL didn't name one ─────
  useEffect(() => {
    if (mapClaimed.current || currentMapId || loading) return;
    if (maps.length !== 1) return;
    mapClaimed.current = true;
    void useMindmapStore.getState().loadMap(maps[0].id);
  }, [maps, currentMapId, loading]);

  // ── 2. Mirror: store → URL ───────────────────────────────────
  useEffect(() => {
    let timer: number | undefined;

    const unsubscribe = useMindmapStore.subscribe(() => {
      if (suspended.current) return;
      const next = readStoreUrlState();
      // Navigation lands immediately so a link copied right after a click
      // is already correct; lens changes coalesce.
      if (isNavChange(next, lastWritten.current)) {
        window.clearTimeout(timer);
        writeUrl();
        return;
      }
      window.clearTimeout(timer);
      timer = window.setTimeout(writeUrl, MIRROR_DEBOUNCE_MS);
    });

    return () => {
      unsubscribe();
      window.clearTimeout(timer);
    };
  }, [writeUrl]);

  // ── 3. Restore: popstate → store ─────────────────────────────
  useEffect(() => {
    const onPopState = () => {
      const target = parseUrlState(window.location.search);
      suspended.current = true;

      void (async () => {
        try {
          const store = useMindmapStore.getState();
          if (target.map && target.map !== store.currentMapId) {
            mapClaimed.current = true;
            await store.loadMap(target.map);
            if (useMindmapStore.getState().currentMapId !== target.map) return;
            await loadScopeLists();
          } else if (!target.map && store.currentMapId) {
            store.closeMap();
          }
          applyToStore(validateUrlState(target, buildContext()));
        } finally {
          lastWritten.current = readStoreUrlState();
          suspended.current = false;
        }
      })();
    };

    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
}
