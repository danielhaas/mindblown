import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMindmapStore, getWsClient } from './store.js';
import { computeLayout, computeBounds } from './layout.js';
import type { LayoutType } from './layout.js';
import { MindmapNode } from './MindmapNode.js';
import { Connector } from './Connector.js';
import { DependencyLines } from './DependencyLines.js';
import { CursorPresence } from './CursorPresence.js';
import type { LayoutNode } from './layout.js';
import type { Node } from '@mindblown/core';

// ── Pan & Zoom state ───────────────────────────────────────────

interface ViewState {
  panX: number;
  panY: number;
  zoom: number;
}

const MIN_ZOOM = 0.15;
const MAX_ZOOM = 3;
const DRAG_THRESHOLD = 5; // px of movement before drag starts

// ── Drag state ────────────────────────────────────────────────

interface DragState {
  nodeId: string;
  startClientX: number;
  startClientY: number;
  currentClientX: number;
  currentClientY: number;
  isDragging: boolean; // true once threshold exceeded
  originX: number; // original layout x
  originY: number; // original layout y
}

interface DropTarget {
  type: 'parent' | 'between';
  parentId: string;
  index: number;
}

// ── Helper: check if nodeId is ancestor of potentialDescendantId ─

function isAncestor(
  nodeId: string,
  potentialDescendantId: string,
  nodes: Record<string, { parentId: string | null; childrenIds: string[] }>,
): boolean {
  const queue = [nodeId];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    const node = nodes[current];
    if (!node) continue;
    for (const childId of node.childrenIds) {
      if (childId === potentialDescendantId) return true;
      queue.push(childId);
    }
  }
  return false;
}

// ── Layout selector labels ──────────────────────────────────

const LAYOUT_OPTIONS: Array<{ id: LayoutType; label: string }> = [
  { id: 'tree-lr', label: 'Tree (LR)' },
  { id: 'tree-tb', label: 'Tree (TB)' },
  { id: 'radial', label: 'Radial' },
  { id: 'org-chart', label: 'Org Chart' },
];

// ── Bulk Action Bar ─────────────────────────────────────────

