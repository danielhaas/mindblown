import { useCallback, useEffect, useRef, useState } from 'react';
import type { Node, ComputedNodeValues } from '@mindblown/core';
import type { LayoutNode } from './layout.js';

// ── Color palette ──────────────────────────────────────────────

const DEPTH_COLORS = [
  '#4f46e5', // root — indigo
  '#0891b2', // depth 1 — cyan
  '#059669', // depth 2 — emerald
  '#d97706', // depth 3 — amber
  '#dc2626', // depth 4 — red
  '#7c3aed', // depth 5 — violet
];

const HEALTH_COLORS: Record<string, string> = {
  on_track: '#059669',
  at_risk: '#d97706',
  behind: '#dc2626',
};

const PRIORITY_COLORS: Record<string, string> = {
  P0: '#dc2626',
  P1: '#ea580c',
  P2: '#2563eb',
  P3: '#6b7280',
};

function getNodeColor(depth: number): string {
  return DEPTH_COLORS[Math.min(depth, DEPTH_COLORS.length - 1)];
}

function getNodeBg(depth: number): string {
  if (depth === 0) return '#4f46e5';
  return '#ffffff';
}

function getNodeTextColor(depth: number): string {
  if (depth === 0) return '#ffffff';
  return '#1e293b';
}

// ── Progress Ring ──────────────────────────────────────────────

function ProgressRing({
  progress,
  size = 16,
  stroke = 2.5,
}: {
  progress: number;
  size?: number;
  stroke?: number;
}) {
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - progress / 100);

  return (
    <svg width={size} height={size} style={{ transform: 'rotate(-90deg)', flexShrink: 0 }}>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="#e2e8f0"
        strokeWidth={stroke}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={progress >= 100 ? '#059669' : '#4f46e5'}
        strokeWidth={stroke}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
      />
    </svg>
  );
}

// ── Avatar Circle ──────────────────────────────────────────────

function AvatarCircle({ userId, index }: { userId: string; index: number }) {
  const colors = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#3b82f6'];
  const color = colors[index % colors.length];
  const initials = userId.slice(-2).toUpperCase();

  return (
    <g transform={`translate(${index * 14}, 0)`}>
      <circle cx="8" cy="8" r="8" fill={color} />
      <text
        x="8"
        y="8"
        textAnchor="middle"
        dominantBaseline="central"
        fill="white"
        fontSize="7"
        fontWeight="600"
      >
        {initials}
      </text>
    </g>
  );
}

// ── Main Node Component ────────────────────────────────────────

interface MindmapNodeProps {
  layout: LayoutNode;
  node: Node;
  computedValues?: ComputedNodeValues;
  isSelected: boolean;
  isEditing: boolean;
  onSelect: () => void;
  onDoubleClick: () => void;
  onTextChange: (text: string) => void;
  onEditCancel: () => void;
}

