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
 */
import { useMindmapStore } from './store.js';
import { Shell, Muted } from './DigestView.js';
import { LeidangCards } from './DispatchCards.js';

export function FleetView() {
  const currentMap = useMindmapStore((s) => s.currentMap);
  const viewRole = useMindmapStore((s) => s.viewRole);

  if (!currentMap) return <Shell><Muted>Loading…</Muted></Shell>;
  if (!currentMap.statusWorkflow) {
    return (
      <Shell>
        <Muted>This map has no status workflow — there is no pull queue to dispatch or observe.</Muted>
      </Shell>
    );
  }

  return (
    <Shell>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
        {/* Only PM and All steer. Anyone else who lands here (developer
            tab, or a stakeholder following a shared ?view=fleet link)
            observes — the lens is a filter, so this is UX, not security. */}
        <LeidangCards readOnly={viewRole !== 'pm' && viewRole !== 'all'} />
      </div>
    </Shell>
  );
}
