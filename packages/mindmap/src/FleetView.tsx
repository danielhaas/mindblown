/**
 * Fleet tab — the Leidang operator surface (Dispatch + Fleet cards),
 * promoted out of the Today cockpit into its own view: the cards were the
 * last grid items on a PM page and nobody found them there. Today keeps the
 * Monday questions (Slipped / Blocked / Sprint / Escalate); steering and
 * telemetry live here.
 *
 * In the Developer lens the tab is observability only: the same cards, but
 * the knobs render read-only (LeidangCards readOnly) — a developer checks
 * whether the queue is alive, the PM/operator steers it.
 *
 * Questions (the fleet's open human questions, `/leidang-asks` in the
 * browser) sit here too, between the live cards and the journal: they come
 * from the fleet and the answers go back to it, so they belong on the
 * fleet's page rather than in a tab of their own (it had one until
 * 2026-09-26). PM and developer answer; the stakeholder lens reads.
 *
 * A map with a fleet (#480): the tab shows the fleet — its cap against the
 * claims held across all its maps, each map's share — and the workers,
 * Questions and journal read "this project" by default or "all projects"
 * on the switch. The fleet page (`?fleet=<id>`, FleetPage below) is the
 * same without a map: always all projects, no map knobs.
 */
import { useEffect, useMemo, useState } from 'react';
import type { FleetWithMaps } from '@mindblown/core';
import { useMindmapStore } from './store.js';
import * as api from './api.js';
import { Card, Shell, Muted } from './DigestView.js';
import { LeidangCards } from './DispatchCards.js';
import { FleetJournalSection } from './FleetJournal.js';
import { AsksSection } from './AsksView.js';
import { MapFleetPanel } from './MapFleetPanel.js';
import { FleetTelemetry } from './FleetTelemetry.js';
import { FleetScopeContext } from './fleetScope.js';
import type { FleetScope } from './fleetScope.js';

/** The fleet as this reader sees it, refetched when telemetry moves (claims change the count). */
function useFleetEntity(fleetId: string | null): { fleet: FleetWithMaps | null; error: string | null } {
  const fleetRev = useMindmapStore((s) => s.fleetRev);
  const [fleet, setFleet] = useState<FleetWithMaps | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!fleetId) {
      setFleet(null);
      return;
    }
    let cancelled = false;
    api
      .fetchFleetEntity(fleetId)
      .then((f) => {
        if (cancelled) return;
        setFleet(f);
        setError(null);
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : 'unavailable'));
    return () => {
      cancelled = true;
    };
  }, [fleetId, fleetRev]);
  return { fleet, error };
}

export function FleetView() {
  const currentMap = useMindmapStore((s) => s.currentMap);
  const viewRole = useMindmapStore((s) => s.viewRole);
  const fleetId = currentMap?.fleetId ?? null;
  const { fleet } = useFleetEntity(fleetId);
  const [all, setAll] = useState(false);
  // A map that leaves its fleet drops back to its own view.
  useEffect(() => {
    if (!fleetId) setAll(false);
  }, [fleetId]);
  const scope = useMemo<FleetScope | null>(
    () => (currentMap ? { mapId: currentMap.id, fleetId, all: all && !!fleetId, mapNames: new Map((fleet?.maps ?? []).map((m) => [m.id, m.name])) } : null),
    [currentMap, fleetId, all, fleet],
  );

  if (!currentMap) return <Shell><Muted>Loading…</Muted></Shell>;
  const readOnly = viewRole !== 'pm' && viewRole !== 'all';

  return (
    <FleetScopeContext.Provider value={scope}>
      <Shell>
        {/* Which fleet works this map (#480) — and, without one, the way to
            connect it, before any card explains an empty rollup. */}
        <MapFleetPanel variant="tab" readOnly={readOnly} />
        {fleet && <FleetOverview fleet={fleet} mapId={currentMap.id} all={all} onAll={setAll} />}
        {/* The pull queue needs a status workflow; Questions do not (the push
            route never checks it), so only the cards sit behind the gate. */}
        {currentMap.statusWorkflow ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
            {/* Only PM and All steer. Anyone else who lands here (developer
                tab, or a stakeholder following a shared ?view=fleet link)
                observes — the lens is a filter, so this is UX, not security. */}
            <LeidangCards readOnly={readOnly} />
          </div>
        ) : (
          <Muted>This map has no status workflow — there is no pull queue to dispatch or observe.</Muted>
        )}
        {/* What the fleet is waiting on a person for. Full width: every card
            is read and decided, one after the other. */}
        <div style={{ marginTop: 16 }}>
          <AsksSection />
        </div>
        {/* The journal is a report over a window, full width under the live
            cards: "what did the fleet do last night?" is read top to bottom,
            not glanced at like the cap or the worker states. */}
        <div style={{ marginTop: 16 }}>
          <FleetJournalSection />
        </div>
      </Shell>
    </FleetScopeContext.Provider>
  );
}

