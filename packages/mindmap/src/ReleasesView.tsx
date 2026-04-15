import { useEffect, useMemo, useState } from 'react';
import type { Version } from '@mindblown/core';
import { useMindmapStore } from './store.js';
import * as api from './api.js';
import type { ForecastResult } from './api.js';

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

// ── Types ────────────────────────────────────────────────────────

interface ReleaseRow {
  version: Version;
  forecast: ForecastResult | null;
  error: string | null;
}

// ── Helpers ──────────────────────────────────────────────────────

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatSlip(days: number | null): { text: string; color: string } {
  if (days == null) return { text: '—', color: '#94a3b8' };
  if (days === 0) return { text: 'on target', color: '#f59e0b' };
  if (days < 0) return { text: `${Math.abs(days)}d ahead`, color: '#10b981' };
  return { text: `${days}d late`, color: '#ef4444' };
}

// ── Component ────────────────────────────────────────────────────

export function ReleasesView() {
  const currentMapId = useMindmapStore((s) => s.currentMapId);
  const versions = useMindmapStore((s) => s.versions);
  const activeVersionFilter = useMindmapStore((s) => s.activeVersionFilter);

  const [rows, setRows] = useState<ReleaseRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!currentMapId || versions.length === 0) {
        setRows([]);
        return;
      }
      setLoading(true);
      setError(null);

      // Apply the top-bar filter if set, otherwise show all
      const scoped = activeVersionFilter
        ? versions.filter((v) => v.id === activeVersionFilter)
        : versions;

      const sorted = [...scoped].sort((a, b) => {
        // Active first, then planning, then released, then archived;
        // within a status, by sortOrder then by target date then name.
        const statusOrder = { active: 0, planning: 1, released: 2, archived: 3 };
        if (a.status !== b.status) return statusOrder[a.status] - statusOrder[b.status];
        if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
        if (a.targetDate && b.targetDate) return a.targetDate.localeCompare(b.targetDate);
        if (a.targetDate) return -1;
        if (b.targetDate) return 1;
        return a.name.localeCompare(b.name);
      });

      setRows(sorted.map((v) => ({ version: v, forecast: null, error: null })));

      const loaded = await Promise.all(
        sorted.map(async (v) => {
          try {
            const forecast = await api.fetchForecast(currentMapId, { versionId: v.id });
            return { version: v, forecast, error: null } as ReleaseRow;
          } catch (e) {
            return {
              version: v,
              forecast: null,
              error: e instanceof Error ? e.message : 'Failed to forecast',
            } as ReleaseRow;
          }
        }),
      );

      if (!cancelled) {
        setRows(loaded);
        setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [currentMapId, versions, activeVersionFilter]);

  const totalLeaves = useMemo(
    () => rows.reduce((sum, r) => sum + (r.forecast?.leaves ?? 0), 0),
    [rows],
  );

  if (!currentMapId) {
    return (
      <div style={containerStyle}>
        <EmptyState title="No map open" message="Open a map to see its releases." />
      </div>
    );
  }

  if (versions.length === 0) {
    return (
      <div style={containerStyle}>
        <EmptyState
          title="No releases yet"
          message="Create a version to plan releases — use create_version via the MCP or the command palette."
        />
      </div>
    );
  }

  if (loading && rows.length === 0) {
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

  return (
    <div style={containerStyle}>
      <div style={headerStyle}>
        <div>
          <h2 style={{ margin: 0, fontSize: 16, color: '#1e293b' }}>Releases</h2>
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
            {rows.length} version{rows.length === 1 ? '' : 's'} · {totalLeaves} linked leaves
            {activeVersionFilter && ' · filtered'}
          </div>
        </div>
      </div>

      <div style={{ overflow: 'auto', flex: 1 }}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Release</th>
              <th style={thStyle}>Status</th>
              <th style={thStyle}>Target</th>
              <th style={thStyle}>Projected</th>
              <th style={thStyle}>Slip</th>
              <th style={{ ...thStyle, width: 200 }}>Scope</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Leaves</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const { version, forecast } = row;
              const projected =
                forecast?.velocityAdjustedFinishDate ?? forecast?.plannedFinishDate ?? null;
              // Prefer velocity slip (matches the Projected column);
              // fall back to planned slip.
              const slipDays =
                forecast?.slipVelocityDays ?? forecast?.slipPlannedDays ?? null;
              const slip = formatSlip(slipDays);
              const isArchived = version.status === 'archived';
              const remaining = forecast?.remainingEffort ?? 0;
              const total = forecast?.totalEffort ?? 0;
              const unit = forecast?.effortUnit ?? 'units';
              const pct = total > 0 ? Math.round(((total - remaining) / total) * 100) : 0;

              return (
                <tr
                  key={version.id}
                  style={{
                    borderBottom: '1px solid #f1f5f9',
                    opacity: isArchived ? 0.55 : 1,
                  }}
                >
                  <td style={tdStyle}>
                    <div style={{ fontWeight: 600, color: '#1e293b' }}>{version.name}</div>
                    {version.description && (
                      <div
                        style={{
                          fontSize: 11,
                          color: '#64748b',
                          marginTop: 2,
                          maxWidth: 400,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                        title={version.description}
                      >
                        {version.description}
                      </div>
                    )}
                    {row.error && (
                      <div style={{ fontSize: 10, color: '#991b1b', marginTop: 2 }}>
                        {row.error}
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
                        background: VERSION_STATUS_COLOR[version.status] + '20',
                        color: VERSION_STATUS_COLOR[version.status],
                        textTransform: 'uppercase',
                        letterSpacing: 0.3,
                      }}
                    >
                      {VERSION_STATUS_LABEL[version.status]}
                    </span>
                  </td>
                  <td style={tdStyle}>{formatDate(version.targetDate)}</td>
                  <td style={tdStyle}>{formatDate(projected)}</td>
                  <td style={{ ...tdStyle, color: slip.color, fontWeight: 500 }}>{slip.text}</td>
                  <td style={tdStyle}>
                    <ProgressBar pct={pct} />
                    <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 2 }}>
                      {remaining.toFixed(0)}/{total.toFixed(0)} {unit} remaining
                    </div>
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right', color: '#64748b', fontSize: 11 }}>
                    {forecast?.leaves ?? '—'}
                    {forecast && forecast.noEstimateLeaves > 0 && (
                      <div
                        style={{ fontSize: 10, color: '#f59e0b' }}
                        title={`${forecast.noEstimateLeaves} leaves without estimate`}
                      >
                        {forecast.noEstimateLeaves} unest.
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
