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
 */
import { useMindmapStore } from './store.js';
import { Shell, Muted } from './DigestView.js';
import { LeidangCards } from './DispatchCards.js';
import { FleetJournalSection } from './FleetJournal.js';
import { AsksSection } from './AsksView.js';

export function FleetView() {
  const currentMap = useMindmapStore((s) => s.currentMap);
  const viewRole = useMindmapStore((s) => s.viewRole);

  if (!currentMap) return <Shell><Muted>Loading…</Muted></Shell>;

  return (
    <Shell>
      {/* The pull queue needs a status workflow; Questions do not (the push
          route never checks it), so only the cards sit behind the gate. */}
      {currentMap.statusWorkflow ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
          {/* Only PM and All steer. Anyone else who lands here (developer
              tab, or a stakeholder following a shared ?view=fleet link)
              observes — the lens is a filter, so this is UX, not security. */}
          <LeidangCards readOnly={viewRole !== 'pm' && viewRole !== 'all'} />
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
  );
}
