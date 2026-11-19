/**
 * Personal leave (#664) — the signed-in person's days off, as date ranges
 * with an optional note. Rendered inside WorkspaceSettings (workspace-wide
 * view). The schedule of every map whose work the person does (the map's
 * People in the Gantt, or nodes assigned to them) works around them.
 */
import { useEffect, useState } from 'react';
import { formatLeaveRange, type LeaveRange } from '@mindblown/core';
import { addMyLeave, listMyLeave, removeMyLeave } from './api.js';

export function LeavePanel() {
  const [leave, setLeave] = useState<LeaveRange[] | null>(null);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    listMyLeave()
      .then((r) => live && setLeave(r.leave))
      .catch((err) => live && setError(err instanceof Error ? err.message : 'Failed to load'));
    return () => {
      live = false;
    };
  }, []);

  const add = async () => {
    setSaving(true);
    setError(null);
    try {
      const r = await addMyLeave({ startDate, endDate: endDate || startDate, note: note.trim() || null });
      setLeave((l) => [...(l ?? []), r].sort((a, b) => a.startDate.localeCompare(b.startDate)));
      setStartDate('');
      setEndDate('');
      setNote('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    setError(null);
    try {
      await removeMyLeave(id);
      setLeave((l) => (l ?? []).filter((r) => r.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove');
    }
  };

  const input = { fontSize: 12, padding: '4px 6px', border: '1px solid #e2e8f0', borderRadius: 4 } as const;

  return (
    <div style={{ marginTop: 24, paddingTop: 24, borderTop: '1px solid #f1f5f9' }} data-testid="leave-panel">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1e293b" strokeWidth="2">
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <path d="M16 2v4M8 2v4M3 10h18" />
        </svg>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#1e293b' }}>Leave</h3>
      </div>
      <div style={{ fontSize: 12, color: '#64748b', marginBottom: 12 }}>
        Days you are away. The schedule of every map you work on moves around them — weekends and holidays inside a
        range are not counted twice.
      </div>

      {error && (
        <div style={{ fontSize: 12, color: '#dc2626', background: '#fef2f2', padding: '8px 12px', borderRadius: 6, marginBottom: 12 }}>
          {error}
        </div>
      )}

      {leave && leave.length > 0 && (
        <ul style={{ listStyle: 'none', margin: '0 0 12px', padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {leave.map((r) => (
            <li key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#1e293b' }}>
              <span style={{ fontWeight: 600 }}>{formatLeaveRange(r)}</span>
              <span style={{ color: '#64748b', fontSize: 12 }}>
                {r.startDate === r.endDate ? r.startDate : `${r.startDate} – ${r.endDate}`}
                {r.note ? ` · ${r.note}` : ''}
              </span>
              <button
                aria-label={`Remove leave ${formatLeaveRange(r)}`}
                onClick={() => remove(r.id)}
                style={{ marginLeft: 'auto', border: 'none', background: 'none', cursor: 'pointer', color: '#94a3b8', fontSize: 14 }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {leave && leave.length === 0 && <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 12 }}>No leave entered.</div>}

      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <input type="date" aria-label="First day away" value={startDate} onChange={(e) => setStartDate(e.target.value)} style={input} />
        <span style={{ fontSize: 12, color: '#64748b' }}>to</span>
        <input type="date" aria-label="Last day away" value={endDate} min={startDate || undefined} onChange={(e) => setEndDate(e.target.value)} style={input} />
        <input placeholder="Note (optional)" aria-label="Note" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} style={{ ...input, flex: '1 1 120px' }} />
        <button
          onClick={add}
          disabled={!startDate || saving}
          style={{ fontSize: 12, padding: '4px 12px', cursor: 'pointer', background: '#4f46e5', color: '#fff', border: 'none', borderRadius: 4 }}
        >
          {saving ? 'Adding…' : 'Add leave'}
        </button>
      </div>
    </div>
  );
}
