import { useMemo } from 'react';
import type { Node, ComputedNodeValues } from '@mindblown/core';
import { useMindmapStore } from './store.js';

const PANEL_WIDTH = 380;

interface BlockedLeaf {
  node: Node;
  cv: ComputedNodeValues;
  predecessorTitles: string[];
}

export function BlockedPanel({ onClose }: { onClose: () => void }) {
  const nodes = useMindmapStore((s) => s.nodes);
  const computed = useMindmapStore((s) => s.computed);
  const selectNode = useMindmapStore((s) => s.selectNode);
  const setFocusNode = useMindmapStore((s) => s.setFocusNode);

  const { manual, depWaiting } = useMemo(() => {
    const manual: BlockedLeaf[] = [];
    const depWaiting: BlockedLeaf[] = [];
    for (const node of Object.values(nodes)) {
      if (node.childrenIds.length > 0) continue;
      const cv = computed.get(node.id);
      if (!cv || !cv.isBlocked) continue;
      const predecessorTitles = (cv.blockedBy?.predecessorIds ?? []).map(
        (pid) => nodes[pid]?.text ?? pid,
      );
      const entry: BlockedLeaf = { node, cv, predecessorTitles };
      if (cv.blockedBy?.manual) manual.push(entry);
      else if (predecessorTitles.length > 0) depWaiting.push(entry);
    }
    return { manual, depWaiting };
  }, [nodes, computed]);

  const total = manual.length + depWaiting.length;

  const jumpTo = (nodeId: string) => {
    selectNode(nodeId);
    setFocusNode(nodeId);
  };

  return (
    <div
      style={{
        width: PANEL_WIDTH,
        // Das Property-Panel steht seit App.tsx:2184 daneben statt in derselben
        // else-Kette, also können zwei Panels nebeneinander liegen. Ohne dies
        // schrumpfen beide, sobald der Platz knapp wird.
        flexShrink: 0,
        height: '100%',
        borderLeft: '1px solid #e2e8f0',
        background: '#ffffff',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '12px 16px',
          borderBottom: '1px solid #e2e8f0',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span style={{ fontSize: 16 }}>🔒</span>
        <span style={{ fontSize: 14, fontWeight: 700, color: '#1e293b', flex: 1 }}>
          Blocked
          {total > 0 && (
            <span style={{ marginLeft: 8, fontSize: 12, color: '#94a3b8', fontWeight: 500 }}>
              {total} item{total === 1 ? '' : 's'}
            </span>
          )}
        </span>
        <button
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: '4px',
            color: '#94a3b8',
            fontSize: 16,
            fontFamily: 'inherit',
            lineHeight: 1,
          }}
          title="Close"
        >
          x
        </button>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {total === 0 ? (
          <div style={{ padding: 20, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>
            Nothing blocked. 🎉
          </div>
        ) : (
          <>
            <BlockedSection
              title="Manually blocked"
              count={manual.length}
              entries={manual}
              jumpTo={jumpTo}
              renderDetail={(e) => (
                <span style={{ color: '#991b1b' }}>"{e.node.blockedReason ?? ''}"</span>
              )}
            />
            <BlockedSection
              title="Waiting on dependencies"
              count={depWaiting.length}
              entries={depWaiting}
              jumpTo={jumpTo}
              renderDetail={(e) => (
                <span style={{ color: '#475569' }}>
                  Blocked by: {e.predecessorTitles.map((t) => `"${t}"`).join(', ')}
                </span>
              )}
            />
          </>
        )}
      </div>

      {/* Footer hint */}
      <div
        style={{
          padding: '10px 16px',
          borderTop: '1px solid #f1f5f9',
          fontSize: 10,
          color: '#94a3b8',
          background: '#f8fafc',
        }}
      >
        "Manually blocked" reads <code>blockedReason</code>; "Waiting on dependencies"
        is derived from Finish-to-Start dependencies whose target is &lt; 100%.
      </div>
    </div>
  );
}

function BlockedSection({
  title,
  count,
  entries,
  jumpTo,
  renderDetail,
}: {
  title: string;
  count: number;
  entries: BlockedLeaf[];
  jumpTo: (nodeId: string) => void;
  renderDetail: (entry: BlockedLeaf) => React.ReactNode;
}) {
  if (count === 0) return null;
  return (
    <div>
      <div
        style={{
          padding: '8px 16px',
          fontSize: 11,
          fontWeight: 700,
          color: '#64748b',
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          background: '#f8fafc',
          borderBottom: '1px solid #f1f5f9',
        }}
      >
        {title} ({count})
      </div>
      {entries.map((entry) => (
        <div
          key={entry.node.id}
          onClick={() => jumpTo(entry.node.id)}
          style={{
            padding: '10px 16px',
            borderBottom: '1px solid #f1f5f9',
            cursor: 'pointer',
            fontSize: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            transition: 'background 0.1s',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = '#f8fafc')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontWeight: 600, color: '#1e293b', flex: 1 }}>
              {entry.node.text}
            </span>
            {entry.node.priority && (
              <span style={{ fontSize: 10, fontWeight: 600, color: '#64748b' }}>
                {entry.node.priority}
              </span>
            )}
            {entry.node.dueDate && (
              <span style={{ fontSize: 10, color: '#94a3b8' }}>due {entry.node.dueDate}</span>
            )}
          </div>
          <div style={{ fontSize: 11 }}>{renderDetail(entry)}</div>
          {entry.node.assigneeIds.length > 0 && (
            <div style={{ fontSize: 10, color: '#64748b' }}>
              Assignees: {entry.node.assigneeIds.join(', ')}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
