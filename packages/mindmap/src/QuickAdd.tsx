import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMindmapStore } from './store.js';

// ── Date parsing helpers ────────────────────────────────────

function parseRelativeDate(word: string): string | null {
  const today = new Date();
  const lower = word.toLowerCase();

  if (lower === 'today') {
    return fmtDate(today);
  }
  if (lower === 'tomorrow') {
    const d = new Date(today);
    d.setDate(d.getDate() + 1);
    return fmtDate(d);
  }

  // Day names: Monday, Tuesday, etc.
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const dayIdx = days.indexOf(lower);
  if (dayIdx >= 0) {
    const d = new Date(today);
    const diff = (dayIdx - d.getDay() + 7) % 7 || 7;
    d.setDate(d.getDate() + diff);
    return fmtDate(d);
  }

  return null;
}

function parseMonthDate(word1: string, word2?: string): string | null {
  const months: Record<string, number> = {
    jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
    apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
    aug: 7, august: 7, sep: 8, september: 8, oct: 9, october: 9,
    nov: 10, november: 10, dec: 11, december: 11,
  };
  const m = months[word1.toLowerCase()];
  if (m !== undefined && word2 && /^\d{1,2}$/.test(word2)) {
    const d = new Date();
    d.setMonth(m, parseInt(word2, 10));
    if (d < new Date()) d.setFullYear(d.getFullYear() + 1);
    return fmtDate(d);
  }
  return null;
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ── Parse input text ────────────────────────────────────────

interface ParsedInput {
  title: string;
  priority: string | null;
  dueDate: string | null;
  tags: string[];
}

function parseInput(raw: string): ParsedInput {
  const words = raw.split(/\s+/).filter(Boolean);
  const titleParts: string[] = [];
  let priority: string | null = null;
  let dueDate: string | null = null;
  const tags: string[] = [];

  let i = 0;
  while (i < words.length) {
    const w = words[i];

    // Priority
    if (/^p[0-3]$/i.test(w)) {
      priority = w.toUpperCase();
      i++;
      continue;
    }

    // Tags (@name)
    if (w.startsWith('@') && w.length > 1) {
      tags.push(w);
      i++;
      continue;
    }

    // Due date
    if (w.toLowerCase() === 'due' && i + 1 < words.length) {
      const nextWord = words[i + 1];
      // ISO date
      if (/^\d{4}-\d{2}-\d{2}$/.test(nextWord)) {
        dueDate = nextWord;
        i += 2;
        continue;
      }
      // Relative: today, tomorrow, day name
      const rel = parseRelativeDate(nextWord);
      if (rel) {
        dueDate = rel;
        i += 2;
        continue;
      }
      // Month Day: "Apr 15"
      if (i + 2 < words.length) {
        const md = parseMonthDate(nextWord, words[i + 2]);
        if (md) {
          dueDate = md;
          i += 3;
          continue;
        }
      }
      // Just the month-day with next word
      const md2 = parseMonthDate(nextWord, words[i + 2]);
      if (md2) {
        dueDate = md2;
        i += 3;
        continue;
      }
      // Couldn't parse — include "due" in title
      titleParts.push(w);
      i++;
      continue;
    }

    titleParts.push(w);
    i++;
  }

  return {
    title: titleParts.join(' '),
    priority,
    dueDate,
    tags,
  };
}

// ── Component ───────────────────────────────────────────────

interface QuickAddProps {
  open: boolean;
  onClose: () => void;
}

export function QuickAdd({ open, onClose }: QuickAddProps) {
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const selectedNodeId = useMindmapStore((s) => s.selectedNodeId);
  const rootNodeId = useMindmapStore((s) => s.rootNodeId);
  const addNode = useMindmapStore((s) => s.addNode);
  const updateNode = useMindmapStore((s) => s.updateNode);

  const parsed = useMemo(() => parseInput(input), [input]);

  useEffect(() => {
    if (open) {
      setInput('');
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const handleSubmit = useCallback(() => {
    if (!parsed.title.trim()) { onClose(); return; }

    const parentId = selectedNodeId ?? rootNodeId;
    if (!parentId) { onClose(); return; }

    const newId = addNode(parentId, parsed.title.trim());

    // Apply parsed properties
    const updates: Record<string, any> = {};
    if (parsed.priority) updates.priority = parsed.priority;
    if (parsed.dueDate) updates.dueDate = parsed.dueDate;
    if (parsed.tags.length > 0) updates.tags = parsed.tags;
    if (Object.keys(updates).length > 0) {
      updateNode(newId, updates);
    }

    onClose();
  }, [parsed, selectedNodeId, rootNodeId, addNode, updateNode, onClose]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }, [handleSubmit, onClose]);

  if (!open) return null;

  const hasParsed = parsed.priority || parsed.dueDate || parsed.tags.length > 0;

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 1000,
        display: 'flex',
        justifyContent: 'center',
        paddingTop: 8,
      }}
    >
      <div
        style={{
          width: 560,
          maxWidth: '90vw',
          background: '#fff',
          borderRadius: 12,
          boxShadow: '0 8px 32px rgba(0,0,0,0.12)',
          overflow: 'hidden',
          border: '1px solid #e2e8f0',
        }}
      >
        {/* Input */}
        <div style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 14, color: '#4f46e5', fontWeight: 700, flexShrink: 0 }}>+</span>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Add a node... (e.g. 'Design homepage due Friday p1')"
            style={{
              flex: 1,
              border: 'none',
              outline: 'none',
              fontSize: 14,
              fontFamily: 'inherit',
              color: '#1e293b',
              background: 'transparent',
            }}
          />
          <span style={{ fontSize: 10, color: '#94a3b8', flexShrink: 0 }}>
            Enter to add
          </span>
        </div>

        {/* Parsed preview */}
        {input.trim() && (
          <div
            style={{
              padding: '8px 16px 10px',
              borderTop: '1px solid #f1f5f9',
              display: 'flex',
              flexWrap: 'wrap',
              gap: 6,
              alignItems: 'center',
            }}
          >
            {/* Title */}
            {parsed.title && (
              <span style={{ fontSize: 12, color: '#1e293b', fontWeight: 600 }}>
                {parsed.title}
              </span>
            )}

            {/* Priority badge */}
            {parsed.priority && (
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  padding: '2px 6px',
                  borderRadius: 4,
                  background: parsed.priority === 'P0' ? '#fee2e2'
                    : parsed.priority === 'P1' ? '#fff7ed'
                    : parsed.priority === 'P2' ? '#eff6ff'
                    : '#f1f5f9',
                  color: parsed.priority === 'P0' ? '#dc2626'
                    : parsed.priority === 'P1' ? '#ea580c'
                    : parsed.priority === 'P2' ? '#2563eb'
                    : '#6b7280',
                }}
              >
                {parsed.priority}
              </span>
            )}

            {/* Due date badge */}
            {parsed.dueDate && (
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 500,
                  padding: '2px 6px',
                  borderRadius: 4,
                  background: '#faf5ff',
                  color: '#7c3aed',
                }}
              >
                Due: {parsed.dueDate}
              </span>
            )}

            {/* Tags */}
            {parsed.tags.map((tag) => (
              <span
                key={tag}
                style={{
                  fontSize: 10,
                  fontWeight: 500,
                  padding: '2px 6px',
                  borderRadius: 4,
                  background: '#f0fdf4',
                  color: '#16a34a',
                }}
              >
                {tag}
              </span>
            ))}

            {!hasParsed && !parsed.title && (
              <span style={{ fontSize: 11, color: '#94a3b8' }}>
                Start typing...
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
