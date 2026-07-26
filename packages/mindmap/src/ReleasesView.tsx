import { Fragment, useEffect, useMemo, useState } from 'react';
import { compareVersions } from '@mindblown/core';
import type { Version } from '@mindblown/core';
import { useMindmapStore } from './store.js';
import * as api from './api.js';
import type {
  ReleaseForecastResponse,
  ReleaseForecastRow,
  ReleaseCompositionResponse,
  ReleaseCompositionRow,
} from './api.js';

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

const CONFIDENCE_STYLE: Record<
  ReleaseForecastRow['confidence']['level'],
  { label: string; icon: string; color: string }
> = {
  agree: { label: 'models agree', icon: '✓', color: '#10b981' },
  caution: { label: 'read with care', icon: '⚠', color: '#f59e0b' },
  unmeasured: { label: 'unverified', icon: '·', color: '#94a3b8' },
};

/**
 * The one-line under-label. Deliberately the *cause*, not a restatement of
 * the badge — the badge says how much to trust the date, this says why.
 */
function summariseConfidence(c: ReleaseForecastRow['confidence']): string {
  if (c.unestimatedOpenLeaves > 0) {
    return `${c.unestimatedOpenLeaves} open task${c.unestimatedOpenLeaves === 1 ? '' : 's'} unestimated`;
  }
  if (c.divergenceDays != null && c.level === 'caution') {
    const dir = c.divergenceDays > 0 ? 'later' : 'earlier';
    return `ticket model ${Math.abs(c.divergenceDays)}d ${dir}`;
  }
  if (c.level === 'unmeasured') return 'no cross-check available';
  return 'every open leaf estimated';
}

/**
 * Negative slip is BUFFER, not "ahead". "Ahead" claims the release is
 * running early — a statement about progress. All the number actually says
 * is that the committed date sits later than the projection, which is room
 * you deliberately left yourself. Calling it "ahead" invites spending it.
 */
