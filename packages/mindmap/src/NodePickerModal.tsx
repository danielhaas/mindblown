/**
 * Node picker modal (#94 — Phase 1 frontend).
 *
 * Renders the current map as a collapsible tree with a search box so
 * an operator can pick a parent node for a triage Override / Move.
 *
 * Reused by TriagePanel; designed to be cheap to drop in elsewhere
 * (Phase 2 bulk-action review will reuse this).
 *
 * The tree is built off `useMindmapStore` state (already in memory)
 * rather than a separate `/api/maps/:id` round-trip — same nodes
 * the mindmap is already rendering.
 */

import { useCallback, useMemo, useState } from 'react';
import type { Node } from '@mindblown/core';
import { useMindmapStore } from './store.js';

interface TreeRow {
  node: Node;
  depth: number;
  matches: boolean;
  visible: boolean;
  hasChildren: boolean;
  expanded: boolean;
}

export function NodePickerModal({
  mapId: _mapId,
  title,
  excludeNodeIds = [],
  onPick,
  onClose,
}: {
  mapId: string;
  title: string;
  excludeNodeIds?: string[];
  onPick: (nodeId: string) => void;
  onClose: () => void;
}) {
  const nodes = useMindmapStore((s) => s.nodes);
  const rootNodeId = useMindmapStore((s) => s.rootNodeId);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    // Expand the root + its direct children by default — that's the
    // "epic shelf" most overrides target.
    const initial = new Set<string>();
    if (rootNodeId) {
      initial.add(rootNodeId);
      const root = nodes[rootNodeId];
      if (root) {
        for (const childId of root.childrenIds) initial.add(childId);
      }
    }
    return initial;
  });
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const excludeSet = useMemo(() => new Set(excludeNodeIds), [excludeNodeIds]);

  const rows = useMemo(() => {
    if (!rootNodeId) return [] as TreeRow[];
    const term = search.trim().toLowerCase();
    const out: TreeRow[] = [];

    // First pass: which nodeIds match the search term (case-insensitive
    // substring on text). Empty term = everything matches.
    const matchSet = new Set<string>();
    if (term === '') {
      for (const id of Object.keys(nodes)) matchSet.add(id);
    } else {
      for (const id of Object.keys(nodes)) {
        const n = nodes[id];
        if (n && n.text.toLowerCase().includes(term)) matchSet.add(id);
      }
    }

    // Second pass: walk the tree depth-first, only descending past a
    // node when (a) it or one of its descendants matched. Build a row
    // per visited node. When searching, auto-expand any ancestor of a
    // match so the matching row is visible. We do this by collecting
    // the ancestor chain of each matching node up-front.
    const forceExpand = new Set<string>();
    if (term !== '') {
      const parentOf: Record<string, string | null> = {};
      for (const id of Object.keys(nodes)) {
        parentOf[id] = nodes[id]?.parentId ?? null;
      }
      for (const matchId of matchSet) {
        let cur: string | null = parentOf[matchId] ?? null;
        while (cur && !forceExpand.has(cur)) {
          forceExpand.add(cur);
          cur = parentOf[cur] ?? null;
        }
      }
    }

    const containsMatch = (nodeId: string, memo: Map<string, boolean>): boolean => {
      const cached = memo.get(nodeId);
      if (cached !== undefined) return cached;
      const n = nodes[nodeId];
      if (!n) {
        memo.set(nodeId, false);
        return false;
      }
      if (matchSet.has(nodeId)) {
        memo.set(nodeId, true);
        return true;
      }
      for (const childId of n.childrenIds) {
        if (containsMatch(childId, memo)) {
          memo.set(nodeId, true);
          return true;
        }
      }
      memo.set(nodeId, false);
      return false;
    };
    const matchMemo = new Map<string, boolean>();

    const walk = (nodeId: string, depth: number): void => {
      const node = nodes[nodeId];
      if (!node) return;
      const hasChildren = node.childrenIds.length > 0;
      // Visibility: when searching, only show nodes that match OR
      // ancestors of a match. When not searching, show everything.
      const visible = term === '' || matchSet.has(nodeId) || containsMatch(nodeId, matchMemo);
      const isExpanded = expanded.has(nodeId) || forceExpand.has(nodeId);
      if (visible) {
        out.push({
          node,
          depth,
          matches: matchSet.has(nodeId),
          visible,
          hasChildren,
          expanded: isExpanded,
        });
      }
      if (isExpanded && hasChildren) {
        for (const childId of node.childrenIds) walk(childId, depth + 1);
      }
    };

    walk(rootNodeId, 0);
    return out;
  }, [nodes, rootNodeId, search, expanded]);

  const toggleExpand = useCallback((nodeId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }, []);

  const handlePick = useCallback(() => {
    if (selectedNodeId) onPick(selectedNodeId);
  }, [selectedNodeId, onPick]);

  return (
    <div
      data-testid="node-picker-modal"
      role="dialog"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15, 23, 42, 0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: 520,
          maxHeight: '80vh',
          background: '#fff',
          borderRadius: 8,
          boxShadow: '0 10px 40px rgba(0, 0, 0, 0.2)',
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
          <span style={{ fontSize: 14, fontWeight: 700, color: '#1e293b', flex: 1 }}>
            {title}
          </span>
          <button
            data-testid="node-picker-close"
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

        {/* Search */}
        <div style={{ padding: '8px 16px', borderBottom: '1px solid #f1f5f9' }}>
          <input
            data-testid="node-picker-search"
            type="text"
            placeholder="Search nodes…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
            style={{
              width: '100%',
              padding: '6px 10px',
              border: '1px solid #e2e8f0',
              borderRadius: 4,
              fontSize: 13,
              fontFamily: 'inherit',
              outline: 'none',
            }}
          />
        </div>

        {/* Tree */}
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 200 }} data-testid="node-picker-tree">
          {rows.length === 0 ? (
            <div style={{ padding: 20, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>
              No matching nodes.
            </div>
          ) : (
            rows.map((row) => {
              const isExcluded = excludeSet.has(row.node.id);
              const isSelected = selectedNodeId === row.node.id;
              return (
                <div
                  key={row.node.id}
                  data-testid="node-picker-row"
                  data-node-id={row.node.id}
                  onClick={() => {
                    if (!isExcluded) setSelectedNodeId(row.node.id);
                  }}
                  onDoubleClick={() => {
                    if (!isExcluded) {
                      setSelectedNodeId(row.node.id);
                      onPick(row.node.id);
                    }
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '4px 8px',
                    paddingLeft: 8 + row.depth * 16,
                    borderBottom: '1px solid #f8fafc',
                    background: isSelected ? '#eff6ff' : 'transparent',
                    cursor: isExcluded ? 'not-allowed' : 'pointer',
                    opacity: isExcluded ? 0.4 : 1,
                    fontSize: 12,
                  }}
                >
                  <button
                    data-testid="node-picker-expand"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (row.hasChildren) toggleExpand(row.node.id);
                    }}
                    style={{
                      width: 16,
                      height: 16,
                      border: 'none',
                      background: 'none',
                      cursor: row.hasChildren ? 'pointer' : 'default',
                      padding: 0,
                      color: row.hasChildren ? '#64748b' : 'transparent',
                      fontSize: 10,
                      fontFamily: 'inherit',
                    }}
                  >
                    {row.hasChildren ? (row.expanded ? '▾' : '▸') : '·'}
                  </button>
                  <span
                    style={{
                      flex: 1,
                      color: row.matches ? '#1e293b' : '#475569',
                      fontWeight: row.matches && search ? 600 : 400,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {row.node.text}
                  </span>
                  {isExcluded && (
                    <span style={{ fontSize: 10, color: '#94a3b8' }}>(current)</span>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '10px 16px',
            borderTop: '1px solid #e2e8f0',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: '#f8fafc',
          }}
        >
          <span style={{ flex: 1, fontSize: 11, color: '#64748b' }}>
            Double-click a node, or select and Pick.
          </span>
          <button
            onClick={onClose}
            style={{
              padding: '5px 12px',
              borderRadius: 4,
              border: '1px solid #e2e8f0',
              background: '#fff',
              color: '#475569',
              cursor: 'pointer',
              fontSize: 12,
              fontFamily: 'inherit',
            }}
          >
            Cancel
          </button>
          <button
            data-testid="node-picker-pick"
            onClick={handlePick}
            disabled={!selectedNodeId}
            style={{
              padding: '5px 12px',
              borderRadius: 4,
              border: '1px solid #3b82f6',
              background: selectedNodeId ? '#3b82f6' : '#cbd5e1',
              color: '#fff',
              cursor: selectedNodeId ? 'pointer' : 'not-allowed',
              fontSize: 12,
              fontWeight: 600,
              fontFamily: 'inherit',
            }}
          >
            Pick
          </button>
        </div>
      </div>
    </div>
  );
}
