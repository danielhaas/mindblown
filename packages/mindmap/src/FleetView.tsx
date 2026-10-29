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
import { ApprovalsSection } from './ApprovalsView.js';
import { MapFleetPanel } from './MapFleetPanel.js';
import { FleetTelemetry } from './FleetTelemetry.js';
import { FleetScopeContext } from './fleetScope.js';
import { PairMachine } from './PairMachine.js';
import type { FleetScope } from './fleetScope.js';

/** Claims move without a telemetry push, and the fleet page has no socket room — poll. */
const ENTITY_POLL_MS = 60_000;

/**
 * The fleet as this reader sees it: refetched when telemetry moves and every
 * minute (claims change the count; a failed first load retries).
 */
function useFleetEntity(fleetId: string | null): {
  fleet: FleetWithMaps | null;
  error: string | null;
  renamed: (f: FleetWithMaps) => void;
} {
  const fleetRev = useMindmapStore((s) => s.fleetRev);
  const [fleet, setFleet] = useState<FleetWithMaps | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [poll, setPoll] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setPoll((n) => n + 1), ENTITY_POLL_MS);
    return () => clearInterval(t);
  }, []);
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
  }, [fleetId, fleetRev, poll]);
  // A rename keeps the count this read carried (the PATCH answer has none), and tells the other views.
  const renamed = (f: FleetWithMaps) => {
    setFleet((old) => ({ ...f, activeClaims: old?.activeClaims ?? f.activeClaims }));
    useMindmapStore.setState((s) => ({ fleetRev: s.fleetRev + 1 }));
  };
  return { fleet, error, renamed };
}

export function FleetView() {
  const currentMap = useMindmapStore((s) => s.currentMap);
  const viewRole = useMindmapStore((s) => s.viewRole);
  const fleetId = currentMap?.fleetId ?? null;
  const { fleet, renamed } = useFleetEntity(fleetId);
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
        {fleet && <FleetOverview fleet={fleet} mapId={currentMap.id} all={all} onAll={setAll} onRenamed={renamed} />}
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
            is read and decided, one after the other. Proposed tickets first:
            nothing else happens to them until someone says yes (#494). */}
        <div style={{ marginTop: 16 }}>
          <ApprovalsSection />
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
function FleetOverview({ fleet, mapId, all, onAll, onRenamed }: {
  fleet: FleetWithMaps;
  mapId: string | null;
  all: boolean;
  onAll?: (v: boolean) => void;
  onRenamed?: (f: FleetWithMaps) => void;
}) {
  const active = fleet.activeClaims ?? null;
  const cap = fleet.maxActiveClaims;
  const full = cap > 0 && active !== null && active >= cap;
  return (
    <section style={{ ...overviewBox, borderColor: full ? '#fed7aa' : '#e2e8f0' }} data-testid="fleet-overview">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <FleetName fleet={fleet} onRenamed={onRenamed} />
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
      <AutoCheckSwitch fleet={fleet} onChanged={onRenamed} />
    </section>
  );
}

/**
 * Auto-check: blocked tickets go to the fleet without the "Fleet can fix
 * it" click. The owner switches it; everyone else sees it only while on.
 */
function AutoCheckSwitch({ fleet, onChanged }: { fleet: FleetWithMaps; onChanged?: (f: FleetWithMaps) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const on = fleet.autoCheckBlockers;
  const hint = 'A ticket a fleet worker gave up on (timed out, failed, changed nothing) goes back to the fleet once after 30 minutes, as if you pressed Fleet can fix it. If it gives up again, it stays with you, until a ticket it waits for (#494) is done: then it gets one more try. Blockers you set, notes on a worker\'s PR and the agent\'s questions are never touched.';
  if (!fleet.isOwner || !onChanged) {
    return on ? <div style={{ fontSize: 12, color: '#4338ca', marginTop: 6 }} title={hint} data-testid="fleet-auto-check">Auto-check blockers: on</div> : null;
  }
  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      onChanged(await api.setFleetAutoCheck(fleet.id, !on));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Saving failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ fontSize: 12, color: '#334155', marginTop: 6, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: busy ? 'wait' : 'pointer' }} title={hint}>
        <input type="checkbox" checked={on} disabled={busy} onChange={toggle} data-testid="fleet-auto-check" />
        Auto-check blockers
      </label>
      <span style={{ color: '#64748b' }}>{on ? 'tickets the fleet gave up on get one more try after 30 min' : 'off — tickets the fleet gave up on wait for Fleet can fix it'}</span>
      {error && <span style={{ color: '#b91c1c' }}>{error}</span>}
    </div>
  );
}

/**
 * The fleet's name — and, for its owner, a rename in place (Enter saves,
 * Esc cancels). The server checks ownership again (PATCH /api/fleets/:id).
 */
