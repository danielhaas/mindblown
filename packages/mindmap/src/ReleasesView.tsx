import { useEffect, useMemo, useState } from 'react';
import { compareVersions } from '@mindblown/core';
import type { Version } from '@mindblown/core';
import { useMindmapStore } from './store.js';
import * as api from './api.js';
import type { ReleaseForecastResponse, ReleaseForecastRow } from './api.js';

// ── Colors ───────────────────────────────────────────────────────

const VERSION_STATUS_LABEL: Record<Version['status'], string> = {
  planning: 'Planning',
  active: 'Active',
  released: 'Released',
  archived: 'Archived',
};

const VERSION_STATUS_COLOR: Record<Version['status'], string> = {
  planning: '#64748b',
  active: '#3b82f6',
  released: '#10b981',
  archived: '#94a3b8',
};

const STATUS_OPTIONS: Version['status'][] = ['planning', 'active', 'released', 'archived'];

// ── Helpers ──────────────────────────────────────────────────────

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDateRange(start: string | null, end: string | null): string {
  if (!start || !end) return '—';
  const s = new Date(start);
  const e = new Date(end);
  const days = Math.max(0, Math.round((e.getTime() - s.getTime()) / 86_400_000));
  return `${days} calendar day${days === 1 ? '' : 's'}`;
}

function formatSlip(days: number | null): { text: string; color: string } {
  if (days == null) return { text: '—', color: '#94a3b8' };
  if (days === 0) return { text: 'on target', color: '#f59e0b' };
  if (days < 0) return { text: `${Math.abs(days)}d ahead`, color: '#10b981' };
  return { text: `${days}d late`, color: '#ef4444' };
}

function formatTrend(days: number | null): { text: string; color: string } | null {
  if (days == null) return null;
  if (days === 0) return { text: 'unchanged this week', color: '#94a3b8' };
  if (days < 0) return { text: `${Math.abs(days)}d pulled in this week`, color: '#10b981' };
  return { text: `+${days}d slipped this week`, color: '#ef4444' };
}

