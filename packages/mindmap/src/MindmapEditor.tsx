import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMindmapStore } from './store.js';
import { computeLayout, computeBounds } from './layout.js';
import { MindmapNode } from './MindmapNode.js';
import { Connector } from './Connector.js';
import type { LayoutNode } from './layout.js';

// ── Pan & Zoom state ───────────────────────────────────────────

interface ViewState {
  panX: number;
  panY: number;
  zoom: number;
}

const MIN_ZOOM = 0.15;
const MAX_ZOOM = 3;

export function MindmapEditor() {
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState<ViewState>({ panX: 0, panY: 0, zoom: 1 });
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);

  const nodes = useMindmapStore((s) => s.nodes);
  const rootNodeId = useMindmapStore((s) => s.rootNodeId);
  const selectedNodeId = useMindmapStore((s) => s.selectedNodeId);
  const editingNodeId = useMindmapStore((s) => s.editingNodeId);
  const computed = useMindmapStore((s) => s.computed);
  const selectNode = useMindmapStore((s) => s.selectNode);
  const startEditing = useMindmapStore((s) => s.startEditing);
  const addNode = useMindmapStore((s) => s.addNode);
  const updateNode = useMindmapStore((s) => s.updateNode);
  const deleteNode = useMindmapStore((s) => s.deleteNode);
  const toggleCollapse = useMindmapStore((s) => s.toggleCollapse);

  // ── Layout computation ─────────────────────────────────────

  const layoutNodes = useMemo(() => computeLayout(rootNodeId, nodes), [rootNodeId, nodes]);

  const layoutMap = useMemo(() => {
    const map = new Map<string, LayoutNode>();
    for (const ln of layoutNodes) {
      map.set(ln.id, ln);
    }
    return map;
  }, [layoutNodes]);

  // ── Fit to view on first render ────────────────────────────

  const hasInitialized = useRef(false);
  useEffect(() => {
    if (hasInitialized.current || layoutNodes.length === 0) return;
    hasInitialized.current = true;

    const svg = svgRef.current;
    if (!svg) return;

    const bounds = computeBounds(layoutNodes);
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
  }, [layoutNodes]);

  // ── Pan handling ───────────────────────────────────────────

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Only pan on background click or middle-mouse
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
      if (!isPanning || !panStart.current) return;
      const dx = e.clientX - panStart.current.x;
      const dy = e.clientY - panStart.current.y;
      setView((v) => ({
        ...v,
        panX: panStart.current!.panX + dx,
        panY: panStart.current!.panY + dy,
      }));
    },
    [isPanning],
  );

  const handleMouseUp = useCallback(() => {
    setIsPanning(false);
    panStart.current = null;
  }, []);

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

  // ── Click on background → deselect ─────────────────────────

  const handleBackgroundClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === svgRef.current) {
        selectNode(null);
      }
    },
    [selectNode],
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
          deleteNode(selectedNodeId);
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
          selectNode(null);
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
  }, [selectedNodeId, editingNodeId, nodes, addNode, deleteNode, toggleCollapse, selectNode, startEditing]);

  // ── Build connector edges ──────────────────────────────────

  const connectors = useMemo(() => {
    const edges: Array<{
      parentLayout: LayoutNode;
      childLayout: LayoutNode;
    }> = [];

    for (const ln of layoutNodes) {
      if (ln.parentId) {
        const parentLayout = layoutMap.get(ln.parentId);
        if (parentLayout) {
          edges.push({ parentLayout, childLayout: ln });
        }
      }
    }

    return edges;
  }, [layoutNodes, layoutMap]);

  // ── Render ─────────────────────────────────────────────────

  return (
    <svg
      ref={svgRef}
      style={{
        width: '100%',
        height: '100%',
        cursor: isPanning ? 'grabbing' : 'default',
        outline: 'none',
      }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onClick={handleBackgroundClick}
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
      </defs>

      <g transform={`translate(${view.panX}, ${view.panY}) scale(${view.zoom})`}>
        {/* Connectors (render behind nodes) */}
        {connectors.map(({ parentLayout, childLayout }) => (
          <Connector
            key={`${parentLayout.id}-${childLayout.id}`}
            parent={parentLayout}
            child={childLayout}
          />
        ))}

        {/* Nodes */}
        {layoutNodes.map((ln) => (
          <MindmapNode
            key={ln.id}
            layout={ln}
            node={nodes[ln.id]}
            computedValues={computed.get(ln.id)}
            isSelected={ln.id === selectedNodeId}
            isEditing={ln.id === editingNodeId}
            onSelect={() => selectNode(ln.id)}
            onDoubleClick={() => startEditing(ln.id)}
            onTextChange={(text) => {
              updateNode(ln.id, { text });
              startEditing(null);
            }}
            onEditCancel={() => startEditing(null)}
          />
        ))}
      </g>
    </svg>
  );
}