function FleetName({ fleet, onRenamed }: { fleet: FleetWithMaps; onRenamed?: (f: FleetWithMaps) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = <strong style={{ fontSize: 14, color: '#1e293b' }} data-testid="fleet-name">{fleet.name}</strong>;
  if (!fleet.isOwner || !onRenamed) return name;
  if (draft === null) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6 }}>
        {name}
        <button style={linkBtn} onClick={() => { setDraft(fleet.name); setError(null); }} data-testid="fleet-rename">Rename</button>
      </span>
    );
  }
  const trimmed = draft.trim();
  const save = async () => {
    if (busy || !trimmed || trimmed === fleet.name) return setDraft(null);
    setBusy(true);
    setError(null);
    try {
      onRenamed(await api.renameFleet(fleet.id, trimmed));
      setDraft(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Renaming failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save();
          if (e.key === 'Escape') setDraft(null);
        }}
        maxLength={200}
        autoFocus
        disabled={busy}
        aria-label="Fleet name"
        style={{ fontSize: 13, padding: '2px 6px', border: '1px solid #cbd5e1', borderRadius: 6, fontFamily: 'inherit' }}
        data-testid="fleet-name-input"
      />
      <button style={{ ...seg, ...segOn, borderRadius: 6 }} disabled={busy || !trimmed} onClick={() => void save()} data-testid="fleet-name-save">
        {busy ? 'Saving…' : 'Save'}
      </button>
      <button style={linkBtn} onClick={() => setDraft(null)}>Cancel</button>
      {error && <span style={{ fontSize: 12, color: '#991b1b' }}>{error}</span>}
    </span>
  );
}

/**
 * The fleet page (`?fleet=<id>`, #480): the fleet without a map context —
 * its workers, the Questions and the journal of every project the reader
 * can view. The map knobs (cap, gate, policy) stay on each map's tab.
 */
export function FleetPage({ fleetId }: { fleetId: string }) {
  const { fleet, error, renamed } = useFleetEntity(fleetId);
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
        {error && <Muted>Fleet unavailable: {error}{fleet ? ' — showing the last good read' : ' — retrying every minute'}</Muted>}
        {!fleet && !error && <Muted>Loading…</Muted>}
        {fleet && (
          <>
            <FleetOverview fleet={fleet} mapId={null} all onRenamed={renamed} />
            {fleet.isOwner && <RepairMachine fleetId={fleet.id} />}
            <Card title="Workers">
              <FleetTelemetry />
            </Card>
            {fleet.isOwner && <RepoHandouts fleetId={fleet.id} />}
            <div style={{ marginTop: 16 }}>
              <ApprovalsSection />
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

/**
 * Pair a machine into this fleet (#506): another machine, or — with
 * "Reinstall" ticked — one whose key replaces every key the fleet has.
 */
function RepairMachine({ fleetId }: { fleetId: string }) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  return (
    <div style={{ marginBottom: 16, fontSize: 12 }}>
      {done ? (
        <span style={{ color: '#166534' }} data-testid="repair-done">Paired. The machine picks up its key within a few seconds.</span>
      ) : open ? (
        <PairMachine fleetId={fleetId} onPaired={() => setDone(true)} />
      ) : (
        <button style={linkBtn} onClick={() => setOpen(true)} data-testid="repair-open">Pair a machine with this fleet…</button>
      )}
    </div>
  );
}

/**
 * Repo access (#507): which projects' repo credentials this fleet fetched
 * in the last 7 days — one per ticket it worked. Owner only; never a token.
 */
function RepoHandouts({ fleetId }: { fleetId: string }) {
  const fleetRev = useMindmapStore((s) => s.fleetRev);
  const [rows, setRows] = useState<api.RepoHandout[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .listRepoHandouts(fleetId)
      .then((r) => !cancelled && (setRows(r.handouts), setError(null)))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : 'unavailable'));
    return () => {
      cancelled = true;
    };
  }, [fleetId, fleetRev]);
  return (
    <div style={{ marginTop: 16 }} data-testid="repo-handouts">
      <Card title="Repo access — last 7 days">
        {error && <Muted>Unavailable: {error}</Muted>}
        {rows && rows.length === 0 && <Muted>The fleet has fetched no repo credentials yet. It gets them per ticket, only for projects connected to it.</Muted>}
        {rows && rows.length > 0 && (
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.8 }}>
            {rows.map((r) => (
              <li key={`${r.mapId}|${r.repo}`}>
                <strong>{r.mapName}</strong> · <code>{r.repo}</code>
                <span style={{ color: '#64748b' }}> · {r.count}× · last {new Date(r.lastAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

const overviewBox: React.CSSProperties = { background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, padding: '12px 16px', marginBottom: 16 };
const seg: React.CSSProperties = { fontSize: 12, padding: '3px 12px', border: 'none', background: '#fff', color: '#334155', cursor: 'pointer', fontFamily: 'inherit' };
const segOn: React.CSSProperties = { background: '#4f46e5', color: '#fff' };
const linkBtn: React.CSSProperties = { background: 'none', border: 'none', padding: 0, fontSize: 12, color: '#4f46e5', cursor: 'pointer', fontFamily: 'inherit' };
