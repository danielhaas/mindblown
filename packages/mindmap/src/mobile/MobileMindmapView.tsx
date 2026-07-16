import { useEffect, useMemo, useRef, useState } from 'react';
import type { MindMap, Node } from '@mindblown/core';
import type { NodeWithComputed } from '../api.js';
import { computeLayout, computeBounds } from '../layout.js';

interface Props {
  nodes: NodeWithComputed[];
  map: MindMap;
  onSelect: (nodeId: string) => void;
}

const PADDING = 40;
const TAP_MOVE_THRESHOLD = 8;
const MIN_SCALE = 0.2;
const MAX_SCALE = 3;

function healthFill(h: string | null | undefined): string {
  switch (h) {
    case 'behind':
      return '#fee2e2';
    case 'at_risk':
      return '#fef3c7';
    case 'on_track':
      return '#dcfce7';
    default:
      return '#fff';
  }
}

function healthStroke(h: string | null | undefined): string {
  switch (h) {
    case 'behind':
      return '#dc2626';
    case 'at_risk':
      return '#f59e0b';
    case 'on_track':
      return '#16a34a';
    default:
      return '#cbd5e1';
  }
}

export function MobileMindmapView({ nodes, map, onSelect }: Props) {
  const nodesById = useMemo<Record<string, Node>>(() => {
    const out: Record<string, Node> = {};
    for (const n of nodes) out[n.id] = n;
    return out;
  }, [nodes]);

  const layoutNodes = useMemo(
    () => computeLayout(map.rootNodeId, nodesById, 'tree-lr'),
    [map.rootNodeId, nodesById],
  );
  const bounds = useMemo(() => computeBounds(layoutNodes), [layoutNodes]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerSize, setContainerSize] = useState({ w: 1, h: 1 });

  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setContainerSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    setContainerSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const initialFit = useMemo(() => {
    if (containerSize.w < 2 || containerSize.h < 2 || bounds.width === 0) {
      return { tx: 0, ty: 0, s: 1 };
    }
    // Fit width with a legibility floor: even very deep trees stay readable
    // by sacrificing horizontal fit (user can pan). Cap at 1 so small maps
    // aren't upscaled awkwardly.
    const sx = (containerSize.w - PADDING * 2) / bounds.width;
    const s = Math.max(0.35, Math.min(sx, 1));
    // Horizontally center; vertically top-align so the root is visible
    // immediately. User pans down to explore children.
    const tx = (containerSize.w - bounds.width * s) / 2 - bounds.minX * s;
    const ty = PADDING - bounds.minY * s;
    return { tx, ty, s };
  }, [containerSize, bounds]);

  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const [s, setS] = useState(1);
  const [initialised, setInitialised] = useState(false);

  useEffect(() => {
    if (!initialised && containerSize.w > 1) {
      setTx(initialFit.tx);
      setTy(initialFit.ty);
      setS(initialFit.s);
      setInitialised(true);
    }
  }, [initialFit, containerSize.w, initialised]);

  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const gestureStart = useRef<{ tx: number; ty: number; s: number; dist: number; cx: number; cy: number } | null>(null);
  const totalMove = useRef(0);
  const tapStartTime = useRef(0);

  const onPointerDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) {
      totalMove.current = 0;
      tapStartTime.current = Date.now();
      gestureStart.current = { tx, ty, s, dist: 0, cx: e.clientX, cy: e.clientY };
    } else if (pointers.current.size === 2) {
      const pts = [...pointers.current.values()];
      const dx = pts[1].x - pts[0].x;
      const dy = pts[1].y - pts[0].y;
      const dist = Math.hypot(dx, dy);
      gestureStart.current = {
        tx,
        ty,
        s,
        dist,
        cx: (pts[0].x + pts[1].x) / 2,
        cy: (pts[0].y + pts[1].y) / 2,
      };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    const prev = pointers.current.get(e.pointerId)!;
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    totalMove.current += Math.abs(dx) + Math.abs(dy);
    if (pointers.current.size === 1) {
      setTx((p) => p + dx);
      setTy((p) => p + dy);
    } else if (pointers.current.size === 2 && gestureStart.current) {
      const pts = [...pointers.current.values()];
      const ddx = pts[1].x - pts[0].x;
      const ddy = pts[1].y - pts[0].y;
      const dist = Math.hypot(ddx, ddy);
      const ratio = dist / gestureStart.current.dist;
      const newS = Math.max(
        MIN_SCALE,
        Math.min(MAX_SCALE, gestureStart.current.s * ratio),
      );
      // Zoom around the gesture centroid: keep that screen point stable.
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) {
        const cx = gestureStart.current.cx - rect.left;
        const cy = gestureStart.current.cy - rect.top;
        const worldX = (cx - gestureStart.current.tx) / gestureStart.current.s;
        const worldY = (cy - gestureStart.current.ty) / gestureStart.current.s;
        setS(newS);
        setTx(cx - worldX * newS);
        setTy(cy - worldY * newS);
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size === 0 && totalMove.current < TAP_MOVE_THRESHOLD && Date.now() - tapStartTime.current < 400) {
      // Tap: hit-test the SVG node at the tap point
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) {
        const screenX = e.clientX - rect.left;
        const screenY = e.clientY - rect.top;
        const worldX = (screenX - tx) / s;
        const worldY = (screenY - ty) / s;
        for (const ln of layoutNodes) {
          if (
            worldX >= ln.x &&
            worldX <= ln.x + ln.width &&
            worldY >= ln.y &&
            worldY <= ln.y + ln.height
          ) {
            if (ln.id !== map.rootNodeId) {
              onSelect(ln.id);
            }
            break;
          }
        }
      }
    }
  };

  const onPointerCancel = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
  };

  const lookup = new Map(nodes.map((n) => [n.id, n]));

  return (
    <div
      ref={containerRef}
      className="mb-mindmap-wrap"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <svg
        width={containerSize.w}
        height={containerSize.h}
        style={{ display: 'block' }}
      >
        <g transform={`translate(${tx},${ty}) scale(${s})`}>
          {layoutNodes.map((ln) => {
            if (!ln.parentId) return null;
            const parent = layoutNodes.find((p) => p.id === ln.parentId);
            if (!parent) return null;
            const x1 = parent.x + parent.width;
            const y1 = parent.y + parent.height / 2;
            const x2 = ln.x;
            const y2 = ln.y + ln.height / 2;
            const midX = (x1 + x2) / 2;
            return (
              <path
                key={`c-${ln.id}`}
                d={`M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`}
                stroke="#cbd5e1"
                strokeWidth={1.5}
                fill="none"
              />
            );
          })}
          {layoutNodes.map((ln) => {
            const n = lookup.get(ln.id);
            const h = n?.healthSignal;
            // Truncate to what actually fits this node's width (layout.ts
            // measures ~7.5px per char + 16px padding each side) instead of
            // a fixed character count.
            const maxChars = Math.max(4, Math.floor((ln.width - 24) / 7.5));
            const text = n?.text ?? '';
            const label = text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
            const pct = Math.round(n?.computedProgress ?? 0);
            return (
              <g key={ln.id}>
                <rect
                  x={ln.x}
                  y={ln.y}
                  width={ln.width}
                  height={ln.height}
                  rx={6}
                  ry={6}
                  fill={healthFill(h)}
                  stroke={healthStroke(h)}
                  strokeWidth={ln.id === map.rootNodeId ? 2 : 1}
                />
                {pct > 0 && (
                  <rect
                    x={ln.x + 1}
                    y={ln.y + ln.height - 4}
                    width={(ln.width - 2) * (pct / 100)}
                    height={3}
                    rx={1.5}
                    fill={pct >= 100 ? '#16a34a' : '#4f46e5'}
                    opacity={0.75}
                    style={{ pointerEvents: 'none' }}
                  />
                )}
                <text
                  x={ln.x + ln.width / 2}
                  y={ln.y + ln.height / 2 + 4}
                  textAnchor="middle"
                  fontSize={13}
                  fontFamily="-apple-system, BlinkMacSystemFont, sans-serif"
                  fill="#0f172a"
                  style={{ pointerEvents: 'none' }}
                >
                  {label}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
      <div className="mb-mindmap-hint">Drag to pan · pinch to zoom · tap a node for details</div>
    </div>
  );
}
