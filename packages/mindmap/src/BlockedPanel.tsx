import { useMemo, useState } from 'react';
import type { Node, ComputedNodeValues } from '@mindblown/core';
import { groupBlockers } from '@mindblown/core';
import { useMindmapStore } from './store.js';
import { dependencyNeighbourhood } from './blockedNeighbourhood.js';

type PanelMode = 'cause' | 'kind' | 'around';

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
  const selectedNodeId = useMindmapStore((s) => s.selectedNodeId);
  const [mode, setMode] = useState<PanelMode>('cause');

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

  // By cause and unblocker (#322) — the PM Cockpit's grouping (core
  // groupBlockers): one action for one person, not N free-text reasons.
  const byCause = useMemo(() => {
    const entryById = new Map([...manual, ...depWaiting].map((e) => [e.node.id, e]));
    const open = [...entryById.values()].filter((e) => e.cv.computedProgress < 100);
    return groupBlockers(
      open.map((e) => ({ id: e.node.id, blockedReason: e.node.blockedReason ?? null, predecessorIds: e.cv.blockedBy?.predecessorIds ?? [] })),
    ).map((g) => ({ ...g, entries: g.nodeIds.map((id) => entryById.get(id)!) }));
  }, [manual, depWaiting]);

  const around = useMemo(
    () => (mode === 'around' && selectedNodeId && nodes[selectedNodeId] ? dependencyNeighbourhood(nodes, computed, selectedNodeId) : null),
    [mode, selectedNodeId, nodes, computed],
  );

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

      {/* Mode tabs */}
      <div style={{ display: 'flex', gap: 4, padding: '8px 16px', borderBottom: '1px solid #f1f5f9' }}>
        {(
          [
            ['cause', 'By cause'],
            ['kind', 'By kind'],
            ['around', 'Around selected'],
          ] as Array<[PanelMode, string]>
        ).map(([m, label]) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            style={{
              fontSize: 11,
              fontWeight: 600,
              padding: '3px 10px',
              borderRadius: 4,
              border: 'none',
              cursor: 'pointer',
              background: mode === m ? '#4f46e5' : '#f1f5f9',
              color: mode === m ? '#ffffff' : '#475569',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {mode === 'around' ? (
          !around ? (
            <div style={{ padding: 20, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>
              Select a node on the map to see what it waits on and what waits on it.
            </div>
          ) : (
            <>
              <div style={{ padding: '10px 16px', fontSize: 12, color: '#334155', borderBottom: '1px solid #f1f5f9' }}>
                Around <strong>{nodes[selectedNodeId!]?.text}</strong>
              </div>
              <NodeList
                title="It waits on (unfinished)"
                empty="Nothing — no unfinished predecessor."
                nodes={around.upstream}
                computed={computed}
                jumpTo={jumpTo}
              />
              <NodeList
                title="Waiting on it"
                empty="Nothing depends on it."
                nodes={around.downstream}
                computed={computed}
                jumpTo={jumpTo}
              />
            </>
          )
        ) : total === 0 ? (
          <div style={{ padding: 20, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>
            Nothing blocked. 🎉
          </div>
        ) : mode === 'cause' ? (
          <>
            {byCause.map((g) => (
              <BlockedSection
                key={`${g.kind}:${g.label}`}
                title={g.label}
                count={g.entries.length}
                entries={g.entries}
                jumpTo={jumpTo}
                renderDetail={(e) =>
                  e.node.blockedReason ? (
                    <span style={{ color: '#991b1b' }}>"{e.node.blockedReason}"</span>
                  ) : (
                    <span style={{ color: '#475569' }}>
                      Blocked by: {e.predecessorTitles.map((t) => `"${t}"`).join(', ')}
                    </span>
                  )
                }
              />
            ))}
          </>
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

function NodeList({
  title,
  empty,
  nodes,
  computed,
  jumpTo,
}: {
  title: string;
  empty: string;
  nodes: Node[];
  computed: Map<string, ComputedNodeValues>;
  jumpTo: (nodeId: string) => void;
}) {
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
        {title} ({nodes.length})
      </div>
      {nodes.length === 0 && <div style={{ padding: '10px 16px', fontSize: 12, color: '#94a3b8' }}>{empty}</div>}
      {nodes.map((n) => {
        const cv = computed.get(n.id);
        const pct = Math.round(cv?.computedProgress ?? n.percentComplete ?? 0);
        return (
          <div
            key={n.id}
            onClick={() => jumpTo(n.id)}
            style={{ padding: '8px 16px', borderBottom: '1px solid #f1f5f9', cursor: 'pointer', fontSize: 12, display: 'flex', gap: 8 }}
            onMouseEnter={(e) => (e.currentTarget.style.background = '#f8fafc')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <span style={{ flex: 1, fontWeight: 600, color: '#1e293b' }}>{n.text}</span>
            {cv?.isBlocked && <span style={{ fontSize: 10, fontWeight: 700, color: '#475569' }}>BLOCKED</span>}
            <span style={{ fontSize: 11, color: '#94a3b8' }}>{pct}%</span>
          </div>
        );
      })}
    </div>
  );
}