function formatSlip(days: number | null): { text: string; color: string } {
  if (days == null) return { text: '—', color: '#94a3b8' };
  if (days === 0) return { text: 'no buffer', color: '#f59e0b' };
  if (days < 0) return { text: `Buffer ${Math.abs(days)}d`, color: '#10b981' };
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
  // Compact by default: the table answers "when does it ship and are we on
  // track". Everything that only explains WHY the number is what it is sits
  // behind the toggle.
  const [showDetail, setShowDetail] = useState<boolean>(
    () => globalThis.localStorage?.getItem('mb.releases.detail') === '1',
  );
  useEffect(() => {
    globalThis.localStorage?.setItem('mb.releases.detail', showDetail ? '1' : '0');
  }, [showDetail]);

  // Composition — what the release holds besides its requirements.
  // Off by default and fetched only once switched on: the table above
  // answers "when does it ship", and that question must not get slower
  // because a second one exists.
  const [showComposition, setShowComposition] = useState<boolean>(
    () => globalThis.localStorage?.getItem('mb.releases.composition') === '1',
  );
  useEffect(() => {
    globalThis.localStorage?.setItem('mb.releases.composition', showComposition ? '1' : '0');
  }, [showComposition]);
  const [composition, setComposition] = useState<ReleaseCompositionResponse | null>(null);
  const [compositionLoading, setCompositionLoading] = useState(false);
  const [compositionError, setCompositionError] = useState<string | null>(null);
  const [expandedComposition, setExpandedComposition] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!showComposition || !currentMapId) return;
    let cancelled = false;
    setCompositionLoading(true);
    setCompositionError(null);
    api
      .fetchReleaseComposition(currentMapId, { limit: 40 })
      .then((r) => {
        if (!cancelled) setComposition(r);
      })
      .catch((e) => {
        if (!cancelled) {
          setCompositionError(e instanceof Error ? e.message : 'Failed to load composition');
        }
      })
      .finally(() => {
        if (!cancelled) setCompositionLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [showComposition, currentMapId, versions, refreshNonce]);

  const compositionById = useMemo(() => {
    const m = new Map<string, ReleaseCompositionRow>();
    for (const r of composition?.releases ?? []) m.set(r.versionId, r);
    return m;
  }, [composition]);

  // Release, Status, Target, Projected, Confidence, Buffer/Slip, Scope,
  // Actions — plus Start, Ticket model and Tasks when Detail is on.
  const columnCount = 8 + (showDetail ? 3 : 0);

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

  /** True when a measured net rate drives the forecast — the focus knob is then inert. */
  const measuredRateActive = (forecast?.netEffortPerDay ?? 0) > 0;

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
            {displayVersions.length} version{displayVersions.length === 1 ? '' : 's'} · {totalLeaves} linked tasks
            {forecast && (
              <>
                {' · sequential by target date, '}
                {measuredRateActive
                  ? `${forecast.netEffortPerDay!.toFixed(2)} ${unit}/day measured`
                  : `${forecast.dailyCapacity} ${unit}/day capacity`}
                {showDetail && fudge != null && ` · ${fudge.toFixed(2)}× velocity`}
                {showDetail && forecast.focusFactor < 1 && ` · ${Math.round(forecast.focusFactor * 100)}% focus`}
                {' · snapshot '}
                {formatAge(forecast.lastSnapshotAt)}
              </>
            )}
            {forecastPending && ' · loading forecast…'}
            {activeVersionFilter && ' · filtered'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            onClick={() => setShowDetail((v) => !v)}
            title={
              showDetail
                ? 'Hide the columns that explain how the projection was derived.'
                : 'Show start dates, the ticket model, planned finish and task counts.'
            }
            style={{
              padding: '4px 10px',
              fontSize: 11,
              fontWeight: 600,
              color: showDetail ? '#2563eb' : '#64748b',
              background: showDetail ? '#eff6ff' : '#fff',
              border: `1px solid ${showDetail ? '#bfdbfe' : '#cbd5e1'}`,
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >
            {showDetail ? '▾ Detail' : '▸ Detail'}
          </button>
          <button
            onClick={() => setShowComposition((v) => !v)}
            title={
              showComposition
                ? 'Hide the requirement / other-work split.'
                : 'Show what each release holds besides its requirements — bugs, infra, cleanup and features nobody specified.'
            }
            style={{
              padding: '4px 10px',
              fontSize: 11,
              fontWeight: 600,
              color: showComposition ? '#2563eb' : '#64748b',
              background: showComposition ? '#eff6ff' : '#fff',
              border: `1px solid ${showComposition ? '#bfdbfe' : '#cbd5e1'}`,
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >
            {showComposition ? '▾ Composition' : '▸ Composition'}
          </button>
          {showDetail && (
          <label
            title={
              measuredRateActive
                ? 'Focus factor — INACTIVE on this map. A measured delivery rate is available, and measurement overrides the knob; this value changes nothing until the rate can no longer be measured.'
                : 'Focus factor — fraction of calendar time reaching planned work. Below 100% stretches the velocity-adjusted finish to absorb meetings, support and unplanned work.'
            }
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 11,
              color: '#64748b',
              fontWeight: 600,
              opacity: measuredRateActive ? 0.55 : 1,
            }}
          >
            Focus{measuredRateActive && ' (inactive)'}
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
          )}
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
                {showDetail && (
                  <th style={thStyle} title="Projected start — where the release above it is projected to finish. Releases chain because they share one team: nothing starts until the previous one is done.">Start</th>
                )}
                <th style={thStyle} title="The date you committed to. Set by hand (edit action or update_version) — never derived from scope. Compare it against Projected to see whether the plan is covered by the numbers.">Target</th>
                <th style={thStyle} title="Velocity-adjusted finish: remaining effort ÷ measured net rate, chained across releases in target-date order. The net rate is measured from real history and already includes rework and idle days — it is not the raw estimate sum.">Projected (velocity)</th>
                <th style={thStyle} title="How much to trust the projected date. Cross-checks it against an independent model that counts open tasks instead of summing estimates, and flags open work that carries no estimate at all. Hover a row's badge for the reason.">Confidence</th>
                {showDetail && (
                  <th style={thStyle} title="The independent second model, as a date: open tasks ÷ net task completion rate. Counts tasks instead of summing estimates, so unestimated work still weighs in. The Confidence column is the verdict this feeds.">Ticket model</th>
                )}
                <th style={thStyle} title="Target minus Projected (velocity). Green = buffer, the room left between the projection and the date you committed to. Red = the projection has already passed the target. Buffer is not progress — it is unspent room.">Buffer / Slip</th>
                <th style={{ ...thStyle, width: 220 }}>Scope</th>
                {showDetail && <th style={{ ...thStyle, textAlign: 'right' }}>Tasks</th>}
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
                  <Fragment key={v.id}>
                  <tr
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
                    {showDetail && (
                      <td style={tdStyle}>{formatDate(row?.effectiveStartDate ?? null)}</td>
                    )}
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
                      {row ? (
                        (() => {
                          const c = CONFIDENCE_STYLE[row.confidence.level];
                          return (
                            <div title={row.confidence.note}>
                              <span
                                style={{
                                  fontSize: 10,
                                  fontWeight: 600,
                                  padding: '2px 8px',
                                  borderRadius: 4,
                                  background: c.color + '20',
                                  color: c.color,
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                {c.icon} {c.label}
                              </span>
                              <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 2 }}>
                                {summariseConfidence(row.confidence)}
                              </div>
                            </div>
                          );
                        })()
                      ) : (
                        <span style={{ fontSize: 11, color: '#94a3b8' }}>—</span>
                      )}
                    </td>
                    {showDetail && (
                      <td style={tdStyle}>
                        <div>{formatDate(row?.ticketModelFinishDate ?? null)}</div>
                        {row && row.ticketModelFinishDate && (
                          <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 2 }}>
                            {row.remainingTickets} open
                          </div>
                        )}
                      </td>
                    )}
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
                    {showDetail && (
                      <td style={{ ...tdStyle, textAlign: 'right', color: '#64748b', fontSize: 11 }}>
                        {row ? (
                          <>
                            {row.leaves}
                            {/* Only OPEN unestimated work distorts anything — closed
                                tasks with no estimate are noise in this warning. */}
                            {row.unestimatedOpenLeaves > 0 && (
                              <div
                                style={{ fontSize: 10, color: '#f59e0b' }}
                                title={`${row.unestimatedOpenLeaves} open task(s) without estimate — remaining effort is a floor. (${row.noEstimateLeaves} unestimated in total, the rest are already complete.)`}
                              >
                                {row.unestimatedOpenLeaves} unest. open
                              </div>
                            )}
                          </>
                        ) : forecastPending ? (
                          '…'
                        ) : (
                          '0'
                        )}
                      </td>
                    )}
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
                  {showComposition && (
                    <CompositionRow
                      colSpan={columnCount}
                      unit={unit}
                      row={compositionById.get(v.id) ?? null}
                      loading={compositionLoading}
                      error={compositionError}
                      expanded={expandedComposition.has(v.id)}
                      onToggle={() =>
                        setExpandedComposition((prev) => {
                          const next = new Set(prev);
                          if (next.has(v.id)) next.delete(v.id);
                          else next.add(v.id);
                          return next;
                        })
                      }
                    />
                  )}
                  </Fragment>
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

const REQ_COLOR = '#2563eb';
const OTHER_COLOR = '#e0871a';

/**
 * The composition strip under a release row: how much of the release
 * implements a requirement, and what the rest is.
 *
 * The bar is scaled by TICKET COUNT, not effort. Effort would be the
 * better unit if the estimates were complete; they are not, and a bar
 * that silently drops every unestimated ticket would understate exactly
 * the pile this strip exists to show. Effort is printed next to the
 * counts instead, with its own unestimated warning.
 */
function CompositionRow({
  colSpan,
  unit,
  row,
  loading,
  error,
  expanded,
  onToggle,
}: {
  colSpan: number;
  unit: string;
  row: ReleaseCompositionRow | null;
  loading: boolean;
  error: string | null;
  expanded: boolean;
  onToggle: () => void;
}) {
  const cell: React.CSSProperties = {
    padding: '10px 12px 14px',
    borderBottom: '1px solid #f1f5f9',
    background: '#fafbfc',
  };

  if (error) {
    return (
      <tr>
        <td colSpan={colSpan} style={{ ...cell, fontSize: 11, color: '#dc2626' }}>
          Composition unavailable: {error}
        </td>
      </tr>
    );
  }

  if (!row) {
    return (
      <tr>
        <td colSpan={colSpan} style={{ ...cell, fontSize: 11, color: '#94a3b8' }}>
          {loading ? 'Loading composition…' : 'No composition data'}
        </td>
      </tr>
    );
  }

  const reqCount = row.requirementWork.count;
  const otherCount = row.otherWork.count;
  const total = reqCount + otherCount;

  if (total === 0) {
    return (
      <tr>
        <td colSpan={colSpan} style={{ ...cell, fontSize: 11, color: '#94a3b8' }}>
          Nothing scheduled for this release yet — no coverage to report.
        </td>
      </tr>
    );
  }

  const reqPct = (reqCount / total) * 100;
  const reqDonePct = reqCount ? ((reqCount - row.requirementWork.openCount) / reqCount) * 100 : 0;
  const otherDonePct = otherCount
    ? ((otherCount - row.otherWork.openCount) / otherCount) * 100
    : 0;
  const totalEffort = row.requirementWork.effort + row.otherWork.effort;
  const unestimated = row.requirementWork.unestimated + row.otherWork.unestimated;

  return (
    <tr>
      {/* The strip is a reading surface, not a data grid — past ~1100px
          the label/number pairs drift so far apart they stop reading as
          pairs. Cap it and let the rest of the row breathe. */}
      <td colSpan={colSpan} style={cell}>
        <div style={{ maxWidth: 1100 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6 }}>
          <button
            onClick={onToggle}
            style={{
              padding: 0,
              border: 'none',
              background: 'none',
              cursor: 'pointer',
              fontSize: 11,
              fontWeight: 600,
              color: '#475569',
            }}
          >
            {expanded ? '▾' : '▸'} Composition
          </button>
          <span
            style={{ fontSize: 11, color: '#64748b' }}
            title="Share of this release's tasks that implement a requirement — either sitting beneath one, or sharing its GitHub issue."
          >
            <b style={{ color: row.coveragePct != null && row.coveragePct < 50 ? '#b45309' : '#166534' }}>
              {row.coveragePct}%
            </b>{' '}
            requirement coverage
          </span>
          <span style={{ fontSize: 11, color: '#94a3b8' }}>
            {total} tasks · {totalEffort.toFixed(0)} {unit} estimated
            {unestimated > 0 && ` · ${unestimated} unestimated`}
          </span>
        </div>

        <div
          style={{
            display: 'flex',
            height: 20,
            borderRadius: 4,
            overflow: 'hidden',
            background: '#e2e8f0',
          }}
        >
          <Segment
            widthPct={reqPct}
            donePct={reqDonePct}
            color={REQ_COLOR}
            label={`Requirements · ${reqCount}`}
            title={`${reqCount} task(s) implementing a requirement — ${row.requirementWork.openCount} still open, ${row.requirementWork.effort.toFixed(1)} ${unit} estimated.`}
          />
          <Segment
            widthPct={100 - reqPct}
            donePct={otherDonePct}
            color={OTHER_COLOR}
            label={`Other work · ${otherCount}`}
            title={`${otherCount} task(s) attributing to no requirement — ${row.otherWork.openCount} still open, ${row.otherWork.effort.toFixed(1)} ${unit} estimated.`}
          />
        </div>

        {expanded && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
              gap: 20,
              marginTop: 14,
            }}
          >
            <div>
              <ColumnHeading>Requirements in this release</ColumnHeading>
              {row.byRequirement.length === 0 ? (
                <Muted>None — every task here attributes to no requirement.</Muted>
              ) : (
                row.byRequirement.slice(0, 10).map((r) => (
                  <div key={r.nodeId} style={{ display: 'flex', gap: 8, fontSize: 11, padding: '2px 0' }}>
                    <span style={{ fontWeight: 600, color: '#475569', minWidth: 62 }}>
                      {r.requirementId ?? '—'}
                    </span>
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        color: '#334155',
                      }}
                      title={r.text}
                    >
                      {r.text}
                    </span>
                    <span style={{ color: '#94a3b8', whiteSpace: 'nowrap' }}>
                      {r.count} · {r.openCount} open
                    </span>
                  </div>
                ))
              )}
              {row.byRequirement.length > 10 && (
                <Muted>+ {row.byRequirement.length - 10} more requirements</Muted>
              )}
            </div>

            <div>
              <ColumnHeading>Other work — what is it?</ColumnHeading>
              {row.byClassification.map((c) => (
                <div key={c.label} style={{ display: 'flex', gap: 8, fontSize: 11, padding: '2px 0' }}>
                  <span
                    style={{ flex: 1, color: c.label === 'unclassified' ? '#94a3b8' : '#334155' }}
                    title={
                      c.label === 'unclassified'
                        ? 'No `type:` tag on these tasks. Classification comes from GitHub labels, never from guessing at the title — so untagged work stays honestly unlabelled.'
                        : undefined
                    }
                  >
                    {c.label}
                  </span>
                  <span style={{ color: '#94a3b8', whiteSpace: 'nowrap' }}>
                    {c.count} · {c.effort.toFixed(1)} {unit} · {c.openCount} open
                  </span>
                </div>
              ))}

              <ColumnHeading style={{ marginTop: 12 }}>
                Unattributed, worst first
              </ColumnHeading>
              {row.unattributed.slice(0, 12).map((u) => (
                <div key={u.nodeId} style={{ display: 'flex', gap: 6, fontSize: 11, padding: '2px 0' }}>
                  <span style={{ color: '#94a3b8', minWidth: 30, textAlign: 'right' }}>
                    {u.progress}%
                  </span>
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      color: '#334155',
                    }}
                    title={u.text}
                  >
                    {u.text}
                  </span>
                  {u.url && (
                    <a
                      href={u.url}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: '#2563eb', textDecoration: 'none', whiteSpace: 'nowrap' }}
                    >
                      {u.externalId?.split('#')[1] ? `#${u.externalId.split('#')[1]}` : 'issue'}
                    </a>
                  )}
                </div>
              ))}
              {row.unattributedTotal > Math.min(12, row.unattributed.length) && (
                <Muted>
                  + {row.unattributedTotal - Math.min(12, row.unattributed.length)} more unattributed
                </Muted>
              )}
            </div>
          </div>
        )}
        </div>
      </td>
    </tr>
  );
}

/** One half of the split bar; the saturated part is what is already done. */
function Segment({
  widthPct,
  donePct,
  color,
  label,
  title,
}: {
  widthPct: number;
  donePct: number;
  color: string;
  label: string;
  title: string;
}) {
  if (widthPct <= 0) return null;
  return (
    <div
      title={title}
      style={{ position: 'relative', width: `${widthPct}%`, background: `${color}33`, minWidth: 2 }}
    >
      <div
        style={{ position: 'absolute', inset: 0, right: 'auto', width: `${donePct}%`, background: color }}
      />
      {widthPct > 14 && (
        <div
          style={{
            position: 'relative',
            fontSize: 10,
            fontWeight: 600,
            color: '#fff',
            lineHeight: '20px',
            padding: '0 6px',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textShadow: '0 1px 2px rgba(0,0,0,.35)',
          }}
        >
          {label}
        </div>
      )}
    </div>
  );
}

function ColumnHeading({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        fontSize: 10,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        color: '#94a3b8',
        marginBottom: 4,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, color: '#94a3b8', padding: '2px 0' }}>{children}</div>;
}

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
