import { useCallback, useEffect, useRef, useState } from 'react';
import { useMindmapStore } from '../store.js';
import { AuthScreen } from '../AuthScreen.js';
import { MobileMapList } from './MobileMapList.js';
import { MobileViewer } from './MobileViewer.js';
import * as api from '../api.js';
import type { MapSummary } from '../api.js';
import { parseUrlState, serializeUrlState } from '../urlState.js';
import './mobile.css';

/**
 * Mirror the picked map into `?map=`, matching the desktop param vocabulary
 * so a link works on either surface. Mobile keeps its own map selection
 * (a `MapSummary`, not the shared store's `currentMapId`), hence the local
 * wiring instead of `useUrlState`.
 */
function writeMapParam(mapId: string | null, replace: boolean): void {
  const search = serializeUrlState(window.location.search, {
    ...parseUrlState(window.location.search),
    map: mapId,
  });
  if (search === window.location.search) return;
  const href = window.location.pathname + search + window.location.hash;
  if (replace) {
    window.history.replaceState({}, '', href);
  } else {
    window.history.pushState({}, '', href);
  }
}

export function MobileApp() {
  const user = useMindmapStore((s) => s.user);
  const checkAuth = useMindmapStore((s) => s.checkAuth);

  const [selectedMap, setSelectedMap] = useState<MapSummary | null>(null);
  const hydrateStarted = useRef(false);
  /** Blocks the mirror effect while we're applying a URL ourselves. */
  const suspended = useRef(true);

  useEffect(() => {
    document.body.classList.add('mobile');
    return () => {
      document.body.classList.remove('mobile');
    };
  }, []);

  useEffect(() => {
    void checkAuth();
  }, [checkAuth]);

  /** Resolve a map id from the URL against the map list. */
  const resolveMap = useCallback(async (mapId: string): Promise<MapSummary | null> => {
    try {
      const maps = await api.fetchMaps();
      return maps.find((m) => m.id === mapId) ?? null;
    } catch {
      // Fall back to the map list screen rather than an error wall — the
      // link is still recoverable by tapping through.
      return null;
    }
  }, []);

  // URL → state, once, after auth.
  useEffect(() => {
    if (!user || hydrateStarted.current) return;
    hydrateStarted.current = true;
    void (async () => {
      const { map } = parseUrlState(window.location.search);
      if (map) {
        const found = await resolveMap(map);
        if (found) setSelectedMap(found);
      }
      suspended.current = false;
      writeMapParam(map ?? null, true);
    })();
  }, [user, resolveMap]);

  // State → URL. Opening/closing a map pushes, so Back returns to the list.
  useEffect(() => {
    if (suspended.current) return;
    writeMapParam(selectedMap?.id ?? null, false);
  }, [selectedMap]);

  // Browser Back / Forward.
  useEffect(() => {
    const onPopState = () => {
      const { map } = parseUrlState(window.location.search);
      suspended.current = true;
      void (async () => {
        try {
          if (!map) {
            setSelectedMap(null);
            return;
          }
          const found = await resolveMap(map);
          setSelectedMap(found);
        } finally {
          suspended.current = false;
        }
      })();
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [resolveMap]);

  if (!user) {
    return (
      <div className="mb-mobile">
        <AuthScreen />
      </div>
    );
  }

  if (!selectedMap) {
    return (
      <div className="mb-mobile">
        <div className="mb-topbar">
          <span style={{ width: 60 }} />
          <div className="mb-topbar-title">MindBlown</div>
          <button
            className="mb-topbar-btn"
            onClick={() => useMindmapStore.getState().logout()}
          >
            Sign out
          </button>
        </div>
        <MobileMapList onPick={setSelectedMap} />
      </div>
    );
  }

  return (
    <div className="mb-mobile">
      <div className="mb-topbar">
        <button
          className="mb-topbar-btn"
          onClick={() => setSelectedMap(null)}
        >
          ← Maps
        </button>
        <div className="mb-topbar-title">{selectedMap.name}</div>
        <span style={{ width: 60 }} />
      </div>
      <MobileViewer map={selectedMap} />
    </div>
  );
}
