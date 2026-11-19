/**
 * Who does the map's work (#664), next to the worker count in the Gantt
 * toolbar. Each checked person takes a worker track, in the order checked;
 * their personal leave (entered in their settings) pauses the work on that
 * track. A node assigned to someone follows that person's leave instead.
 */
import { useEffect, useState } from 'react';
import { fetchMapMembers, updateMap as updateMapApi, type MapMember } from './api.js';

export function GanttWorkers({
  mapId,
  workers,
  onSaved,
}: {
  mapId: string;
  workers: string[];
  /** Called after a successful save so the Gantt can refetch its schedule. */
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<MapMember[] | null>(null);
  const [draft, setDraft] = useState<string[]>(workers);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(workers);
    setError(null);
    let live = true;
    fetchMapMembers(mapId)
      .then((r) => live && setMembers(r.members.filter((m) => m.kind !== 'fleet')))
      .catch((err) => live && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [open, mapId, workers]);

  const names = new Map((members ?? []).map((m) => [m.userId, m.name]));
  const label = workers.length === 0 ? 'nobody' : workers.length === 1 ? (names.get(workers[0]) ?? '1 person') : `${workers.length} people`;

  const toggle = (userId: string, on: boolean) =>
    setDraft((d) => (on ? [...d.filter((u) => u !== userId), userId] : d.filter((u) => u !== userId)));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await updateMapApi(mapId, { workers: draft });
      setOpen(false);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        title="Who does this map's work. Their personal leave (Settings → Leave) moves the schedule."
        style={{
          padding: '3px 10px',
          borderRadius: 4,
          border: '1px solid #e2e8f0',
          fontSize: 11,
          fontWeight: 600,
          fontFamily: 'inherit',
          cursor: 'pointer',
          background: workers.length > 0 ? '#f5f3ff' : '#fff',
          color: workers.length > 0 ? '#6d28d9' : '#334155',
        }}
      >
        People: {label} ▾
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Who does the work"
          style={{
            position: 'absolute',
            top: '110%',
            left: 0,
            zIndex: 50,
            width: 280,
            padding: 12,
            background: '#fff',
            border: '1px solid #e2e8f0',
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(15,23,42,0.12)',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            fontSize: 12,
            color: '#334155',
          }}
        >
          <span style={{ fontWeight: 600 }}>Who does the work</span>
          {members === null && !error && <span style={{ color: '#64748b' }}>Loading…</span>}
          {members?.map((m) => {
            const track = draft.indexOf(m.userId);
            return (
              <label key={m.userId} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input type="checkbox" checked={track >= 0} onChange={(e) => toggle(m.userId, e.target.checked)} />
                <span style={{ flex: 1 }}>{m.name}</span>
                {track >= 0 && <span style={{ fontSize: 10, color: '#64748b' }}>track {track + 1}</span>}
              </label>
            );
          })}
          <div style={{ fontSize: 11, color: '#64748b', lineHeight: 1.4 }}>
            Each person takes a worker track; their leave pauses the work on it. Assigned nodes follow their assignee's
            leave. Fleet-built work ignores leave. Keep Workers at least the number of people.
          </div>
          {error && <div style={{ fontSize: 11, color: '#b91c1c' }}>{error}</div>}
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button onClick={() => setOpen(false)} style={{ fontSize: 12, padding: '3px 10px', cursor: 'pointer' }}>
              Cancel
            </button>
            <button
              onClick={save}
              disabled={saving}
              style={{ fontSize: 12, padding: '3px 10px', cursor: 'pointer', background: '#4f46e5', color: '#fff', border: 'none', borderRadius: 4 }}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