/**
 * The fleet in one row: its cap against the claims held across all its
 * maps, each map's share, the "this project / all projects" switch and the
 * way to the fleet page. On the fleet page itself (`mapId` null) the
 * switch is gone — it is always all projects.
 */
function FleetOverview({ fleet, mapId, all, onAll }: { fleet: FleetWithMaps; mapId: string | null; all: boolean; onAll?: (v: boolean) => void }) {
  const active = fleet.activeClaims ?? null;
  const cap = fleet.maxActiveClaims;
  const full = cap > 0 && active !== null && active >= cap;
  return (
    <section style={{ ...overviewBox, borderColor: full ? '#fed7aa' : '#e2e8f0' }} data-testid="fleet-overview">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 14, color: '#1e293b' }}>{fleet.name}</strong>
        <span style={{ fontSize: 13, color: full ? '#9a3412' : '#334155' }} data-testid="fleet-cap">
          <strong>{active ?? '?'}</strong> active {cap > 0 ? <>/ fleet cap <strong>{cap}</strong></> : <span style={{ color: '#64748b' }}>· no fleet-wide cap — each map&apos;s own cap limits it</span>}
        </span>
        <span style={{ flex: 1 }} />
        {mapId && onAll && (
          <span style={{ display: 'inline-flex', border: '1px solid #cbd5e1', borderRadius: 999, overflow: 'hidden' }} role="group" aria-label="Scope">
            <button style={{ ...seg, ...(all ? {} : segOn) }} onClick={() => onAll(false)} data-testid="scope-this">This project</button>
            <button style={{ ...seg, ...(all ? segOn : {}) }} onClick={() => onAll(true)} data-testid="scope-all">All projects</button>
          </span>
        )}
        {mapId && (
          <a href={`/?fleet=${encodeURIComponent(fleet.id)}`} style={{ fontSize: 12, color: '#4f46e5' }} data-testid="fleet-page-link">
            Fleet page →
          </a>
        )}
      </div>
      <div style={{ fontSize: 12, color: '#64748b', marginTop: 6 }} data-testid="fleet-shares">
        {fleet.maps.length > 1 || fleet.hiddenMapCount > 0 ? 'Shares: ' : 'Serves '}
        {fleet.maps.map((m, i) => (
          <span key={m.id}>
            {i > 0 && ' · '}
            <span style={m.id === mapId ? { fontWeight: 700, color: '#334155' } : undefined}>{m.name}</span>
            {(fleet.maps.length > 1 || fleet.hiddenMapCount > 0) && ` ${m.fleetShare}`}
            {m.maxActiveClaims === 0 && <span style={{ color: '#b45309' }}> (on hold)</span>}
            {m.archivedAt && <span style={{ color: '#b45309' }}> (archived)</span>}
          </span>
        ))}
        {fleet.hiddenMapCount > 0 && ` · +${fleet.hiddenMapCount} map${fleet.hiddenMapCount === 1 ? '' : 's'} you can't view`}
      </div>
    </section>
  );
}

/**
 * The fleet page (`?fleet=<id>`, #480): the fleet without a map context —
 * its workers, the Questions and the journal of every project the reader
 * can view. The map knobs (cap, gate, policy) stay on each map's tab.
 */
export function FleetPage({ fleetId }: { fleetId: string }) {
  const { fleet, error } = useFleetEntity(fleetId);
  const scope = useMemo<FleetScope>(
    () => ({ mapId: null, fleetId, all: true, mapNames: new Map((fleet?.maps ?? []).map((m) => [m.id, m.name])) }),
    [fleetId, fleet],
  );
  return (
    <FleetScopeContext.Provider value={scope}>
      <Shell>
        <div style={{ marginBottom: 12, fontSize: 12 }}>
          <a href="/" style={{ color: '#4f46e5' }}>← All maps</a>
        </div>
        {error && <Muted>Fleet unavailable: {error}</Muted>}
        {!fleet && !error && <Muted>Loading…</Muted>}
        {fleet && (
          <>
            <FleetOverview fleet={fleet} mapId={null} all />
            <Card title="Workers">
              <FleetTelemetry />
            </Card>
            <div style={{ marginTop: 16 }}>
              <AsksSection />
            </div>
            <div style={{ marginTop: 16 }}>
              <FleetJournalSection />
            </div>
          </>
        )}
      </Shell>
    </FleetScopeContext.Provider>
  );
}

const overviewBox: React.CSSProperties = { background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, padding: '12px 16px', marginBottom: 16 };
const seg: React.CSSProperties = { fontSize: 12, padding: '3px 12px', border: 'none', background: '#fff', color: '#334155', cursor: 'pointer', fontFamily: 'inherit' };
const segOn: React.CSSProperties = { background: '#4f46e5', color: '#fff' };