function BulkActionBar({
  count,
  onSetStatus,
  onSetPriority,
  onDelete,
  onCollapse,
  onExpand,
}: {
  count: number;
  onSetStatus: (status: string) => void;
  onSetPriority: (priority: string) => void;
  onDelete: () => void;
  onCollapse: () => void;
  onExpand: () => void;
}) {
  return (
    <div
      style={{
        position: 'absolute',
        bottom: 16,
        left: '50%',
        transform: 'translateX(-50%)',
        background: '#1e293b',
        color: '#fff',
        borderRadius: 10,
        padding: '8px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
        zIndex: 20,
        fontSize: 12,
        fontWeight: 500,
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ fontWeight: 700, color: '#a5b4fc' }}>{count} selected</span>

      <div style={{ width: 1, height: 16, background: '#475569' }} />

      {/* Status dropdown */}
      <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{ color: '#94a3b8' }}>Status:</span>
        <select
          onChange={(e) => { if (e.target.value) onSetStatus(e.target.value); e.target.value = ''; }}
          onKeyDown={(e) => e.stopPropagation()}
          style={{
            background: '#334155',
            color: '#fff',
            border: 'none',
            borderRadius: 4,
            padding: '2px 6px',
            fontSize: 11,
            fontFamily: 'inherit',
            cursor: 'pointer',
          }}
          defaultValue=""
        >
          <option value="" disabled>Choose</option>
          <option value="Todo">Todo</option>
          <option value="In Progress">In Progress</option>
          <option value="Done">Done</option>
        </select>
      </label>

      {/* Priority dropdown */}
      <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{ color: '#94a3b8' }}>Priority:</span>
        <select
          onChange={(e) => { if (e.target.value) onSetPriority(e.target.value); e.target.value = ''; }}
          onKeyDown={(e) => e.stopPropagation()}
          style={{
            background: '#334155',
            color: '#fff',
            border: 'none',
            borderRadius: 4,
            padding: '2px 6px',
            fontSize: 11,
            fontFamily: 'inherit',
            cursor: 'pointer',
          }}
          defaultValue=""
        >
          <option value="" disabled>Choose</option>
          <option value="P0">P0</option>
          <option value="P1">P1</option>
          <option value="P2">P2</option>
          <option value="P3">P3</option>
        </select>
      </label>

      <div style={{ width: 1, height: 16, background: '#475569' }} />

      <button
        onClick={onCollapse}
        style={{
          background: '#334155',
          color: '#fff',
          border: 'none',
          borderRadius: 4,
          padding: '3px 8px',
          fontSize: 11,
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        Collapse
      </button>
      <button
        onClick={onExpand}
        style={{
          background: '#334155',
          color: '#fff',
          border: 'none',
          borderRadius: 4,
          padding: '3px 8px',
          fontSize: 11,
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        Expand
      </button>

      <div style={{ width: 1, height: 16, background: '#475569' }} />

      <button
        onClick={onDelete}
        style={{
          background: '#991b1b',
          color: '#fff',
          border: 'none',
          borderRadius: 4,
          padding: '3px 8px',
          fontSize: 11,
          cursor: 'pointer',
          fontFamily: 'inherit',
          fontWeight: 600,
        }}
      >
        Delete
      </button>
    </div>
  );
}

// ── Main Editor Component ───────────────────────────────────

const DEPTH_OPTIONS = [
  { value: 1, label: '1' },
  { value: 2, label: '2' },
  { value: 3, label: '3' },
  { value: 0, label: 'All' },
];

export function MindmapEditor() {
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState<ViewState>({ panX: 0, panY: 0, zoom: 1 });
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);

  const nodes = useMindmapStore((s) => s.nodes);
  const rootNodeId = useMindmapStore((s) => s.rootNodeId);
  const selectedNodeIds = useMindmapStore((s) => s.selectedNodeIds);
  const selectedNodeId = useMindmapStore((s) => s.selectedNodeId);
  const editingNodeId = useMindmapStore((s) => s.editingNodeId);
  const computed = useMindmapStore((s) => s.computed);
  const layoutType = useMindmapStore((s) => s.layoutType);
  const focusNodeId = useMindmapStore((s) => s.focusNodeId);
  const maxDepth = useMindmapStore((s) => s.maxDepth);
  const selectNode = useMindmapStore((s) => s.selectNode);
  const toggleSelectNode = useMindmapStore((s) => s.toggleSelectNode);
  const selectAllNodes = useMindmapStore((s) => s.selectAllNodes);
  const clearSelection = useMindmapStore((s) => s.clearSelection);
  const startEditing = useMindmapStore((s) => s.startEditing);
  const addNode = useMindmapStore((s) => s.addNode);
  const updateNode = useMindmapStore((s) => s.updateNode);
  const deleteNode = useMindmapStore((s) => s.deleteNode);
  const toggleCollapse = useMindmapStore((s) => s.toggleCollapse);
  const moveNode = useMindmapStore((s) => s.moveNode);
  const setLayoutType = useMindmapStore((s) => s.setLayoutType);
  const setFocusNode = useMindmapStore((s) => s.setFocusNode);
  const setMaxDepth = useMindmapStore((s) => s.setMaxDepth);
  const getVisibleNodes = useMindmapStore((s) => s.getVisibleNodes);
  const user = useMindmapStore((s) => s.user);

  // ── Context menu state ──────────────────────────────────────
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null);

  // ── Cursor presence: throttled send ──────────────────────────
  const lastCursorSend = useRef(0);

  // ── Drag-and-drop state ───────────────────────────────────────

  const [drag, setDrag] = useState<DragState | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [invalidDrop, setInvalidDrop] = useState(false);
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;

  // ── Visible nodes computation ───────────────────────────────

  const visibleNodes = useMemo(() => getVisibleNodes(), [nodes, focusNodeId, maxDepth, rootNodeId, getVisibleNodes]);

  // Build a filtered nodes record containing only visible (non-dimmed) nodes
  // with adjusted parentId for the layout algorithm
  const visibleNodesRecord = useMemo(() => {
    const record: Record<string, Node> = {};
    const visibleIds = new Set(visibleNodes.filter((v) => !v.isDimmed).map((v) => v.node.id));

    for (const vn of visibleNodes) {
      if (vn.isDimmed) continue;
      const node = vn.node;
      // Filter childrenIds to only include visible children
      const filteredChildren = node.childrenIds.filter((cid) => visibleIds.has(cid));
      record[node.id] = { ...node, childrenIds: filteredChildren };
    }
    return record;
  }, [visibleNodes]);

  // Build a lookup for visible node metadata (hasHiddenChildren, hiddenDescendantCount, isDimmed)
  const visibleMeta = useMemo(() => {
    const meta = new Map<string, { hasHiddenChildren: boolean; hiddenDescendantCount: number; isDimmed: boolean }>();
    for (const vn of visibleNodes) {
      meta.set(vn.node.id, {
        hasHiddenChildren: vn.hasHiddenChildren,
        hiddenDescendantCount: vn.hiddenDescendantCount,
        isDimmed: vn.isDimmed,
      });
    }
    return meta;
  }, [visibleNodes]);

  // ── Layout computation ─────────────────────────────────────

  const effectiveRootId = focusNodeId ?? rootNodeId;

  const layoutNodes = useMemo(
    () => effectiveRootId ? computeLayout(effectiveRootId, visibleNodesRecord, layoutType) : [],
    [effectiveRootId, visibleNodesRecord, layoutType],
  );

  // Also layout dimmed sibling nodes (simple positioning beside the main tree)
  const dimmedLayoutNodes = useMemo(() => {
    const dimmedNodes = visibleNodes.filter((v) => v.isDimmed);
    if (dimmedNodes.length === 0 || !effectiveRootId) return [];

    // Position dimmed nodes to the left of the focus tree
    const mainBounds = computeBounds(layoutNodes);
    const result: LayoutNode[] = [];
    let yOffset = mainBounds.minY;

    for (const dn of dimmedNodes) {
      const textWidth = dn.node.text.length * 7.5 + 32;
      const width = Math.min(260, Math.max(100, Math.max(160, textWidth)));
      const height = 40;
      result.push({
        id: dn.node.id,
        x: mainBounds.minX - width - 80,
        y: yOffset,
        width,
        height,
        parentId: dn.node.parentId,
        depth: 0,
        hasChildren: dn.node.childrenIds.length > 0,
        collapsed: dn.node.collapsed,
      });
      yOffset += height + 14;
    }
    return result;
  }, [visibleNodes, layoutNodes, effectiveRootId]);

  const allLayoutNodes = useMemo(
    () => [...layoutNodes, ...dimmedLayoutNodes],
    [layoutNodes, dimmedLayoutNodes],
  );

  const layoutMap = useMemo(() => {
    const map = new Map<string, LayoutNode>();
    for (const ln of allLayoutNodes) {
      map.set(ln.id, ln);
    }
    return map;
  }, [allLayoutNodes]);

  // ── Selected node IDs as a Set for fast lookup ────────────

  const selectedSet = useMemo(() => new Set(selectedNodeIds), [selectedNodeIds]);

  // ── Fit to screen function ─────────────────────────────────

  const fitToScreen = useCallback(() => {
    if (allLayoutNodes.length === 0) return;
    const svg = svgRef.current;
    if (!svg) return;

    const bounds = computeBounds(allLayoutNodes);
    const svgRect = svg.getBoundingClientRect();
    const padding = 80;

    const scaleX = (svgRect.width - padding * 2) / (bounds.width + padding);
    const scaleY = (svgRect.height - padding * 2) / (bounds.height + padding);
    const zoom = Math.min(1, Math.min(scaleX, scaleY));

    const centerX = bounds.minX + bounds.width / 2;
    const centerY = bounds.minY + bounds.height / 2;

    setView({
      zoom,
      panX: svgRect.width / 2 - centerX * zoom,
      panY: svgRect.height / 2 - centerY * zoom,
    });
  }, [allLayoutNodes]);

  // Expose fitToScreen, zoomIn, zoomOut on the window for the command palette / App
  useEffect(() => {
    (window as any).__mindmapFitToScreen = fitToScreen;
    (window as any).__mindmapZoomIn = () => {
      setView((v) => ({ ...v, zoom: Math.min(MAX_ZOOM, v.zoom * 1.2) }));
    };
    (window as any).__mindmapZoomOut = () => {
      setView((v) => ({ ...v, zoom: Math.max(MIN_ZOOM, v.zoom / 1.2) }));
    };
    return () => {
      delete (window as any).__mindmapFitToScreen;
      delete (window as any).__mindmapZoomIn;
      delete (window as any).__mindmapZoomOut;
    };
  }, [fitToScreen]);

  // ── Fit to view on first render ────────────────────────────

  const hasInitialized = useRef<string | null>(null);
  useEffect(() => {
    if (hasInitialized.current === rootNodeId || layoutNodes.length === 0) return;
    hasInitialized.current = rootNodeId;
    fitToScreen();
  }, [layoutNodes, rootNodeId, fitToScreen]);

  // Re-fit when focus node changes (drill-down animation)
  const prevFocusRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevFocusRef.current !== focusNodeId) {
      prevFocusRef.current = focusNodeId;
      // Short delay so layout has time to recompute
      const timer = setTimeout(() => fitToScreen(), 50);
      return () => clearTimeout(timer);
    }
  }, [focusNodeId, fitToScreen]);

  // ── Convert client coords to SVG coords ───────────────────

  const clientToSvg = useCallback(
    (clientX: number, clientY: number) => {
      const svg = svgRef.current;
      if (!svg) return { x: 0, y: 0 };
      const rect = svg.getBoundingClientRect();
      return {
        x: (clientX - rect.left - view.panX) / view.zoom,
        y: (clientY - rect.top - view.panY) / view.zoom,
      };
    },
    [view.panX, view.panY, view.zoom],
  );

  // ── Find drop target based on cursor position ─────────────

  const findDropTarget = useCallback(
    (svgX: number, svgY: number, dragNodeId: string): { target: DropTarget | null; invalid: boolean } => {
      for (const ln of layoutNodes) {
        if (ln.id === dragNodeId) continue;

        const inX = svgX >= ln.x && svgX <= ln.x + ln.width;
        const inY = svgY >= ln.y && svgY <= ln.y + ln.height;

        if (inX && inY) {
          if (isAncestor(dragNodeId, ln.id, nodes)) {
            return { target: { type: 'parent', parentId: ln.id, index: 0 }, invalid: true };
          }

          const node = nodes[ln.id];
          if (!node) continue;

          const relY = svgY - ln.y;
          const fraction = relY / ln.height;

          if (node.parentId && fraction < 0.25) {
            const parent = nodes[node.parentId];
            if (parent) {
              const idx = parent.childrenIds.indexOf(ln.id);
              return { target: { type: 'between', parentId: node.parentId, index: Math.max(0, idx) }, invalid: false };
            }
          } else if (node.parentId && fraction > 0.75) {
            const parent = nodes[node.parentId];
            if (parent) {
              const idx = parent.childrenIds.indexOf(ln.id);
              return { target: { type: 'between', parentId: node.parentId, index: idx + 1 }, invalid: false };
            }
          } else {
            return {
              target: { type: 'parent', parentId: ln.id, index: node.childrenIds.length },
              invalid: false,
            };
          }
        }
      }

      return { target: null, invalid: false };
    },
    [layoutNodes, nodes],
  );

  // ── Drag initiation from node ──────────────────────────────

  const handleNodeDragStart = useCallback(
    (nodeId: string, startX: number, startY: number) => {
      if (nodeId === rootNodeId) return;
      const ln = layoutMap.get(nodeId);
      if (!ln) return;

      setDrag({
        nodeId,
        startClientX: startX,
        startClientY: startY,
        currentClientX: startX,
        currentClientY: startY,
        isDragging: false,
        originX: ln.x,
        originY: ln.y,
      });
    },
    [rootNodeId, layoutMap],
  );

  // ── Pan handling ───────────────────────────────────────────

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button === 1 || (e.button === 0 && e.target === svgRef.current)) {
        e.preventDefault();
        setIsPanning(true);
        panStart.current = { x: e.clientX, y: e.clientY, panX: view.panX, panY: view.panY };
      }
    },
    [view.panX, view.panY],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      // Send cursor position via WebSocket (throttled to 50ms)
      const now = Date.now();
      if (now - lastCursorSend.current >= 50) {
        lastCursorSend.current = now;
        const ws = getWsClient();
        if (ws && user) {
          const svgCursor = clientToSvg(e.clientX, e.clientY);
          ws.send({
            type: 'cursor',
            userId: user.id,
            name: user.name ?? user.email,
            x: svgCursor.x,
            y: svgCursor.y,
          });
        }
      }

      if (drag) {
        const dx = e.clientX - drag.startClientX;
        const dy = e.clientY - drag.startClientY;

        if (!drag.isDragging) {
          if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
            setDrag({ ...drag, isDragging: true, currentClientX: e.clientX, currentClientY: e.clientY });
          }
          return;
        }

        setDrag({ ...drag, currentClientX: e.clientX, currentClientY: e.clientY });

        const svgPos = clientToSvg(e.clientX, e.clientY);
        const { target, invalid } = findDropTarget(svgPos.x, svgPos.y, drag.nodeId);
        setDropTarget(target);
        setInvalidDrop(invalid);
        return;
      }

      if (!isPanning || !panStart.current) return;
      const dx = e.clientX - panStart.current.x;
      const dy = e.clientY - panStart.current.y;
      setView((v) => ({
        ...v,
        panX: panStart.current!.panX + dx,
        panY: panStart.current!.panY + dy,
      }));
    },
    [isPanning, drag, clientToSvg, findDropTarget, user],
  );

  const handleMouseUp = useCallback(
    (e: React.MouseEvent) => {
      if (drag?.isDragging) {
        if (dropTarget && !invalidDrop) {
          const dragNode = nodes[drag.nodeId];
          if (dragNode?.parentId) {
            let adjustedIndex = dropTarget.index;
            if (dropTarget.parentId === dragNode.parentId) {
              const currentIdx = nodes[dragNode.parentId].childrenIds.indexOf(drag.nodeId);
              if (currentIdx < adjustedIndex) {
                adjustedIndex = Math.max(0, adjustedIndex - 1);
              }
            }
            moveNode(drag.nodeId, dropTarget.parentId, adjustedIndex);
          }
        } else if (!dropTarget && !invalidDrop) {
          const svgPos = clientToSvg(e.clientX, e.clientY);
          const ln = layoutMap.get(drag.nodeId);
          if (ln) {
            updateNode(drag.nodeId, {
              x: svgPos.x - ln.width / 2,
              y: svgPos.y - ln.height / 2,
            });
          }
        }

        setDrag(null);
        setDropTarget(null);
        setInvalidDrop(false);
        return;
      }

      setDrag(null);
      setIsPanning(false);
      panStart.current = null;
    },
    [drag, dropTarget, invalidDrop, nodes, moveNode, updateNode, clientToSvg, layoutMap],
  );

  // ── Zoom handling (native listener to avoid passive event issue) ──

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const zoomFactor = e.deltaY > 0 ? 0.92 : 1.08;

      setView((v) => {
        const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * zoomFactor));
        const scale = newZoom / v.zoom;
        return {
          zoom: newZoom,
          panX: mouseX - (mouseX - v.panX) * scale,
          panY: mouseY - (mouseY - v.panY) * scale,
        };
      });
    };

    svg.addEventListener('wheel', handleWheel, { passive: false });
    return () => svg.removeEventListener('wheel', handleWheel);
  }, []);

  // ── Click on background -> deselect ────────────────────────

  const handleBackgroundClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === svgRef.current && !drag?.isDragging) {
        clearSelection();
      }
    },
    [clearSelection, drag],
  );

  // ── Node click handler (supports shift+click multi-select) ─

  const handleNodeSelect = useCallback(
    (nodeId: string, shiftKey: boolean) => {
      if (shiftKey) {
        toggleSelectNode(nodeId);
      } else {
        selectNode(nodeId);
      }
    },
    [selectNode, toggleSelectNode],
  );

  // ── Keyboard shortcuts ─────────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't intercept when editing text
      if (editingNodeId) {
        if (e.key === 'Escape') {
          startEditing(null);
          e.preventDefault();
        }
        return;
      }

      // Cmd+A to select all
      if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
        e.preventDefault();
        selectAllNodes();
        return;
      }

      // Cmd+0 to fit to screen
      if ((e.metaKey || e.ctrlKey) && e.key === '0') {
        e.preventDefault();
        fitToScreen();
        return;
      }

      if (!selectedNodeId) return;

      switch (e.key) {
        case 'Tab': {
          e.preventDefault();
          addNode(selectedNodeId);
          break;
        }
        case 'Enter': {
          e.preventDefault();
          addNode(selectedNodeId, 'New node', true);
          break;
        }
        case 'Delete':
        case 'Backspace': {
          e.preventDefault();
          // Delete all selected nodes
          for (const id of selectedNodeIds) {
            if (id !== rootNodeId) deleteNode(id);
          }
          break;
        }
        case ' ': {
          e.preventDefault();
          toggleCollapse(selectedNodeId);
          break;
        }
        case 'F2': {
          e.preventDefault();
          startEditing(selectedNodeId);
          break;
        }
        case 'Escape': {
          // If drilled into a node, go back up one level first
          if (focusNodeId) {
            const focusNode = nodes[focusNodeId];
            if (focusNode?.parentId && focusNode.parentId !== rootNodeId) {
              setFocusNode(focusNode.parentId);
            } else {
              setFocusNode(null);
            }
          } else {
            clearSelection();
          }
          break;
        }
        case 'ArrowLeft': {
          e.preventDefault();
          const selNode = nodes[selectedNodeId];
          if (selNode?.parentId) selectNode(selNode.parentId);
          break;
        }
        case 'ArrowRight': {
          e.preventDefault();
          const selNodeR = nodes[selectedNodeId];
          if (selNodeR && selNodeR.childrenIds.length > 0 && !selNodeR.collapsed) {
            selectNode(selNodeR.childrenIds[0]);
          }
          break;
        }
        case 'ArrowUp': {
          e.preventDefault();
          const selNodeU = nodes[selectedNodeId];
          if (selNodeU?.parentId) {
            const par = nodes[selNodeU.parentId];
            if (par) {
              const idx = par.childrenIds.indexOf(selectedNodeId);
              if (idx > 0) selectNode(par.childrenIds[idx - 1]);
            }
          }
          break;
        }
        case 'ArrowDown': {
          e.preventDefault();
          const selNodeD = nodes[selectedNodeId];
          if (selNodeD?.parentId) {
            const par = nodes[selNodeD.parentId];
            if (par) {
              const idx = par.childrenIds.indexOf(selectedNodeId);
              if (idx < par.childrenIds.length - 1) selectNode(par.childrenIds[idx + 1]);
            }
          }
          break;
        }
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [
    selectedNodeId, selectedNodeIds, editingNodeId, nodes, rootNodeId,
    addNode, deleteNode, toggleCollapse, selectNode, startEditing,
    selectAllNodes, clearSelection, fitToScreen, focusNodeId, setFocusNode,
  ]);

  // ── Bulk actions ──────────────────────────────────────────

  const handleBulkSetStatus = useCallback((status: string) => {
    for (const id of selectedNodeIds) updateNode(id, { status });
  }, [selectedNodeIds, updateNode]);

  const handleBulkSetPriority = useCallback((priority: string) => {
    for (const id of selectedNodeIds) updateNode(id, { priority });
  }, [selectedNodeIds, updateNode]);

  const handleBulkDelete = useCallback(() => {
    for (const id of selectedNodeIds) {
      if (id !== rootNodeId) deleteNode(id);
    }
  }, [selectedNodeIds, rootNodeId, deleteNode]);

  const handleBulkCollapse = useCallback(() => {
    for (const id of selectedNodeIds) {
      const n = nodes[id];
      if (n && n.childrenIds.length > 0 && !n.collapsed) toggleCollapse(id);
    }
  }, [selectedNodeIds, nodes, toggleCollapse]);

  const handleBulkExpand = useCallback(() => {
    for (const id of selectedNodeIds) {
      const n = nodes[id];
      if (n && n.childrenIds.length > 0 && n.collapsed) toggleCollapse(id);
    }
  }, [selectedNodeIds, nodes, toggleCollapse]);

  // ── Build connector edges ──────────────────────────────────

  const connectors = useMemo(() => {
    const edges: Array<{
      parentLayout: LayoutNode;
      childLayout: LayoutNode;
      isDimmed: boolean;
    }> = [];

    for (const ln of allLayoutNodes) {
      if (ln.parentId) {
        const parentLayout = layoutMap.get(ln.parentId);
        if (parentLayout) {
          const meta = visibleMeta.get(ln.id);
          const parentMeta = visibleMeta.get(ln.parentId);
          const isDimmed = (meta?.isDimmed ?? false) || (parentMeta?.isDimmed ?? false);
          edges.push({ parentLayout, childLayout: ln, isDimmed });
        }
      }
    }

    return edges;
  }, [allLayoutNodes, layoutMap, visibleMeta]);

  // ── Compute drag ghost position ────────────────────────────

  const dragGhost = useMemo(() => {
    if (!drag?.isDragging) return null;
    const ln = layoutMap.get(drag.nodeId);
    if (!ln) return null;

    const svgPos = clientToSvg(drag.currentClientX, drag.currentClientY);
    return {
      x: svgPos.x - ln.width / 2,
      y: svgPos.y - ln.height / 2,
      width: ln.width,
      height: ln.height,
      text: nodes[drag.nodeId]?.text ?? '',
    };
  }, [drag, layoutMap, clientToSvg, nodes]);

  // ── Compute drop indicator position ────────────────────────

  const dropIndicator = useMemo(() => {
    if (!dropTarget || !drag?.isDragging || invalidDrop) return null;

    if (dropTarget.type === 'between') {
      const parentLn = layoutMap.get(dropTarget.parentId);
      if (!parentLn) return null;
      const parentNode = nodes[dropTarget.parentId];
      if (!parentNode) return null;

      const children = parentNode.childrenIds.filter((cid) => cid !== drag.nodeId);
      let indicatorY: number;

      if (children.length === 0 || dropTarget.index === 0) {
        const firstChild = children[0] ? layoutMap.get(children[0]) : null;
        indicatorY = firstChild ? firstChild.y - 7 : parentLn.y + parentLn.height / 2;
      } else if (dropTarget.index >= children.length) {
        const lastChild = layoutMap.get(children[children.length - 1]);
        indicatorY = lastChild ? lastChild.y + lastChild.height + 7 : parentLn.y + parentLn.height / 2;
      } else {
        const above = layoutMap.get(children[dropTarget.index - 1]);
        const below = layoutMap.get(children[dropTarget.index]);
        if (above && below) {
          indicatorY = (above.y + above.height + below.y) / 2;
        } else {
          indicatorY = parentLn.y + parentLn.height / 2;
        }
      }

      const childX = parentLn.x + parentLn.width + 60;
      return { x: childX, y: indicatorY, width: 160 };
    }

    return null;
  }, [dropTarget, drag, invalidDrop, layoutMap, nodes]);

  // ── Render ─────────────────────────────────────────────────

  const cursorStyle = drag?.isDragging
    ? 'grabbing'
    : isPanning
      ? 'grabbing'
      : 'default';

  const showBulkActions = selectedNodeIds.length > 1;

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      {/* Layout selector + Depth selector + Fit button in top-right */}
      <div
        style={{
          position: 'absolute',
          top: 8,
          right: 8,
          zIndex: 15,
          display: 'flex',
          gap: 4,
          alignItems: 'center',
        }}
      >
        <select
          value={layoutType}
          onChange={(e) => setLayoutType(e.target.value as LayoutType)}
          onKeyDown={(e) => e.stopPropagation()}
          style={{
            fontSize: 11,
            fontFamily: 'inherit',
            border: '1px solid #e2e8f0',
            borderRadius: 6,
            padding: '4px 24px 4px 8px',
            color: '#475569',
            background: '#fff',
            appearance: 'none' as const,
            backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'%3E%3Cpath fill='%2394a3b8' d='M2 3.5L5 7l3-3.5H2z'/%3E%3C/svg%3E")`,
            backgroundRepeat: 'no-repeat',
            backgroundPosition: 'right 6px center',
            cursor: 'pointer',
            boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
            fontWeight: 500,
          }}
        >
          {LAYOUT_OPTIONS.map((opt) => (
            <option key={opt.id} value={opt.id}>{opt.label}</option>
          ))}
        </select>

        {/* Depth selector */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            background: '#fff',
            border: '1px solid #e2e8f0',
            borderRadius: 6,
            padding: '2px 4px',
            boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
          }}
        >
          <span style={{ fontSize: 10, fontWeight: 600, color: '#94a3b8', padding: '0 4px' }}>
            Depth:
          </span>
          {DEPTH_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setMaxDepth(opt.value)}
              style={{
                fontSize: 11,
                fontWeight: 600,
                fontFamily: 'inherit',
                border: 'none',
                borderRadius: 4,
                padding: '2px 8px',
                cursor: 'pointer',
                background: maxDepth === opt.value ? '#4f46e5' : 'transparent',
                color: maxDepth === opt.value ? '#fff' : '#64748b',
                transition: 'background 0.15s, color 0.15s',
              }}
              title={opt.value === 0 ? 'Show all levels (may be slow for large maps)' : `Show ${opt.value} level${opt.value > 1 ? 's' : ''} deep`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <button
          onClick={fitToScreen}
          title="Fit to screen (Cmd/Ctrl+0)"
          style={{
            background: '#fff',
            border: '1px solid #e2e8f0',
            borderRadius: 6,
            padding: '4px 10px',
            fontSize: 11,
            fontWeight: 600,
            color: '#475569',
            cursor: 'pointer',
            fontFamily: 'inherit',
            boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
          }}
        >
          Fit
        </button>
      </div>

      <svg
        ref={svgRef}
        style={{
          width: '100%',
          height: '100%',
          cursor: cursorStyle,
          outline: 'none',
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onClick={handleBackgroundClick}
        onContextMenu={(e) => { if (!contextMenu) e.preventDefault(); }}
        tabIndex={0}
      >
        {/* Definitions for drop shadows and filters */}
        <defs>
          <filter id="node-shadow" x="-8%" y="-8%" width="116%" height="130%">
            <feDropShadow dx="0" dy="1" stdDeviation="3" floodColor="#000" floodOpacity="0.08" />
          </filter>
          <filter id="node-shadow-selected" x="-8%" y="-8%" width="116%" height="130%">
            <feDropShadow dx="0" dy="2" stdDeviation="5" floodColor="#4f46e5" floodOpacity="0.2" />
          </filter>
          <filter id="drag-target-glow" x="-15%" y="-15%" width="130%" height="130%">
            <feDropShadow dx="0" dy="0" stdDeviation="6" floodColor="#3b82f6" floodOpacity="0.35" />
          </filter>
        </defs>

        <g transform={`translate(${view.panX}, ${view.panY}) scale(${view.zoom})`}>
          {/* Connectors (render behind nodes) */}
          {connectors.map(({ parentLayout, childLayout, isDimmed }) => (
            <g
              key={`${parentLayout.id}-${childLayout.id}`}
              style={{ opacity: isDimmed ? 0.15 : 1, transition: 'opacity 0.3s ease' }}
            >
              <Connector
                parent={parentLayout}
                child={childLayout}
              />
            </g>
          ))}

          {/* Dependency lines (above connectors, below nodes) */}
          <DependencyLines
            layoutMap={layoutMap}
            nodes={nodes}
            svgRef={svgRef}
            viewState={view}
          />

          {/* Drop indicator line */}
          {dropIndicator && (
            <g>
              <line
                x1={dropIndicator.x}
                y1={dropIndicator.y}
                x2={dropIndicator.x + dropIndicator.width}
                y2={dropIndicator.y}
                stroke="#3b82f6"
                strokeWidth={2.5}
                strokeLinecap="round"
              />
              <circle cx={dropIndicator.x} cy={dropIndicator.y} r={4} fill="#3b82f6" />
              <circle cx={dropIndicator.x + dropIndicator.width} cy={dropIndicator.y} r={4} fill="#3b82f6" />
            </g>
          )}

          {/* Nodes */}
          {allLayoutNodes.map((ln) => {
            const meta = visibleMeta.get(ln.id);
            const isDimmed = meta?.isDimmed ?? false;
            const isBeingDragged = drag?.isDragging && drag.nodeId === ln.id;
            const isTargetNode = dropTarget && !invalidDrop && dropTarget.type === 'parent' && dropTarget.parentId === ln.id;
            const isInvalidTarget = dropTarget && invalidDrop && dropTarget.parentId === ln.id;
            const nodeData = nodes[ln.id];
            if (!nodeData) return null;

            return (
              <g
                key={ln.id}
                style={{
                  opacity: isDimmed ? 0.3 : 1,
                  transition: 'opacity 0.3s ease',
                }}
              >
                <MindmapNode
                  layout={ln}
                  node={nodeData}
                  computedValues={computed.get(ln.id)}
                  isSelected={selectedSet.has(ln.id)}
                  isEditing={ln.id === editingNodeId}
                  isDragging={isBeingDragged ?? false}
                  isDragTarget={isTargetNode ?? false}
                  isDragInvalid={isInvalidTarget ?? false}
                  hasHiddenChildren={meta?.hasHiddenChildren ?? false}
                  hiddenDescendantCount={meta?.hiddenDescendantCount ?? 0}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    selectNode(ln.id);
                    setContextMenu({ x: e.clientX, y: e.clientY, nodeId: ln.id });
                  }}
                  onSelect={(shiftKey) => {
                    if (isDimmed) {
                      // Clicking a dimmed node drills into it
                      setFocusNode(ln.id);
                    } else {
                      handleNodeSelect(ln.id, shiftKey);
                    }
                  }}
                  onDoubleClick={() => {
                    if (isDimmed) {
                      setFocusNode(ln.id);
                    } else if (nodeData.childrenIds.length > 0) {
                      // Double-click a node with children = drill into it
                      setFocusNode(ln.id);
                    } else {
                      startEditing(ln.id);
                    }
                  }}
                  onTextChange={(text) => {
                    updateNode(ln.id, { text });
                    startEditing(null);
                  }}
                  onEditCancel={() => startEditing(null)}
                  onDragStart={isDimmed ? undefined : handleNodeDragStart}
                />
              </g>
            );
          })}

          {/* Drag ghost */}
          {dragGhost && (
            <g style={{ pointerEvents: 'none' }}>
              <rect
                x={dragGhost.x}
                y={dragGhost.y}
                width={dragGhost.width}
                height={dragGhost.height}
                rx={8}
                ry={8}
                fill="#ffffff"
                stroke="#4f46e5"
                strokeWidth={2}
                strokeDasharray="4 3"
                opacity={0.75}
              />
              <text
                x={dragGhost.x + dragGhost.width / 2}
                y={dragGhost.y + dragGhost.height / 2}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={13}
                fontWeight={500}
                fill="#4f46e5"
                opacity={0.8}
                style={{ userSelect: 'none' }}
              >
                {dragGhost.text.length > 28 ? dragGhost.text.slice(0, 26) + '...' : dragGhost.text}
              </text>
            </g>
          )}

          {/* Cursor presence overlay */}
          <CursorPresence currentUserId={user?.id ?? null} />
        </g>
      </svg>

      {/* Bulk action bar */}
      {showBulkActions && (
        <BulkActionBar
          count={selectedNodeIds.length}
          onSetStatus={handleBulkSetStatus}
          onSetPriority={handleBulkSetPriority}
          onDelete={handleBulkDelete}
          onCollapse={handleBulkCollapse}
          onExpand={handleBulkExpand}
        />
      )}

      {/* Context menu */}
      {contextMenu && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 999 }}
            onClick={() => setContextMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setContextMenu(null); }}
          />
          <div
            style={{
              position: 'fixed',
              left: contextMenu.x,
              top: contextMenu.y,
              zIndex: 1000,
              background: '#fff',
              borderRadius: 8,
              boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
              border: '1px solid #e2e8f0',
              padding: '4px 0',
              minWidth: 180,
              fontSize: 13,
            }}
          >
            <button
              style={ctxMenuItemStyle}
              onMouseEnter={(e) => (e.currentTarget.style.background = '#f1f5f9')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              onClick={() => {
                addNode(contextMenu.nodeId);
                setContextMenu(null);
              }}
            >
              Add child node
            </button>
            <button
              style={ctxMenuItemStyle}
              onMouseEnter={(e) => (e.currentTarget.style.background = '#f1f5f9')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              onClick={() => {
                addNode(contextMenu.nodeId, 'New node', true);
                setContextMenu(null);
              }}
            >
              Add sibling node
            </button>
            <div style={{ height: 1, background: '#e2e8f0', margin: '4px 0' }} />
            <button
              style={ctxMenuItemStyle}
              onMouseEnter={(e) => (e.currentTarget.style.background = '#f1f5f9')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              onClick={() => {
                startEditing(contextMenu.nodeId);
                setContextMenu(null);
              }}
            >
              Edit
            </button>
            {contextMenu.nodeId !== rootNodeId && (
              <button
                style={{ ...ctxMenuItemStyle, color: '#dc2626' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = '#fef2f2')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                onClick={() => {
                  deleteNode(contextMenu.nodeId);
                  setContextMenu(null);
                }}
              >
                Delete
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

const ctxMenuItemStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '6px 12px',
  border: 'none',
  background: 'transparent',
  textAlign: 'left' as const,
  cursor: 'pointer',
  fontSize: 13,
  color: '#1e293b',
};
