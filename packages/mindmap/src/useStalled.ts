import { useEffect, useMemo, useState } from 'react';
import type { StalledLeaf } from '@mindblown/core';
import * as api from './api.js';
import { useMindmapStore } from './store.js';
import { liveStalled } from './landing.js';

/** Work goes stale by the clock, not by a write — so the list is re-fetched while a view shows it. */
const REFRESH_MS = 2 * 60_000;

/** Stalled leaves of the open map, for the Blocked panel and the PM Cockpit. */
export function useStalled(): StalledLeaf[] {
  const mapId = useMindmapStore((s) => s.currentMapId);
  const nodes = useMindmapStore((s) => s.nodes);
  const workflow = useMindmapStore((s) => s.currentMap?.statusWorkflow);
  const [fetched, setFetched] = useState<StalledLeaf[]>([]);

  useEffect(() => {
    setFetched([]);
    if (!mapId) return;
    let alive = true;
    const load = () =>
      api
        .fetchStalled(mapId)
        .then((r) => alive && setFetched(r.stalled))
        .catch(() => {});
    void load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [mapId]);

  return useMemo(() => liveStalled(fetched, nodes, workflow ?? []), [fetched, nodes, workflow]);
}
