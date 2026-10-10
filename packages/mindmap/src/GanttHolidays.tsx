/**
 * Holiday calendar control for the Gantt toolbar (#110).
 *
 * A jurisdiction (country or country-region, resolved on the server with
 * date-holidays) plus the map's own adjustments: extra days off, and public
 * holidays the team works anyway. Any of them set = the map schedules on a
 * working calendar (Mon–Fri minus holidays); none = every day counts.
 */
import { useEffect, useState } from 'react';
import type { HolidayOverrides } from '@mindblown/core';
import { updateMap as updateMapApi } from './api.js';

const CH_CANTONS = ['AG', 'AI', 'AR', 'BE', 'BL', 'BS', 'FR', 'GE', 'GL', 'GR', 'JU', 'LU', 'NE', 'NW', 'OW', 'SG', 'SH', 'SO', 'SZ', 'TG', 'TI', 'UR', 'VD', 'VS', 'ZG', 'ZH'];
const DE_STATES = ['BB', 'BE', 'BW', 'BY', 'HB', 'HE', 'HH', 'MV', 'NI', 'NW', 'RP', 'SH', 'SL', 'SN', 'ST', 'TH'];

const GROUPS: Array<{ label: string; options: Array<{ code: string; label: string }> }> = [
  { label: 'Liechtenstein', options: [{ code: 'LI', label: 'Liechtenstein (LI)' }] },
  {
    label: 'Switzerland',
    options: [{ code: 'CH', label: 'Switzerland — national (CH)' }, ...CH_CANTONS.map((c) => ({ code: `CH-${c}`, label: `Switzerland — ${c}` }))],
  },
  { label: 'Austria', options: [{ code: 'AT', label: 'Austria (AT)' }] },
  {
    label: 'Germany',
    options: [{ code: 'DE', label: 'Germany — national (DE)' }, ...DE_STATES.map((s) => ({ code: `DE-${s}`, label: `Germany — ${s}` }))],
  },
];
const KNOWN = new Set(GROUPS.flatMap((g) => g.options.map((o) => o.code)));
const OTHER = '__other__';

const EMPTY: HolidayOverrides = { add: [], remove: [] };

