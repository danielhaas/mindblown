import { useEffect, useMemo, useState } from 'react';
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

// ── Component ────────────────────────────────────────────────────

export function ReleasesView() {
  const currentMapId = useMindmapStore((s) => s.currentMapId);
  const versions = useMindmapStore((s) => s.versions);
  const activeVersionFilter = useMindmapStore((s) => s.activeVersionFilter);

  const [forecast, setForecast] = useState<ReleaseForecastResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped by the Refresh button to re-trigger the effect.
  const [refreshNonce, setRefreshNonce] = useState(0);

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

  // Apply the top-bar filter client-side so the cumulative server math
  // remains correct across all versions — we just hide the non-matching
  // rows in the UI.
  const rows: ReleaseForecastRow[] = useMemo(() => {
    const all = forecast?.releases ?? [];
    if (!activeVersionFilter) return all;
    return all.filter((r) => r.versionId === activeVersionFilter);
  }, [forecast, activeVersionFilter]);

  const totalLeaves = useMemo(
    () => rows.reduce((sum, r) => sum + r.leaves, 0),
    [rows],
  );

  if (!currentMapId) {
    return (
      <div style={containerStyle}>
        <EmptyState title="No map open" message="Open a map to see its releases." />
      </div>
    );
  }

  if (loading && !forecast) {
    return (
      <div style={containerStyle}>
        <div style={{ padding: 40, color: '#64748b', fontSize: 13 }}>Loading releases…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={containerStyle}>
        <div style={{ padding: 40, color: '#991b1b', fontSize: 13 }}>Error: {error}</div>
      </div>
    );
  }

  if (!forecast || forecast.releases.length === 0) {
    return (
      <div style={containerStyle}>
        <EmptyState
          title="No releases yet"
          message="Create a version to plan releases — use create_version via the MCP or the command palette."
        />
      </div>
    );
  }

  const unit = forecast.effortUnit;
  const fudge = forecast.fudgeFactor;

  return (
    <div style={containerStyle}>
      <div style={headerStyle}>
        <div>
          <h2 style={{ margin: 0, fontSize: 16, color: '#1e293b' }}>Releases</h2>
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
            {rows.length} version{rows.length === 1 ? '' : 's'} · {totalLeaves} linked leaves
            {' · sequential by sortOrder, '}
            {forecast.dailyCapacity} {unit}/day capacity
            {fudge != null && ` · ${fudge.toFixed(2)}× velocity`}
            {' · snapshot '}
            {formatAge(forecast.lastSnapshotAt)}
            {activeVersionFilter && ' · filtered'}
          </div>
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          title="Recompute and write a fresh snapshot"
          style={{
            padding: '6px 12px',
            borderRadius: 6,
            border: '1px solid #e2e8f0',
            background: refreshing ? '#f1f5f9' : '#fff',
            color: refreshing ? '#94a3b8' : '#1e293b',
            fontSize: 12,
            fontWeight: 500,
            fontFamily: 'inherit',
            cursor: refreshing ? 'default' : 'pointer',
          }}
        >
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <div style={{ overflow: 'auto', flex: 1 }}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Release</th>
              <th style={thStyle}>Status</th>
              <th style={thStyle}>Start</th>
              <th style={thStyle}>Target</th>
              <th style={thStyle}>Projected</th>
              <th style={thStyle}>Slip</th>
              <th style={{ ...thStyle, width: 220 }}>Scope</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Leaves</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const projected =
                row.velocityAdjustedFinishDate ?? row.plannedFinishDate ?? null;
              // Prefer velocity slip (matches the Projected column);
              // fall back to planned slip.
              const slipDays = row.slipVelocityDays ?? row.slipPlannedDays ?? null;
              const slip = formatSlip(slipDays);
              const isArchived = row.versionStatus === 'archived';
              const isReleased = row.versionStatus === 'released';
              const pct =
                row.totalEffort > 0
                  ? Math.round(
                      ((row.totalEffort - row.remainingEffort) / row.totalEffort) * 100,
                    )
                  : 0;
              const duration = formatDateRange(row.effectiveStartDate, projected);

              return (
                <tr
                  key={row.versionId}
                  style={{
                    borderBottom: '1px solid #f1f5f9',
                    opacity: isArchived || isReleased ? 0.55 : 1,
                  }}
                >
                  <td style={tdStyle}>
                    <div style={{ fontWeight: 600, color: '#1e293b' }}>{row.versionName}</div>
                  </td>
                  <td style={tdStyle}>
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 600,
                        padding: '2px 8px',
                        borderRadius: 4,
                        background: VERSION_STATUS_COLOR[row.versionStatus] + '20',
                        color: VERSION_STATUS_COLOR[row.versionStatus],
                        textTransform: 'uppercase',
                        letterSpacing: 0.3,
                      }}
                    >
                      {VERSION_STATUS_LABEL[row.versionStatus]}
                    </span>
                  </td>
                  <td style={tdStyle}>{formatDate(row.effectiveStartDate)}</td>
                  <td style={tdStyle}>{formatDate(row.targetDate)}</td>
                  <td style={tdStyle}>
                    <div>{formatDate(projected)}</div>
                    {(() => {
                      // Prefer the velocity-adjusted trend so it matches
                      // the Projected column above; fall back to planned.
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
                  <td style={{ ...tdStyle, color: slip.color, fontWeight: 500 }}>{slip.text}</td>
                  <td style={tdStyle}>
                    <ProgressBar pct={pct} />
                    <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 2 }}>
                      {row.remainingEffort.toFixed(0)}/{row.totalEffort.toFixed(0)} {unit} remaining
                    </div>
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right', color: '#64748b', fontSize: 11 }}>
                    {row.leaves}
                    {row.noEstimateLeaves > 0 && (
                      <div
                        style={{ fontSize: 10, color: '#f59e0b' }}
                        title={`${row.noEstimateLeaves} leaves without estimate`}
                      >
                        {row.noEstimateLeaves} unest.
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────

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
        height: '100%',
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