function formatAge(iso: string | null, now: Date = new Date()): string {
  if (!iso) return 'no snapshot yet';
  const ms = now.getTime() - new Date(iso).getTime();
  if (ms < 0) return 'just now';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function toDateInput(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '';
}

// ── Form state ───────────────────────────────────────────────────

interface FormFields {
  name: string;
  description: string;
  status: Version['status'];
  targetDate: string;
}

type FormState =
  | { mode: 'create'; fields: FormFields }
  | { mode: 'edit'; id: string; fields: FormFields };

function emptyFields(): FormFields {
  return { name: '', description: '', status: 'planning', targetDate: '' };
}

function fieldsFromVersion(v: Version): FormFields {
  return {
    name: v.name,
    description: v.description ?? '',
    status: v.status,
    targetDate: toDateInput(v.targetDate),
  };
}

// ── Component ────────────────────────────────────────────────────

export function ReleasesView() {
  const currentMapId = useMindmapStore((s) => s.currentMapId);
  const versions = useMindmapStore((s) => s.versions);
  const activeVersionFilter = useMindmapStore((s) => s.activeVersionFilter);
  const createVersionAction = useMindmapStore((s) => s.createVersion);
  const updateVersionAction = useMindmapStore((s) => s.updateVersion);
  const deleteVersionAction = useMindmapStore((s) => s.deleteVersion);

  const [forecast, setForecast] = useState<ReleaseForecastResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped by the Refresh button to re-trigger the effect.
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [formState, setFormState] = useState<FormState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Focus-factor knob: fraction of calendar time reaching planned work.
  // Editing it saves via update_map and re-runs the forecast (which stretches
  // the velocity-adjusted finish dates). Mirrors the server value on load.
  const [focusInput, setFocusInput] = useState<number>(1);
  const [savingFocus, setSavingFocus] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!currentMapId) {
        setForecast(null);
        return;
      }
      const manual = refreshNonce > 0;
      if (manual) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const result = await api.fetchReleaseForecast(currentMapId, { refresh: manual });
        if (!cancelled) setForecast(result);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load release forecast');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [currentMapId, versions, refreshNonce]);

  const handleRefresh = () => setRefreshNonce((n) => n + 1);

  // Keep the visible Focus input in sync with whatever the server returns.
  useEffect(() => {
    if (forecast?.focusFactor !== undefined) {
      setFocusInput(forecast.focusFactor);
    }
  }, [forecast?.focusFactor]);

  // Commit a new focus factor: clamp to (0.05, 1], persist, then re-forecast.
  const commitFocus = async (value: number) => {
    if (!currentMapId) return;
    const clamped = Math.min(1, Math.max(0.05, value));
    setFocusInput(clamped);
    if (forecast && clamped === forecast.focusFactor) return;
    setSavingFocus(true);
    try {
      await api.updateMap(currentMapId, { focusFactor: clamped });
      setRefreshNonce((n) => n + 1); // re-run forecast with the new factor
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update focus factor');
      if (forecast) setFocusInput(forecast.focusFactor); // revert visible value
    } finally {
      setSavingFocus(false);
    }
  };

  // Merge store versions (authoritative list, includes empty ones) with
  // the forecast rows (richer stats for versions that have linked leaves).
  // We iterate over versions in release order (compareVersions — target
  // date ascending, undated last, same authority the forecast chain uses),
  // attaching the forecast row when it exists — versions with 0 leaves
  // show up as "no scope" rows.
  const sortedVersions = useMemo(
    () => [...versions].sort(compareVersions),
    [versions],
  );
  const forecastById = useMemo(() => {
    const map = new Map<string, ReleaseForecastRow>();
    for (const r of forecast?.releases ?? []) map.set(r.versionId, r);
    return map;
  }, [forecast]);
  const displayVersions = useMemo(() => {
    if (!activeVersionFilter) return sortedVersions;
    return sortedVersions.filter((v) => v.id === activeVersionFilter);
  }, [sortedVersions, activeVersionFilter]);

  const totalLeaves = useMemo(
    () =>
      displayVersions.reduce((sum, v) => sum + (forecastById.get(v.id)?.leaves ?? 0), 0),
    [displayVersions, forecastById],
  );

  const startCreate = () => {
    setFormState({ mode: 'create', fields: emptyFields() });
  };
  const startEdit = (v: Version) => {
    setFormState({ mode: 'edit', id: v.id, fields: fieldsFromVersion(v) });
  };
  const cancelForm = () => setFormState(null);

  const submitForm = async () => {
    if (!formState) return;
    const { name, description, status, targetDate } = formState.fields;
    if (!name.trim()) return;
    setSubmitting(true);
    try {
      const payload = {
        name: name.trim(),
        description: description.trim() ? description.trim() : null,
        status,
        targetDate: targetDate ? targetDate : null,
      };
      if (formState.mode === 'create') {
        await createVersionAction(payload);
      } else {
        await updateVersionAction(formState.id, payload);
      }
      setFormState(null);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (v: Version) => {
    const msg =
      `Delete version "${v.name}"?\n\n` +
      `Any nodes tagged with this version will be unassigned. This cannot be undone.`;
    if (!window.confirm(msg)) return;
    await deleteVersionAction(v.id);
  };

  if (!currentMapId) {
    return (
      <div style={containerStyle}>
        <EmptyState title="No map open" message="Open a map to see its releases." />
      </div>
    );
  }

  // The version list comes from the store and renders immediately; only the
  // forecast columns wait for the (potentially slow) forecast fetch.
  const forecastPending = loading && !forecast;

  const unit = forecast?.effortUnit ?? 'days';
  const fudge = forecast?.fudgeFactor ?? null;

  return (
    <div style={containerStyle}>
      <div style={headerStyle}>
        <div>
          <h2 style={{ margin: 0, fontSize: 16, color: '#1e293b' }}>Releases</h2>
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
            {displayVersions.length} version{displayVersions.length === 1 ? '' : 's'} · {totalLeaves} linked leaves
            {forecast && (
              <>
                {' · sequential by target date, '}
                {forecast.dailyCapacity} {unit}/day capacity
                {fudge != null && ` · ${fudge.toFixed(2)}× velocity`}
                {forecast.focusFactor < 1 && ` · ${Math.round(forecast.focusFactor * 100)}% focus`}
                {' · snapshot '}
                {formatAge(forecast.lastSnapshotAt)}
              </>
            )}
            {forecastPending && ' · loading forecast…'}
            {activeVersionFilter && ' · filtered'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label
            title="Focus factor — fraction of calendar time reaching planned work. Below 100% stretches the velocity-adjusted finish to absorb meetings, support and unplanned work."
            style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#64748b', fontWeight: 600 }}
          >
            Focus
            <input
              type="number"
              min={5}
              max={100}
              step={5}
              disabled={savingFocus || !forecast}
              value={Math.round(focusInput * 100)}
              onChange={(e) => {
                const pct = Number(e.target.value);
                if (!Number.isNaN(pct)) setFocusInput(Math.min(100, Math.max(5, pct)) / 100);
              }}
              onBlur={() => commitFocus(focusInput)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
              style={{
                width: 52,
                padding: '3px 6px',
                fontSize: 12,
                border: '1px solid #cbd5e1',
                borderRadius: 4,
                background: savingFocus ? '#f1f5f9' : '#fff',
              }}
            />
            <span>%</span>
          </label>
          <button
            onClick={startCreate}
            disabled={formState !== null}
            style={primaryButtonStyle(formState !== null)}
          >
            + New version
          </button>
          <button
            onClick={handleRefresh}
            disabled={refreshing || !forecast}
            title="Recompute and write a fresh snapshot"
            style={secondaryButtonStyle(refreshing)}
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && (
        <div style={{ padding: '10px 24px', color: '#991b1b', fontSize: 12, background: '#fef2f2' }}>
          {error}
        </div>
      )}

      {formState && (
        <VersionForm
          mode={formState.mode}
          fields={formState.fields}
          submitting={submitting}
          onChange={(fields) =>
            setFormState((s) => (s ? ({ ...s, fields } as FormState) : s))
          }
          onCancel={cancelForm}
          onSubmit={submitForm}
        />
      )}

      {displayVersions.length === 0 ? (
        <EmptyState
          title="No versions yet"
          message={'Click "+ New version" above to create one.'}
        />
      ) : (
        <div style={{ overflow: 'auto', flex: 1 }}>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Release</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle} title="Projected start — where the release above it is projected to finish. Releases chain because they share one team: nothing starts until the previous one is done.">Start</th>
                <th style={thStyle} title="The date you committed to. Set by hand (edit action or update_version) — never derived from scope. Compare it against Projected to see whether the plan is covered by the numbers.">Target</th>
                <th style={thStyle} title="Velocity-adjusted finish: remaining effort ÷ measured net rate, chained across releases in target-date order. The net rate is measured from real history and already includes rework and idle days — it is not the raw estimate sum.">Projected (velocity)</th>
                <th style={thStyle} title="Independent second model: open leaves ÷ net ticket completion rate. Counts tickets instead of summing estimates, so unestimated work still weighs in. Diverging hard from the velocity column means the estimate scale has drifted from ticket granularity.">Ticket model</th>
                <th style={thStyle} title="Projected (velocity) minus Target. Green = ahead of the committed date, red = late.">Slip</th>
                <th style={{ ...thStyle, width: 220 }}>Scope</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Leaves</th>
                <th style={{ ...thStyle, width: 92, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {displayVersions.map((v) => {
                const row = forecastById.get(v.id);
                const isArchived = v.status === 'archived';
                const isReleased = v.status === 'released';
                const projected = row
                  ? row.velocityAdjustedFinishDate ?? row.plannedFinishDate ?? null
                  : null;
                const slipDays = row ? row.slipVelocityDays ?? row.slipPlannedDays ?? null : null;
                const slip = formatSlip(slipDays);
                const pct =
                  row && row.totalEffort > 0
                    ? Math.round(((row.totalEffort - row.remainingEffort) / row.totalEffort) * 100)
                    : 0;
                const duration = formatDateRange(row?.effectiveStartDate ?? null, projected);

                return (
                  <tr
                    key={v.id}
                    style={{
                      borderBottom: '1px solid #f1f5f9',
                      opacity: isArchived || isReleased ? 0.55 : 1,
                    }}
                  >
                    <td style={tdStyle}>
                      <div style={{ fontWeight: 600, color: '#1e293b' }}>{v.name}</div>
                      {v.description && (
                        <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
                          {v.description}
                        </div>
                      )}
                    </td>
                    <td style={tdStyle}>
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 600,
                          padding: '2px 8px',
                          borderRadius: 4,
                          background: VERSION_STATUS_COLOR[v.status] + '20',
                          color: VERSION_STATUS_COLOR[v.status],
                          textTransform: 'uppercase',
                          letterSpacing: 0.3,
                        }}
                      >
                        {VERSION_STATUS_LABEL[v.status]}
                      </span>
                    </td>
                    <td style={tdStyle}>{formatDate(row?.effectiveStartDate ?? null)}</td>
                    <td style={tdStyle}>{formatDate(v.targetDate)}</td>
                    <td style={tdStyle}>
                      <div>{formatDate(projected)}</div>
                      {row &&
                        (() => {
                          const trend = formatTrend(
                            row.velocityFinishDeltaDays7d ?? row.plannedFinishDeltaDays7d,
                          );
                          if (trend) {
                            return (
                              <div
                                style={{
                                  fontSize: 10,
                                  color: trend.color,
                                  marginTop: 2,
                                  fontWeight: 500,
                                }}
                              >
                                {trend.text}
                              </div>
                            );
                          }
                          if (duration !== '—') {
                            return (
                              <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 2 }}>
                                {duration}
                              </div>
                            );
                          }
                          return null;
                        })()}
                    </td>
                    <td style={tdStyle}>
                      <div>{formatDate(row?.ticketModelFinishDate ?? null)}</div>
                      {row && row.ticketModelFinishDate && (
                        <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 2 }}>
                          {row.remainingTickets} open
                        </div>
                      )}
                    </td>
                    <td style={{ ...tdStyle, color: slip.color, fontWeight: 500 }}>{slip.text}</td>
                    <td style={tdStyle}>
                      {row ? (
                        <>
                          <ProgressBar pct={pct} />
                          <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 2 }}>
                            {row.remainingEffort.toFixed(0)}/{row.totalEffort.toFixed(0)} {unit} remaining
                          </div>
                        </>
                      ) : (
                        <span style={{ fontSize: 11, color: '#94a3b8' }}>
                          {forecastPending ? '…' : 'No scope yet'}
                        </span>
                      )}
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'right', color: '#64748b', fontSize: 11 }}>
                      {row ? (
                        <>
                          {row.leaves}
                          {row.noEstimateLeaves > 0 && (
                            <div
                              style={{ fontSize: 10, color: '#f59e0b' }}
                              title={`${row.noEstimateLeaves} leaves without estimate`}
                            >
                              {row.noEstimateLeaves} unest.
                            </div>
                          )}
                        </>
                      ) : forecastPending ? (
                        '…'
                      ) : (
                        '0'
                      )}
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'right' }}>
                      <div style={{ display: 'inline-flex', gap: 4 }}>
                        <button
                          onClick={() => startEdit(v)}
                          disabled={formState !== null}
                          title="Edit version"
                          style={iconButtonStyle(formState !== null)}
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleDelete(v)}
                          disabled={formState !== null}
                          title="Delete version"
                          style={iconDangerButtonStyle(formState !== null)}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────