export function MindmapNode({
  layout,
  node,
  computedValues,
  isSelected,
  isEditing,
  onSelect,
  onDoubleClick,
  onTextChange,
  onEditCancel,
}: MindmapNodeProps) {
  const { x, y, width, height, depth, collapsed, hasChildren } = layout;
  const isMilestone = node.isMilestone;
  const borderRadius = depth === 0 ? 12 : 8;
  const borderColor = getNodeColor(depth);
  const bgColor = isMilestone ? '#f5f3ff' : getNodeBg(depth);
  const textColor = isMilestone ? '#6d28d9' : getNodeTextColor(depth);

  // Health signal border override
  let healthBorderColor: string | null = null;
  if (computedValues && computedValues.healthSignal !== 'on_track') {
    healthBorderColor = HEALTH_COLORS[computedValues.healthSignal];
  }

  const strokeColor = isSelected
    ? '#4f46e5'
    : isMilestone
      ? '#8b5cf6'
      : healthBorderColor || (depth === 0 ? '#4f46e5' : '#e2e8f0');
  const strokeWidth = isSelected ? 2.5 : isMilestone ? 2 : depth === 0 ? 0 : 1.5;

  // Computed values
  const progress = computedValues?.computedProgress ?? 0;
  const effort = computedValues?.computedEffort ?? 0;
  const showProgress = node.percentComplete != null || (hasChildren && effort > 0);
  const showPriority = node.priority != null;
  const showAssignees = node.assigneeIds.length > 0;

  // ── Inline editing ─────────────────────────────────────────

  const inputRef = useRef<HTMLInputElement>(null);
  const [editText, setEditText] = useState(node.text);

  useEffect(() => {
    if (isEditing) {
      setEditText(node.text);
      // Focus after the foreignObject renders
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [isEditing, node.text]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const trimmed = editText.trim();
        if (trimmed) onTextChange(trimmed);
        else onEditCancel();
      } else if (e.key === 'Escape') {
        onEditCancel();
      }
    },
    [editText, onTextChange, onEditCancel],
  );

  const handleBlur = useCallback(() => {
    const trimmed = editText.trim();
    if (trimmed && trimmed !== node.text) {
      onTextChange(trimmed);
    } else {
      onEditCancel();
    }
  }, [editText, node.text, onTextChange, onEditCancel]);

  // ── Annotations offset ────────────────────────────────────

  const annotationY = y + height + 4;

  return (
    <g
      style={{ cursor: 'pointer' }}
      onMouseDown={(e) => {
        e.stopPropagation();
        onSelect();
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onDoubleClick();
      }}
    >
      {/* Node shape: diamond for milestones, rectangle for normal nodes */}
      {isMilestone ? (
        <g>
          <polygon
            points={`${x + width / 2},${y - 4} ${x + width + 4},${y + height / 2} ${x + width / 2},${y + height + 4} ${x - 4},${y + height / 2}`}
            fill={bgColor}
            stroke={strokeColor}
            strokeWidth={strokeWidth}
            filter={isSelected ? 'url(#node-shadow-selected)' : 'url(#node-shadow)'}
          />
          {/* Small milestone icon at top-left corner area */}
          <svg x={x + 6} y={y + 4} width="10" height="10" viewBox="0 0 10 10">
            <polygon points="5,0 10,5 5,10 0,5" fill="#8b5cf6" opacity="0.6" />
          </svg>
          <animate
            attributeName="opacity"
            from="0"
            to="1"
            dur="0.3s"
            fill="freeze"
          />
        </g>
      ) : (
        <rect
          x={x}
          y={y}
          width={width}
          height={height}
          rx={borderRadius}
          ry={borderRadius}
          fill={bgColor}
          stroke={strokeColor}
          strokeWidth={strokeWidth}
          filter={isSelected ? 'url(#node-shadow-selected)' : 'url(#node-shadow)'}
        >
          {/* Subtle entrance animation */}
          <animate
            attributeName="opacity"
            from="0"
            to="1"
            dur="0.3s"
            fill="freeze"
          />
        </rect>
      )}

      {/* Collapse indicator */}
      {collapsed && (
        <g transform={`translate(${x + width - 8}, ${y + height / 2})`}>
          <circle r="8" fill="#f1f5f9" stroke="#cbd5e1" strokeWidth="1" />
          <text
            textAnchor="middle"
            dominantBaseline="central"
            fontSize="11"
            fontWeight="700"
            fill="#64748b"
          >
            +
          </text>
        </g>
      )}

      {/* Progress ring (left side of node) */}
      {showProgress && (
        <foreignObject
          x={x + 8}
          y={y + (height - 16) / 2}
          width={16}
          height={16}
        >
          <ProgressRing progress={progress} />
        </foreignObject>
      )}

      {/* Priority dot */}
      {showPriority && node.priority && (
        <circle
          cx={x + (showProgress ? 32 : 14)}
          cy={y + height / 2}
          r={4}
          fill={PRIORITY_COLORS[node.priority] || '#6b7280'}
        />
      )}

      {/* Node text or edit input */}
      {isEditing ? (
        <foreignObject
          x={x + 4}
          y={y + 2}
          width={width - 8}
          height={height - 4}
        >
          <input
            ref={inputRef}
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            style={{
              width: '100%',
              height: '100%',
              border: 'none',
              outline: 'none',
              background: 'transparent',
              fontSize: depth === 0 ? '14px' : '13px',
              fontWeight: depth === 0 ? '700' : '500',
              color: textColor,
              fontFamily: 'inherit',
              textAlign: 'center',
              padding: '0 4px',
            }}
          />
        </foreignObject>
      ) : (
        <text
          x={x + width / 2}
          y={y + height / 2}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={depth === 0 ? 14 : 13}
          fontWeight={depth === 0 ? 700 : hasChildren ? 600 : 400}
          fill={textColor}
          style={{ pointerEvents: 'none', userSelect: 'none' }}
        >
          {node.text.length > 28 ? node.text.slice(0, 26) + '...' : node.text}
        </text>
      )}

      {/* Assignee avatars (below node) */}
      {showAssignees && (
        <g transform={`translate(${x + 4}, ${annotationY})`}>
          {node.assigneeIds.slice(0, 3).map((uid, i) => (
            <AvatarCircle key={uid} userId={uid} index={i} />
          ))}
        </g>
      )}

      {/* Effort label (right of progress ring area, below node) */}
      {effort > 0 && hasChildren && (
        <text
          x={x + width - 8}
          y={annotationY + 8}
          textAnchor="end"
          fontSize={10}
          fill="#94a3b8"
          fontWeight={500}
        >
          {effort}d
        </text>
      )}
    </g>
  );
}
