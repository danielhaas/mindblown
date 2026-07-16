/**
 * Plan-health panel — surface 2 of the plan linter (docs/plan-linter.md).
 *
 * Pull-based coaching: fetched when the panel opens, never pushed. Each
 * finding teaches the principle it enforces (the "why" line) and links
 * back to the node on the map. Dismissals are per-(node, rule); a whole
 * rule can be muted for the map. Quiet by default — no toasts, no badges
 * until the user asks.
 */
import { useCallback, useEffect, useState } from 'react';
import * as api from './api.js';
import { useMindmapStore } from './store.js';

const PANEL_WIDTH = 380;

const SEVERITY_STYLE: Record<'warn' | 'info', { label: string; color: string; bg: string }> = {
  warn: { label: 'warning', color: '#b45309', bg: '#fef3c7' },
  info: { label: 'suggestion', color: '#1d4ed8', bg: '#dbeafe' },
};

export function PlanHealthPanel({ mapId, onClose }: { mapId: string; onClose: () => void }) {
  const selectNode = useMindmapStore((s) => s.selectNode);
  const setFocusNode = useMindmapStore((s) => s.setFocusNode);
  const setActiveView = useMindmapStore((s) => s.setActiveView);
  const nodes = useMindmapStore((s) => s.nodes);
  const rootNodeId = useMindmapStore((s) => s.rootNodeId);

  const [report, setReport] = useState<api.LintReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDismissed, setShowDismissed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setReport(await api.fetchLint(mapId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to run the plan check');
    } finally {
      setLoading(false);
    }
  }, [mapId]);

  useEffect(() => {
    void load();
  }, [load]);

  const jumpToNode = (nodeId: string) => {
    const node = nodes[nodeId];
    setActiveView('mindmap');
    selectNode(nodeId);
    setFocusNode(node?.parentId && node.parentId !== rootNodeId ? node.parentId : null);
    (window as unknown as { __mindmapPanToNode?: (id: string) => void }).__mindmapPanToNode?.(nodeId);
  };

  const dismiss = async (ruleId: string, nodeId: string | null) => {
    await api.dismissLintFinding(mapId, ruleId, nodeId);
    await load();
  };
  const undismiss = async (ruleId: string, nodeId: string | null) => {
    await api.undismissLintFinding(mapId, ruleId, nodeId);
    await load();
  };

  const activeRules = (report?.rules ?? []).filter(
    (r) => !r.skipped && !r.ruleMuted && (r.activeCount > 0 || (showDismissed && r.dismissedCount > 0)),
  );
  const cleanRules = (report?.rules ?? []).filter(
    (r) => !r.skipped && !r.ruleMuted && r.activeCount === 0 && !(showDismissed && r.dismissedCount > 0),
  );
  const mutedRules = (report?.rules ?? []).filter((r) => r.ruleMuted);
  const skippedRules = (report?.rules ?? []).filter((r) => r.skipped);
  const allClear = report != null && report.warnCount + report.infoCount === 0;

  return (
    <div
      style={{
        width: PANEL_WIDTH,
        height: '100%',
        borderLeft: '1px solid #e2e8f0',
        background: '#ffffff',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '12px 16px',
          borderBottom: '1px solid #e2e8f0',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span style={{ fontSize: 16 }}>🩺</span>
        <span style={{ fontSize: 14, fontWeight: 700, color: '#1e293b', flex: 1 }}>
          Plan health
          {report && (
            <span style={{ marginLeft: 8, fontSize: 12, color: '#94a3b8', fontWeight: 500 }}>
              {report.warnCount} warning{report.warnCount === 1 ? '' : 's'} · {report.infoCount}{' '}
              suggestion{report.infoCount === 1 ? '' : 's'}
            </span>
          )}
        </span>
        <button
          onClick={() => void load()}
          disabled={loading}
          title="Re-run the checks"
          style={{
            background: 'none',
            border: 'none',
            cursor: loading ? 'default' : 'pointer',
            padding: 4,
            color: '#94a3b8',
            fontSize: 14,
            fontFamily: 'inherit',
            lineHeight: 1,
          }}
        >
          ↻
        </button>
        <button
          onClick={onClose}
          title="Close"
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: 4,
            color: '#94a3b8',
            fontSize: 16,
            fontFamily: 'inherit',
            lineHeight: 1,
          }}
        >
          x
        </button>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
        {loading && !report && (
          <div style={{ fontSize: 12, color: '#94a3b8' }}>Checking the plan…</div>
        )}
        {error && (
          <div style={{ fontSize: 12, color: '#dc2626' }}>
            {error}{' '}
            <button
              onClick={() => void load()}
              style={{
                background: 'none',
                border: 'none',
                color: '#4f46e5',
                cursor: 'pointer',
                fontSize: 12,
                fontFamily: 'inherit',
                padding: 0,
                textDecoration: 'underline',
              }}
            >
              retry
            </button>
          </div>
        )}

        {allClear && !loading && !error && (
          <div style={{ fontSize: 13, color: '#16a34a', padding: '8px 0' }}>
            ✓ The plan is in good shape — every check passed.
          </div>
        )}

        {activeRules.map((r) => {
          const sev = SEVERITY_STYLE[r.severity];
          const visible = r.findings.filter((f) => (showDismissed ? true : !f.dismissed));
          return (
            <div key={r.ruleId} style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: sev.color,
                    background: sev.bg,
                    borderRadius: 3,
                    padding: '1px 6px',
                    textTransform: 'uppercase',
                    letterSpacing: 0.4,
                  }}
                >
                  {sev.label}
                </span>
                <span style={{ fontSize: 12, fontWeight: 700, color: '#1e293b', flex: 1 }}>
                  {r.title}
                  <span style={{ marginLeft: 6, color: '#94a3b8', fontWeight: 500 }}>
                    {r.activeCount}
                  </span>
                </span>
                <button
                  onClick={() => void dismiss(r.ruleId, null)}
                  title="Mute this check for this map"
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    color: '#cbd5e1',
                    fontSize: 12,
                    fontFamily: 'inherit',
                    padding: 2,
                  }}
                >
                  🔕
                </button>
              </div>
              <div style={{ fontSize: 11, color: '#64748b', fontStyle: 'italic', marginBottom: 2 }}>
                {r.why}
              </div>
              <div style={{ fontSize: 11, color: '#64748b', marginBottom: 6 }}>Fix: {r.fix}</div>
              {visible.map((f, i) => (
                <div
                  key={`${f.nodeId ?? 'map'}-${i}`}
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 6,
                    padding: '3px 0',
                    opacity: f.dismissed ? 0.45 : 1,
                  }}
                >
                  {f.nodeId ? (
                    <button
                      onClick={() => jumpToNode(f.nodeId!)}
                      title="Show on the map"
                      style={{
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        color: '#4f46e5',
                        fontSize: 12,
                        fontFamily: 'inherit',
                        padding: 0,
                        textAlign: 'left',
                        flex: 1,
                        textDecoration: f.dismissed ? 'line-through' : 'none',
                      }}
                    >
                      {f.nodeText ?? f.nodeId}
                      {f.priority && (
                        <span style={{ color: '#94a3b8', marginLeft: 4 }}>[{f.priority}]</span>
                      )}
                      <span style={{ color: '#94a3b8', marginLeft: 4 }}>— {f.detail}</span>
                    </button>
                  ) : (
                    <span style={{ fontSize: 12, color: '#334155', flex: 1 }}>{f.detail}</span>
                  )}
                  {f.dismissed ? (
                    <button
                      onClick={() => void undismiss(r.ruleId, f.nodeId)}
                      title="Restore this finding"
                      style={{
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        color: '#94a3b8',
                        fontSize: 11,
                        fontFamily: 'inherit',
                        padding: 0,
                      }}
                    >
                      undo
                    </button>
                  ) : (
                    <button
                      onClick={() => void dismiss(r.ruleId, f.nodeId)}
                      title="Dismiss this finding"
                      style={{
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        color: '#cbd5e1',
                        fontSize: 12,
                        fontFamily: 'inherit',
                        padding: 0,
                        lineHeight: 1,
                      }}
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
            </div>
          );
        })}

        {/* Footer chips: clean / muted / skipped */}
        {report && cleanRules.length > 0 && (
          <div style={{ fontSize: 11, color: '#16a34a', marginTop: 8 }}>
            ✓ Clean: {cleanRules.map((r) => r.ruleId).join(', ')}
          </div>
        )}
        {mutedRules.length > 0 && (
          <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 6 }}>
            🔕 Muted:{' '}
            {mutedRules.map((r, i) => (
              <span key={r.ruleId}>
                {i > 0 && ', '}
                {r.ruleId}{' '}
                <button
                  onClick={() => void undismiss(r.ruleId, null)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#4f46e5',
                    cursor: 'pointer',
                    fontSize: 11,
                    fontFamily: 'inherit',
                    padding: 0,
                    textDecoration: 'underline',
                  }}
                >
                  unmute
                </button>
              </span>
            ))}
          </div>
        )}
        {skippedRules.length > 0 && (
          <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 6 }}>
            ⚠ Skipped: {skippedRules.map((r) => `${r.ruleId} (${r.skipped})`).join(', ')}
          </div>
        )}

        {report && (report.rules.some((r) => r.dismissedCount > 0) || showDismissed) && (
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 11,
              color: '#94a3b8',
              marginTop: 12,
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={showDismissed}
              onChange={(e) => setShowDismissed(e.target.checked)}
              style={{ margin: 0 }}
            />
            Show dismissed findings
          </label>
        )}
      </div>
    </div>
  );
}
