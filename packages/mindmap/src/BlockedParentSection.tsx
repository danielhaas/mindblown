import { useMemo } from 'react';
import type { Node, NodeMap } from '@mindblown/core';
import { explainBlockedParent, outsideBranch } from '@mindblown/core';

/**
 * Why a parent shows blocked (#651): how many tasks below are blocked, the
 * root causes they trace back to, and every blocked task with what it waits
 * on. The rolled-up status is display only, so the panel says so.
 */
export function BlockedParentSection({
  parent,
  nodeMap,
  onSelect,
}: {
  parent: Node;
  nodeMap: NodeMap;
  onSelect: (id: string) => void;
}) {
  const why = useMemo(() => explainBlockedParent(parent, nodeMap), [parent, nodeMap]);
  const count = why.blockedLeafIds.length;
  if (count === 0) return null;

  const title = (id: string) => nodeMap.get(id)?.text ?? id;
  // "M2 › Pilot VM" when the task sits in another branch (e.g. milestone).
  const where = (id: string) => {
    const branch = outsideBranch(parent, id, nodeMap);
    return branch ? `${branch.text} › ${title(id)}` : title(id);
  };
  const link = (id: string, label = title(id)) => (
    <button
      type="button"
      onClick={() => onSelect(id)}
      style={linkStyle}
      title="Select this task"
    >
      {label}
    </button>
  );
  const tasks = (n: number) => `${n} task${n === 1 ? '' : 's'}`;

  return (
    <div data-testid="blocked-parent-section" style={boxStyle}>
      <div style={{ fontWeight: 600 }} data-testid="blocked-parent-count">
        {tasks(count)} blocked
      </div>
      <div style={{ color: '#7f1d1d', opacity: 0.8, marginTop: 2 }}>
        Shown because tasks below are blocked. This doesn't hold the fleet; add a blocker
        reason here to hold the whole subtree.
      </div>
      <ul style={{ margin: '6px 0 0', paddingLeft: 16 }} data-testid="blocked-parent-causes">
        {why.rootCauses.map((c) => (
          <li key={`${c.kind}:${c.nodeId}`} style={{ marginBottom: 3 }}>
            {c.kind === 'predecessor' ? (
              <>
                {tasks(c.waitingIds.length)} waiting on '{link(c.nodeId, where(c.nodeId))}'
              </>
            ) : (
              <>
                '{link(c.nodeId)}': <span title={c.reason ?? ''}>{clip(c.reason ?? '')}</span>
                {c.waitingIds.length > 1 && <> — {tasks(c.waitingIds.length)} waiting</>}
              </>
            )}
          </li>
        ))}
      </ul>
      <details style={{ marginTop: 4 }}>
        <summary style={{ cursor: 'pointer' }}>All blocked tasks ({count})</summary>
        <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
          {why.blockedLeafIds.map((id) => {
            const n = nodeMap.get(id);
            const preds = why.predecessorIds[id] ?? [];
            return (
              <li key={id} style={{ marginBottom: 3 }}>
                {link(id)}
                {n?.blockedReason && <div title={n.blockedReason}>Blocked: {clip(n.blockedReason)}</div>}
                {preds.length > 0 && (
                  <div>Waiting on: {preds.map((p) => `"${where(p)}"`).join(', ')}</div>
                )}
              </li>
            );
          })}
        </ul>
      </details>
    </div>
  );
}

// Fleet blockers run to a paragraph; the full text is in the tooltip.
const clip = (s: string) => (s.length > 160 ? `${s.slice(0, 157)}…` : s);

const boxStyle: React.CSSProperties = {
  marginTop: 6,
  padding: '6px 8px',
  background: '#fef2f2',
  border: '1px solid #fecaca',
  borderRadius: 6,
  fontSize: 11,
  color: '#991b1b',
};

const linkStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  font: 'inherit',
  color: '#991b1b',
  textDecoration: 'underline',
  cursor: 'pointer',
  textAlign: 'left',
};
