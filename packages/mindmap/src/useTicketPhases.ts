import { useEffect, useMemo, useState } from 'react';
import { estimateServerNow, ticketPhases, ticketPhaseText, type TicketPhase } from '@mindblown/core';
import * as api from './api.js';
import { useMindmapStore } from './store.js';

/** The worker pushes its rollup each poll; a minute keeps the card's phase and elapsed time current. */
const REFRESH_MS = 60_000;

export interface CardPhase {
  /** "Waiting for CI · 12m" */
  text: string;
  tone: TicketPhase['tone'];
  prNumber: number | null;
  /** An agent works it right now — the Stop button's cue (#549). */
  agentRunning: boolean;
}

/** Each fleet ticket's phase on the open map (#546), by node id; empty for a map with no fleet. */
export function useTicketPhases(): Map<string, CardPhase> {
  const mapId = useMindmapStore((s) => s.currentMapId);
  const fleetId = useMindmapStore((s) => s.currentMap?.fleetId ?? null);
  return useTicketPhasesFor(mapId, fleetId);
}

/** The same for a map given by id — mobile keeps its map outside the store. */
export function useTicketPhasesFor(mapId: string | null, fleetId: string | null): Map<string, CardPhase> {
  const [loaded, setLoaded] = useState<{ data: api.FleetResponse; fetchedAt: number } | null>(null);

  useEffect(() => {
    setLoaded(null);
    if (!mapId || !fleetId) return;
    let alive = true;
    const load = () =>
      api
        .fetchFleet({ mapId })
        .then((data) => alive && setLoaded({ data, fetchedAt: Date.now() }))
        .catch(() => {});
    void load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [mapId, fleetId]);

  return useMemo(() => {
    const out = new Map<string, CardPhase>();
    if (!loaded) return out;
    // Judged against the server's clock, like the Fleet tab.
    const now = estimateServerNow(loaded.data.now, loaded.fetchedAt, Date.now());
    for (const [nodeId, p] of ticketPhases(loaded.data.hosts, now)) {
      out.set(nodeId, { text: ticketPhaseText(p, now), tone: p.tone, prNumber: p.prNumber, agentRunning: p.agentRunning });
    }
    return out;
  }, [loaded]);
}
