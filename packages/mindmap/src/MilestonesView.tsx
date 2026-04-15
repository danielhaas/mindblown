import { useEffect, useMemo, useState } from 'react';
import type { HealthSignal, Milestone } from '@mindblown/core';
import { useMindmapStore } from './store.js';
import * as api from './api.js';
import type { ForecastResult, MilestoneDetail } from './api.js';

// ── Colors ───────────────────────────────────────────────────────

const HEALTH_DOT: Record<HealthSignal, string> = {
  on_track: '#10b981',
  at_risk: '#f59e0b',
  behind: '#ef4444',
};

const HEALTH_LABEL: Record<HealthSignal, string> = {
  on_track: 'On Track',
  at_risk: 'At Risk',
  behind: 'Behind',
};

// ── Types ────────────────────────────────────────────────────────

interface MilestoneRow {
  milestone: Milestone;
  detail: MilestoneDetail | null;
  forecast: ForecastResult | null;
  error: string | null;
}

// ── Helpers ──────────────────────────────────────────────────────

function rollupHealth(detail: MilestoneDetail | null): HealthSignal {
  if (!detail || detail.nodes.length === 0) return 'on_track';
  let worst: HealthSignal = 'on_track';
  for (const n of detail.nodes) {
    if (n.healthSignal === 'behind') return 'behind';
    if (n.healthSignal === 'at_risk') worst = 'at_risk';
  }
  return worst;
}

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

export function MilestonesView() {
  const currentMap = useMindmapStore((s) => s.currentMap);
  const currentMapId = useMindmapStore((s) => s.currentMapId);
  const versions = useMindmapStore((s) => s.versions);
  const activeVersionFilter = useMindmapStore((s) => s.activeVersionFilter);

  const [rows, setRows] = useState<MilestoneRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const workspaceId = currentMap?.workspaceId ?? null;

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!workspaceId || !currentMapId) {
        setRows([]);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const milestones = await api.fetchMilestones(
          workspaceId,
          activeVersionFilter ?? undefined,
        );
        if (cancelled) return;

        const sorted = [...milestones].sort((a, b) => {
          // Open first, then by target date (nulls last), then name
          if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
          if (a.targetDate && b.targetDate) return a.targetDate.localeCompare(b.targetDate);
          if (a.targetDate) return -1;
          if (b.targetDate) return 1;
          return a.name.localeCompare(b.name);
        });

        const initial: MilestoneRow[] = sorted.map((m) => ({
          milestone: m,
          detail: null,
          forecast: null,
          error: null,
        }));
        setRows(initial);

        const loaded = await Promise.all(
          sorted.map(async (m) => {
            try {
              const [detail, forecast] = await Promise.all([
                api.fetchMilestoneDetail(m.id),
                api.fetchForecast(currentMapId, { milestoneId: m.id }),
              ]);
              return { milestone: m, detail, forecast, error: null } as MilestoneRow;
            } catch (e) {
              return {
                milestone: m,
                detail: null,
                forecast: null,
                error: e instanceof Error ? e.message : 'Failed to load',
              } as MilestoneRow;
            }
          }),
        );

        if (!cancelled) setRows(loaded);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load milestones');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, currentMapId, activeVersionFilter]);

  const versionNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const v of versions) map.set(v.id, v.name);
    return map;
  }, [versions]);

  if (!currentMapId) {
    return (
      <div style={containerStyle}>
        <EmptyState title="No map open" message="Open a map to see its milestones." />
      </div>
    );
  }

  if (loading && rows.length === 0) {
    return (
      <div style={containerStyle}>
        <div style={{ padding: 40, color: '#64748b', fontSize: 13 }}>Loading milestones…</div>
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

  if (rows.length === 0) {
    return (
      <div style={containerStyle}>
        <EmptyState
          title="No milestones yet"
          message={
            activeVersionFilter
              ? 'This version has no milestones. Create one from the Version panel.'
              : 'Create a milestone to track key deliverables and their ETAs.'
          }
        />
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      <div style={headerStyle}>
        <div>
          <h2 style={{ margin: 0, fontSize: 16, color: '#1e293b' }}>Milestones</h2>
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
            {rows.length} milestone{rows.length === 1 ? '' : 's'}
            {activeVersionFilter && ` · filtered to ${versionNameById.get(activeVersionFilter) ?? 'version'}`}
          </div>
        </div>
      </div>

      <div style={{ overflow: 'auto', flex: 1 }}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Milestone</th>
              <th style={thStyle}>Version</th>
              <th style={thStyle}>Target</th>
              <th style={thStyle}>Projected</th>
              <th style={thStyle}>Slip</th>
              <th style={{ ...thStyle, width: 180 }}>Progress</th>
              <th style={thStyle}>Health</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Nodes</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const { milestone, detail, forecast } = row;
              const health = rollupHealth(detail);
              const progressPct = detail?.progress ?? 0;
              const projected =
                forecast?.velocityAdjustedFinishDate ?? forecast?.plannedFinishDate ?? null;
              // Prefer velocity slip (it matches the projected column); fall back to planned.
              const slipDays =
                forecast?.slipVelocityDays ?? forecast?.slipPlannedDays ?? null;
              const slip = formatSlip(slipDays);
              const versionName = milestone.versionId
                ? versionNameById.get(milestone.versionId) ?? '—'
                : '—';
              const isClosed = milestone.status === 'closed';

              return (
                <tr
                  key={milestone.id}
                  style={{
                    borderBottom: '1px solid #f1f5f9',
                    opacity: isClosed ? 0.55 : 1,
                  }}
                >
                  <td style={tdStyle}>
                    <div style={{ fontWeight: 600, color: '#1e293b' }}>
                      {milestone.name}
                      {isClosed && (
                        <span
                          style={{
                            marginLeft: 6,
                            fontSize: 9,
                            fontWeight: 500,
                            padding: '1px 5px',
                            borderRadius: 3,
                            background: '#e2e8f0',
                            color: '#64748b',
                            textTransform: 'uppercase',
                          }}
                        >
                          closed
                        </span>
                      )}
                    </div>
                    {milestone.description && (
                      <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
                        {milestone.description}
                      </div>
                    )}
                    {row.error && (
                      <div style={{ fontSize: 10, color: '#991b1b', marginTop: 2 }}>
                        {row.error}
                      </div>
                    )}
                  </td>
                  <td style={tdStyle}>
                    <span style={{ fontSize: 11, color: '#64748b' }}>{versionName}</span>
                  </td>
                  <td style={tdStyle}>{formatDate(milestone.targetDate)}</td>
                  <td style={tdStyle}>{formatDate(projected)}</td>
                  <td style={{ ...tdStyle, color: slip.color, fontWeight: 500 }}>{slip.text}</td>
                  <td style={tdStyle}>
                    <ProgressBar pct={progressPct} />
                  </td>
                  <td style={tdStyle}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          background: HEALTH_DOT[health],
                          display: 'inline-block',
                        }}
                      />
                      <span style={{ fontSize: 11, color: '#475569' }}>{HEALTH_LABEL[health]}</span>
                    </div>
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right', color: '#64748b', fontSize: 11 }}>
                    {detail?.totalNodes ?? '—'}
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
        {clamped.toFixed(0)}%
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