export function GanttHolidays({
  mapId,
  jurisdiction,
  overrides,
  onSaved,
}: {
  mapId: string;
  jurisdiction: string | null;
  overrides: HolidayOverrides | undefined;
  /** Called after a successful save so the Gantt can refetch its schedule. */
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState<string>(jurisdiction ?? '');
  const [otherCode, setOtherCode] = useState('');
  const [draft, setDraft] = useState<HolidayOverrides>(overrides ?? EMPTY);
  const [addDate, setAddDate] = useState('');
  const [removeDate, setRemoveDate] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Unsaved edits in the open panel — a map:updated broadcast from another
  // tab must not wipe them.
  const [dirty, setDirty] = useState(false);

  // Seed from the map when the panel opens, and follow outside changes only
  // while the user has not started editing.
  useEffect(() => {
    if (!open || dirty) return;
    const j = jurisdiction ?? '';
    if (j && !KNOWN.has(j)) {
      setCode(OTHER);
      setOtherCode(j);
    } else {
      setCode(j);
      setOtherCode('');
    }
    setDraft(overrides ?? EMPTY);
    setError(null);
  }, [open, dirty, jurisdiction, overrides]);
  useEffect(() => {
    if (!open) setDirty(false);
  }, [open]);

  const active = Boolean(jurisdiction) || (overrides?.add.length ?? 0) > 0 || (overrides?.remove.length ?? 0) > 0;
  const label = jurisdiction ?? (active ? 'own days' : 'none');

  const save = async () => {
    const nextCode = code === OTHER ? otherCode.trim() : code;
    setSaving(true);
    setError(null);
    try {
      await updateMapApi(mapId, { holidayJurisdiction: nextCode || null, holidayOverrides: draft });
      setOpen(false);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const chipList = (key: 'add' | 'remove') =>
    draft[key].map((d) => (
      <span
        key={d}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 6px', borderRadius: 10, background: '#f1f5f9', fontSize: 11 }}
      >
        {d}
        <button
          aria-label={`Remove ${d}`}
          onClick={() => {
            setDraft({ ...draft, [key]: draft[key].filter((x) => x !== d) });
            setDirty(true);
          }}
          style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#64748b', padding: 0, fontSize: 12 }}
        >
          ×
        </button>
      </span>
    ));

  const dateAdder = (key: 'add' | 'remove', value: string, setValue: (v: string) => void, cta: string) => (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <input type="date" value={value} onChange={(e) => setValue(e.target.value)} style={{ fontSize: 12, padding: '2px 4px' }} />
      <button
        disabled={!value || draft[key].includes(value)}
        onClick={() => {
          setDraft({ ...draft, [key]: [...draft[key], value].sort() });
          setValue('');
          setDirty(true);
        }}
        style={{ fontSize: 11, padding: '2px 8px', cursor: 'pointer' }}
      >
        {cta}
      </button>
    </div>
  );

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        title="Public holidays and days off. Set = the schedule skips weekends and these days; none = every day counts. Holiday data: date-holidays (CC BY 3.0)."
        style={{
          padding: '3px 10px',
          borderRadius: 4,
          border: '1px solid #e2e8f0',
          fontSize: 11,
          fontWeight: 600,
          fontFamily: 'inherit',
          cursor: 'pointer',
          background: active ? '#eef2ff' : '#fff',
          color: active ? '#4338ca' : '#334155',
        }}
      >
        Holidays: {label} ▾
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Holiday calendar"
          style={{
            position: 'absolute',
            top: '110%',
            left: 0,
            zIndex: 50,
            width: 300,
            padding: 12,
            background: '#fff',
            border: '1px solid #e2e8f0',
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(15,23,42,0.12)',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            fontSize: 12,
            color: '#334155',
          }}
        >
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontWeight: 600 }}>Public holidays</span>
            <select
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
                setDirty(true);
              }}
              style={{ fontSize: 12, padding: '3px 4px' }}
            >
              <option value="">None</option>
              {GROUPS.map((g) => (
                <optgroup key={g.label} label={g.label}>
                  {g.options.map((o) => (
                    <option key={o.code} value={o.code}>
                      {o.label}
                    </option>
                  ))}
                </optgroup>
              ))}
              <option value={OTHER}>Other code…</option>
            </select>
          </label>
          {code === OTHER && (
            <input
              value={otherCode}
              onChange={(e) => {
                setOtherCode(e.target.value);
                setDirty(true);
              }}
              placeholder="e.g. FR, IT, US-NY"
              style={{ fontSize: 12, padding: '3px 6px' }}
            />
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontWeight: 600 }}>Extra days off</span>
            {draft.add.length > 0 && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>{chipList('add')}</div>}
            {dateAdder('add', addDate, setAddDate, 'Add day off')}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontWeight: 600 }}>Holidays worked anyway</span>
            {draft.remove.length > 0 && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>{chipList('remove')}</div>}
            {dateAdder('remove', removeDate, setRemoveDate, 'Work this day')}
          </div>

          <div style={{ fontSize: 11, color: '#64748b', lineHeight: 1.4 }}>
            Only official public holidays are counted — add half-days and bank days (e.g. 24/31 Dec, Berchtoldstag where
            optional) as extra days off. Anything set here puts the map on a working calendar: Mon–Fri, minus these days.
            Nothing set = every day counts.
          </div>
          <div style={{ fontSize: 10, color: '#94a3b8' }}>
            Holiday data: date-holidays (CC BY 3.0).
          </div>
          {error && <div style={{ fontSize: 11, color: '#b91c1c' }}>{error}</div>}
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button onClick={() => setOpen(false)} style={{ fontSize: 12, padding: '3px 10px', cursor: 'pointer' }}>
              Cancel
            </button>
            <button
              onClick={save}
              disabled={saving || (code === OTHER && !otherCode.trim())}
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
