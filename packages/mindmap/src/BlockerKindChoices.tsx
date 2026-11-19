/**
 * The Block choices: what a blocker is, so it reaches a person or resolves
 * itself (flag_blocker's kind). Shown under the blocker text while it has
 * no kind; a blocker left without one is classified after an hour.
 *
 *   Question          → an ask on the Questions card (answerer: map owner)
 *   A person's step   → needs-human, the text becomes the next step
 *   External          → kept, the owner is asked again in 7 days
 *   Waits on a ticket → a dependency on the picked ticket, no blocker
 *
 * With a kind it says where the blocker went instead.
 */
import { useMemo, useState, type CSSProperties } from 'react';
import type { Node } from '@mindblown/core';
import { useMindmapStore } from './store.js';

const rowStyle: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6, alignItems: 'center' };
const chipStyle: CSSProperties = {
  fontSize: 11,
  padding: '2px 8px',
  borderRadius: 10,
  border: '1px solid #cbd5e1',
  background: '#fff',
  color: '#334155',
  cursor: 'pointer',
};
const noteStyle: CSSProperties = { marginTop: 6, fontSize: 11, color: '#64748b' };

/** Where a kinded blocker went, in one line. */
export function blockerKindNote(node: Pick<Node, 'blockedReason' | 'blockerInfo'>): string | null {
  const info = node.blockerInfo;
  if (!info || !(node.blockedReason ?? '').trim()) return null;
  if (info.kind === 'question') return `A question for ${info.answerer || 'the map owner'} — on the Questions card${info.auto ? ' (classified automatically)' : ''}.`;
  const date = (info.recheckAt ?? '').slice(0, 10);
  return `Waiting on a party outside — asked again${date ? ` on ${date}` : ''}.`;
}

export function BlockerKindChoices({
  node,
  reason,
  onBeforeFlag,
}: {
  node: Node;
  /** The blocker text as typed (may be ahead of the saved one). */
  reason: string;
  /** Called before the write — the panel cancels its pending debounced reason save. */
  onBeforeFlag?: () => void;
}) {
  const flagBlocker = useMindmapStore((s) => s.flagBlocker);
  const allNodes = useMindmapStore((s) => s.nodes);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const text = reason.trim();

  const candidates = useMemo(
    () =>
      picking
        ? Object.values(allNodes)
            .filter((n) => n.id !== node.id && n.parentId !== null && (n.percentComplete ?? 0) < 100 && !node.dependencies.some((d) => d.targetNodeId === n.id))
            .sort((a, b) => a.text.localeCompare(b.text))
        : [],
    [picking, allNodes, node.id, node.dependencies],
  );

  const note = blockerKindNote(node);
  if (note && text === (node.blockedReason ?? '').trim()) {
    return (
      <div data-testid="blocker-kind-note" style={noteStyle}>
        {note}
      </div>
    );
  }
  if (!text) return null;

  const flag = async (body: Parameters<typeof flagBlocker>[1]) => {
    onBeforeFlag?.();
    setBusy(true);
    await flagBlocker(node.id, body);
    setBusy(false);
    setPicking(false);
  };

  return (
    <div data-testid="blocker-kind-choices">
      <div style={rowStyle}>
        <span style={{ fontSize: 11, color: '#64748b' }}>What is it?</span>
        <button
          type="button"
          data-testid="blocker-kind-question"
          style={chipStyle}
          disabled={busy}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void flag({ kind: 'question', reason: text })}
          title="A decision someone has to make: asked on the Questions card (the map owner answers by default); the answer clears the blocker."
        >
          Question
        </button>
        <button
          type="button"
          data-testid="blocker-kind-person-step"
          style={chipStyle}
          disabled={busy}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void flag({ kind: 'person-step', reason: text })}
          title={'Something a person has to do: tagged needs-human, the text becomes "Next step (a person)" on Your steps. No blocker.'}
        >
          A person's step
        </button>
        <button
          type="button"
          data-testid="blocker-kind-external"
          style={chipStyle}
          disabled={busy}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void flag({ kind: 'external', reason: text })}
          title="Waiting on a party outside (vendor, client): the blocker stays and the owner is asked again in 7 days."
        >
          External
        </button>
        <button
          type="button"
          data-testid="blocker-kind-waits-on"
          style={chipStyle}
          disabled={busy}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setPicking((p) => !p)}
          title="Waiting on another ticket: a dependency on it, no blocker — it clears itself when that ticket is done."
        >
          Waits on a ticket…
        </button>
      </div>
      {picking && (
        <select
          data-testid="blocker-kind-waits-on-target"
          defaultValue=""
          disabled={busy}
          onKeyDown={(e) => e.stopPropagation()}
          onChange={(e) => {
            if (e.target.value) void flag({ kind: 'waits-on', reason: text, waitsOn: e.target.value });
          }}
          style={{ marginTop: 6, width: '100%', fontSize: 12 }}
        >
          <option value="">Pick the ticket it waits on…</option>
          {candidates.map((n) => (
            <option key={n.id} value={n.id}>
              {n.text}
            </option>
          ))}
        </select>
      )}
      <div style={noteStyle}>Left without a choice, it is sorted in an hour: a wait on a ticket it names, else a question to the map owner.</div>
    </div>
  );
}
