import { useEffect, useRef, useState } from 'react';

// ── Types ───────────────────────────────────────────────────────

interface CursorInfo {
  userId: string;
  name: string;
  x: number;
  y: number;
  color: string;
  lastSeen: number;
}

// ── Color palette for user cursors ──────────────────────────────

const CURSOR_COLORS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4',
  '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6', '#f43f5e',
];

function colorForUser(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = ((hash << 5) - hash + userId.charCodeAt(i)) | 0;
  }
  return CURSOR_COLORS[Math.abs(hash) % CURSOR_COLORS.length];
}

// ── Fade timeout ────────────────────────────────────────────────

const FADE_AFTER_MS = 5000;

// ── Component ───────────────────────────────────────────────────

export function CursorPresence({
  currentUserId,
}: {
  currentUserId: string | null;
}) {
  const [cursors, setCursors] = useState<Map<string, CursorInfo>>(new Map());
  const cursorsRef = useRef(cursors);
  cursorsRef.current = cursors;

  // Listen for WebSocket cursor events
  useEffect(() => {
    const handleCursorEvent = (e: CustomEvent) => {
      const msg = e.detail;
      if (msg.type !== 'cursor') return;
      if (msg.userId === currentUserId) return;

      setCursors((prev) => {
        const next = new Map(prev);
        next.set(msg.userId, {
          userId: msg.userId,
          name: msg.name ?? 'User',
          x: msg.x,
          y: msg.y,
          color: colorForUser(msg.userId),
          lastSeen: Date.now(),
        });
        return next;
      });
    };

    window.addEventListener('ws:cursor' as any, handleCursorEvent as any);
    return () => window.removeEventListener('ws:cursor' as any, handleCursorEvent as any);
  }, [currentUserId]);

  // Clean up stale cursors
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setCursors((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const [id, info] of next) {
          if (now - info.lastSeen > FADE_AFTER_MS * 2) {
            next.delete(id);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 2000);

    return () => clearInterval(interval);
  }, []);

  const now = Date.now();

  return (
    <g>
      {Array.from(cursors.values()).map((cursor) => {
        const age = now - cursor.lastSeen;
        const opacity = age > FADE_AFTER_MS
          ? Math.max(0, 1 - (age - FADE_AFTER_MS) / FADE_AFTER_MS)
          : 1;

        if (opacity <= 0) return null;

        return (
          <g
            key={cursor.userId}
            transform={`translate(${cursor.x}, ${cursor.y})`}
            style={{
              opacity,
              transition: 'transform 0.1s linear, opacity 0.3s ease',
            }}
          >
            {/* Cursor arrow */}
            <path
              d="M0 0 L0 16 L4.5 12 L8.5 20 L11 19 L7 11 L13 11 Z"
              fill={cursor.color}
              stroke="#fff"
              strokeWidth={1}
              style={{ filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.2))' }}
            />
            {/* Name label */}
            <g transform="translate(14, 16)">
              <rect
                x={0}
                y={0}
                width={Math.max(40, cursor.name.length * 6.5 + 12)}
                height={18}
                rx={4}
                ry={4}
                fill={cursor.color}
                opacity={0.9}
              />
              <text
                x={6}
                y={13}
                fontSize={10}
                fontWeight={600}
                fill="#fff"
                style={{ userSelect: 'none', pointerEvents: 'none' }}
              >
                {cursor.name}
              </text>
            </g>
          </g>
        );
      })}
    </g>
  );
}