function VersionForm({
  mode,
  fields,
  submitting,
  onChange,
  onCancel,
  onSubmit,
}: {
  mode: 'create' | 'edit';
  fields: FormFields;
  submitting: boolean;
  onChange: (fields: FormFields) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const canSubmit = fields.name.trim().length > 0 && !submitting;
  return (
    <div
      style={{
        padding: '14px 24px',
        borderBottom: '1px solid #e2e8f0',
        background: '#f8fafc',
        display: 'grid',
        gridTemplateColumns: '2fr 1fr 1fr 1fr auto',
        gap: 10,
        alignItems: 'end',
      }}
    >
      <div>
        <label style={labelStyle}>Name</label>
        <input
          autoFocus
          type="text"
          placeholder="e.g. V1, Beta launch"
          value={fields.name}
          onChange={(e) => onChange({ ...fields, name: e.target.value })}
          style={inputStyle}
        />
      </div>
      <div>
        <label style={labelStyle}>Status</label>
        <select
          value={fields.status}
          onChange={(e) => onChange({ ...fields, status: e.target.value as Version['status'] })}
          style={inputStyle}
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {VERSION_STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label style={labelStyle}>Target date</label>
        <input
          type="date"
          value={fields.targetDate}
          onChange={(e) => onChange({ ...fields, targetDate: e.target.value })}
          style={inputStyle}
        />
      </div>
      <div>
        <label style={labelStyle}>Description</label>
        <input
          type="text"
          placeholder="Optional"
          value={fields.description}
          onChange={(e) => onChange({ ...fields, description: e.target.value })}
          style={inputStyle}
        />
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={onCancel} disabled={submitting} style={secondaryButtonStyle(submitting)}>
          Cancel
        </button>
        <button onClick={onSubmit} disabled={!canSubmit} style={primaryButtonStyle(!canSubmit)}>
          {submitting ? 'Saving…' : mode === 'create' ? 'Create' : 'Save'}
        </button>
      </div>
    </div>
  );
}

function ProgressBar({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div
        style={{
          flex: 1,
          height: 6,
          background: '#e2e8f0',
          borderRadius: 3,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${clamped}%`,
            height: '100%',
            background: '#3b82f6',
            transition: 'width 0.3s',
          }}
        />
      </div>
      <span style={{ fontSize: 11, color: '#64748b', minWidth: 36, textAlign: 'right' }}>
        {clamped}%
      </span>
    </div>
  );
}

function EmptyState({ title, message }: { title: string; message: string }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 1,
        padding: 40,
        color: '#64748b',
        textAlign: 'center',
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600, color: '#1e293b', marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 12 }}>{message}</div>
    </div>
  );
}

// ── Styles ───────────────────────────────────────────────────────

const containerStyle: React.CSSProperties = {
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  background: '#ffffff',
  fontFamily: 'inherit',
};

const headerStyle: React.CSSProperties = {
  padding: '16px 24px',
  borderBottom: '1px solid #e2e8f0',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
};

const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 12,
};

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '10px 16px',
  fontSize: 10,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  color: '#64748b',
  borderBottom: '1px solid #e2e8f0',
  background: '#f8fafc',
  position: 'sticky',
  top: 0,
};

const tdStyle: React.CSSProperties = {
  padding: '12px 16px',
  fontSize: 12,
  color: '#334155',
  verticalAlign: 'top',
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 10,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  color: '#64748b',
  marginBottom: 4,
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '6px 10px',
  fontSize: 12,
  fontFamily: 'inherit',
  border: '1px solid #cbd5e1',
  borderRadius: 6,
  background: '#fff',
  color: '#1e293b',
};

function primaryButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: '6px 12px',
    borderRadius: 6,
    border: '1px solid #3b82f6',
    background: disabled ? '#93c5fd' : '#3b82f6',
    color: '#fff',
    fontSize: 12,
    fontWeight: 500,
    fontFamily: 'inherit',
    cursor: disabled ? 'default' : 'pointer',
  };
}

function secondaryButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: '6px 12px',
    borderRadius: 6,
    border: '1px solid #e2e8f0',
    background: disabled ? '#f1f5f9' : '#fff',
    color: disabled ? '#94a3b8' : '#1e293b',
    fontSize: 12,
    fontWeight: 500,
    fontFamily: 'inherit',
    cursor: disabled ? 'default' : 'pointer',
  };
}

function iconButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: '4px 8px',
    borderRadius: 4,
    border: '1px solid #e2e8f0',
    background: '#fff',
    color: disabled ? '#cbd5e1' : '#334155',
    fontSize: 11,
    fontWeight: 500,
    fontFamily: 'inherit',
    cursor: disabled ? 'default' : 'pointer',
  };
}

function iconDangerButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: '4px 8px',
    borderRadius: 4,
    border: '1px solid #fecaca',
    background: '#fff',
    color: disabled ? '#fca5a5' : '#b91c1c',
    fontSize: 11,
    fontWeight: 500,
    fontFamily: 'inherit',
    cursor: disabled ? 'default' : 'pointer',
  };
}
