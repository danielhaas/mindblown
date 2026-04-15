import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMindmapStore } from './store.js';
import type { ActiveView } from './store.js';
import type { LayoutType } from './layout.js';
import * as api from './api.js';

// ── Fuzzy match ──────────────────────────────────────────────

function fuzzyMatch(query: string, text: string): boolean {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (q.length === 0) return true;
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
}

// ── Command definition ──────────────────────────────────────

interface Command {
  id: string;
  label: string;
  shortcut?: string;
  section: string;
  action: () => void;
  /** Only show when a node is selected */
  requiresSelection?: boolean;
}

// ── Component ───────────────────────────────────────────────

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onFitToScreen: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
}

export function CommandPalette({ open, onClose, onFitToScreen, onZoomIn, onZoomOut }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const nodes = useMindmapStore((s) => s.nodes);
  const currentMapId = useMindmapStore((s) => s.currentMapId);
  const selectedNodeId = useMindmapStore((s) => s.selectedNodeId);

  // Semantic search enrichment: for queries ≥ 3 chars, fire a debounced
  // call to /api/ai/search and remember which node IDs should be promoted
  // to the top of the goto- list. Falls back to fuzzy-only if the AI layer
  // isn't available or the query is too short.
  const [semanticRank, setSemanticRank] = useState<Map<string, number>>(new Map());
  useEffect(() => {
    if (!currentMapId || query.trim().length < 3) {
      setSemanticRank((prev) => (prev.size === 0 ? prev : new Map()));
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        const res = await api.aiSearch(currentMapId, query, 8);
        if (cancelled) return;
        const ranked = new Map<string, number>();
        res.matches.forEach((m, i) => ranked.set(m.nodeId, i));
        setSemanticRank(ranked);
      } catch {
        // Silent — semantic search is best-effort enrichment
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query, currentMapId]);

  const addNode = useMindmapStore((s) => s.addNode);
  const deleteNode = useMindmapStore((s) => s.deleteNode);
  const updateNode = useMindmapStore((s) => s.updateNode);
  const toggleCollapse = useMindmapStore((s) => s.toggleCollapse);
  const expandAll = useMindmapStore((s) => s.expandAll);
  const collapseAll = useMindmapStore((s) => s.collapseAll);
  const selectNode = useMindmapStore((s) => s.selectNode);
  const setActiveView = useMindmapStore((s) => s.setActiveView);
  const setLayoutType = useMindmapStore((s) => s.setLayoutType);

  // Build commands list
  const commands = useMemo((): Command[] => {
    const cmds: Command[] = [];

    // Node operations
    cmds.push({
      id: 'create-child',
      label: 'Create child node',
      shortcut: 'Tab',
      section: 'Nodes',
      requiresSelection: true,
      action: () => { if (selectedNodeId) addNode(selectedNodeId); },
    });
    cmds.push({
      id: 'create-sibling',
      label: 'Create sibling node',
      shortcut: 'Enter',
      section: 'Nodes',
      requiresSelection: true,
      action: () => { if (selectedNodeId) addNode(selectedNodeId, 'New node', true); },
    });
    cmds.push({
      id: 'delete-node',
      label: 'Delete node',
      shortcut: 'Del',
      section: 'Nodes',
      requiresSelection: true,
      action: () => { if (selectedNodeId) deleteNode(selectedNodeId); },
    });

    // Status
    for (const status of ['Todo', 'In Progress', 'Done'] as const) {
      cmds.push({
        id: `status-${status}`,
        label: `Set status: ${status}`,
        section: 'Status',
        requiresSelection: true,
        action: () => { if (selectedNodeId) updateNode(selectedNodeId, { status }); },
      });
    }

    // Priority
    for (const priority of ['P0', 'P1', 'P2', 'P3'] as const) {
      cmds.push({
        id: `priority-${priority}`,
        label: `Set priority: ${priority}`,
        section: 'Priority',
        requiresSelection: true,
        action: () => { if (selectedNodeId) updateNode(selectedNodeId, { priority }); },
      });
    }

    // Collapse / expand
    cmds.push({
      id: 'toggle-collapse',
      label: 'Toggle collapse',
      shortcut: 'Space',
      section: 'View',
      requiresSelection: true,
      action: () => { if (selectedNodeId) toggleCollapse(selectedNodeId); },
    });
    cmds.push({
      id: 'expand-all',
      label: 'Expand all',
      section: 'View',
      action: () => expandAll(),
    });
    cmds.push({
      id: 'collapse-all',
      label: 'Collapse all',
      section: 'View',
      action: () => collapseAll(),
    });

    // View switching
    const views: Array<{ id: ActiveView; label: string }> = [
      { id: 'kanban', label: 'Kanban' },
      { id: 'gantt', label: 'Gantt' },
      { id: 'list', label: 'List' },
      { id: 'mindmap', label: 'Mindmap' },
    ];
    for (const v of views) {
      cmds.push({
        id: `view-${v.id}`,
        label: `Switch to ${v.label} view`,
        section: 'View',
        action: () => setActiveView(v.id),
      });
    }

    // Layout switching
    const layouts: Array<{ id: LayoutType; label: string }> = [
      { id: 'tree-lr', label: 'Tree (LR)' },
      { id: 'tree-tb', label: 'Tree (TB)' },
      { id: 'radial', label: 'Radial' },
      { id: 'org-chart', label: 'Org Chart' },
    ];
    for (const l of layouts) {
      cmds.push({
        id: `layout-${l.id}`,
        label: `Layout: ${l.label}`,
        section: 'Layout',
        action: () => setLayoutType(l.id),
      });
    }

    // Zoom / fit
    cmds.push({
      id: 'fit-to-screen',
      label: 'Fit to screen',
      shortcut: '\u2318/Ctrl+0',
      section: 'Navigation',
      action: () => onFitToScreen(),
    });
    cmds.push({
      id: 'zoom-in',
      label: 'Zoom in',
      shortcut: '\u2318/Ctrl++',
      section: 'Navigation',
      action: () => onZoomIn(),
    });
    cmds.push({
      id: 'zoom-out',
      label: 'Zoom out',
      shortcut: '\u2318/Ctrl+-',
      section: 'Navigation',
      action: () => onZoomOut(),
    });

    // Go to node
    const allNodes = Object.values(nodes);
    for (const n of allNodes) {
      cmds.push({
        id: `goto-${n.id}`,
        label: `Go to: ${n.text}`,
        section: 'Go to node',
        action: () => selectNode(n.id),
      });
    }

    return cmds;
  }, [
    selectedNodeId, nodes, addNode, deleteNode, updateNode, toggleCollapse,
    expandAll, collapseAll, selectNode, setActiveView, setLayoutType,
    onFitToScreen, onZoomIn, onZoomOut,
  ]);

  // Filter commands
  const filtered = useMemo(() => {
    let list = commands;
    // For goto items: union of (fuzzy match) and (top semantic match) so
    // conceptually-related nodes surface even without a substring hit.
    if (query) {
      list = list.filter((c) => {
        if (c.id.startsWith('goto-')) {
          const nodeId = c.id.slice('goto-'.length);
          return fuzzyMatch(query, c.label) || semanticRank.has(nodeId);
        }
        return fuzzyMatch(query, c.label);
      });
    }
    // Hide selection-required commands when nothing selected (unless searching)
    if (!selectedNodeId && !query) {
      list = list.filter((c) => !c.requiresSelection);
    }
    // Limit goto results to avoid huge list
    const gotos = list.filter((c) => c.id.startsWith('goto-'));
    const nonGotos = list.filter((c) => !c.id.startsWith('goto-'));
    if (gotos.length > 10 && !query) {
      return nonGotos;
    }
    // Sort goto by semantic rank (lower index = more relevant), then everything else
    if (semanticRank.size > 0) {
      gotos.sort((a, b) => {
        const ai = semanticRank.get(a.id.slice('goto-'.length)) ?? Infinity;
        const bi = semanticRank.get(b.id.slice('goto-'.length)) ?? Infinity;
        return ai - bi;
      });
    }
    if (gotos.length > 20) {
      return [...nonGotos, ...gotos.slice(0, 20)];
    }
    return [...nonGotos, ...gotos];
  }, [commands, query, selectedNodeId, semanticRank]);

  // Reset on open
  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Keep active index in bounds
  useEffect(() => {
    if (activeIndex >= filtered.length) {
      setActiveIndex(Math.max(0, filtered.length - 1));
    }
  }, [filtered.length, activeIndex]);

  // Scroll active item into view
  useEffect(() => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll('[data-cmd-item]');
    const item = items[activeIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const execute = useCallback((cmd: Command) => {
    cmd.action();
    onClose();
  }, [onClose]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveIndex((i) => Math.min(filtered.length - 1, i + 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex((i) => Math.max(0, i - 1));
        break;
      case 'Enter':
        e.preventDefault();
        if (filtered[activeIndex]) execute(filtered[activeIndex]);
        break;
      case 'Escape':
        e.preventDefault();
        onClose();
        break;
    }
  }, [filtered, activeIndex, execute, onClose]);

  if (!open) return null;

  // Group by section
  let lastSection = '';

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: 80,
        background: 'rgba(0,0,0,0.3)',
        backdropFilter: 'blur(2px)',
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: 520,
          maxWidth: '90vw',
          maxHeight: 440,
          background: '#fff',
          borderRadius: 12,
          boxShadow: '0 16px 48px rgba(0,0,0,0.15)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
        onKeyDown={handleKeyDown}
      >
        {/* Search input */}
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #e2e8f0' }}>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActiveIndex(0); }}
            placeholder="Type a command..."
            style={{
              width: '100%',
              border: 'none',
              outline: 'none',
              fontSize: 15,
              fontFamily: 'inherit',
              color: '#1e293b',
              background: 'transparent',
            }}
          />
        </div>

        {/* Command list */}
        <div
          ref={listRef}
          style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}
        >
          {filtered.length === 0 && (
            <div style={{ padding: '20px 16px', color: '#94a3b8', fontSize: 13, textAlign: 'center' }}>
              No matching commands
            </div>
          )}
          {filtered.map((cmd, i) => {
            const showSection = cmd.section !== lastSection;
            lastSection = cmd.section;
            const isActive = i === activeIndex;

            return (
              <div key={cmd.id}>
                {showSection && (
                  <div
                    style={{
                      padding: '8px 16px 4px',
                      fontSize: 10,
                      fontWeight: 600,
                      color: '#94a3b8',
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                    }}
                  >
                    {cmd.section}
                  </div>
                )}
                <div
                  data-cmd-item
                  onClick={() => execute(cmd)}
                  onMouseEnter={() => setActiveIndex(i)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '8px 16px',
                    margin: '0 4px',
                    borderRadius: 6,
                    cursor: 'pointer',
                    background: isActive ? '#f1f5f9' : 'transparent',
                    transition: 'background 0.1s',
                  }}
                >
                  <span style={{ fontSize: 13, color: '#1e293b', fontWeight: 500 }}>
                    {cmd.label}
                  </span>
                  {cmd.shortcut && (
                    <span
                      style={{
                        fontSize: 11,
                        color: '#94a3b8',
                        background: '#f1f5f9',
                        padding: '2px 6px',
                        borderRadius: 4,
                        fontFamily: 'monospace',
                        border: '1px solid #e2e8f0',
                      }}
                    >
                      {cmd.shortcut}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer hint */}
        <div
          style={{
            padding: '8px 16px',
            borderTop: '1px solid #e2e8f0',
            display: 'flex',
            gap: 12,
            fontSize: 11,
            color: '#94a3b8',
          }}
        >
          <span><kbd style={{ fontFamily: 'monospace' }}>↑↓</kbd> navigate</span>
          <span><kbd style={{ fontFamily: 'monospace' }}>↵</kbd> execute</span>
          <span><kbd style={{ fontFamily: 'monospace' }}>Esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
