import { useEffect, useState } from 'react';
import { useMindmapStore } from './store.js';
import type { DeletedNodeSummary } from './api.js';

/**
 * Trash dialog — lists soft-deleted subtree roots for the current map.
 * Each row has a Restore button. Falls under #107 (structural undelete).
 *
 * Lossy on the GC boundary: rows older than the server's retention window
 * (30 days by default) are hard-deleted in the background and no longer
 * appear here. Linked GitHub issues are closed as not_planned only at the
 * hard-delete step, so soft-delete + restore are safe round-trips.
 */
export function TrashDialog({ onClose }: { onClose: () => void }) {
  const listDeletedNodes = useMindmapStore((s) => s.listDeletedNodes);
  const restoreNode = useMindmapStore((s) => s.restoreNode);

  const [rows, setRows] = useState<DeletedNodeSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listDeletedNodes()
      .then((res) => {
        if (!cancelled) {
          setRows(res);
          setLoading(false);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load Trash');
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [listDeletedNodes]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleRestore = async (nodeId: string, recursive: boolean) => {
    setRestoring(nodeId);
    setError(null);
    try {
      await restoreNode(nodeId, { recursive });
      setRows((current) => current.filter((r) => r.id !== nodeId));
    } catch (e: unknown) {
      // The 409 from the server when the parent is in the Trash arrives as
      // a fetch-rejection. Surface it inline so the user can retry with the
      // recursive button.
      const msg = e instanceof Error ? e.message : 'Restore failed';
      setError(msg);
    } finally {
      setRestoring(null);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.3)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: 640,
          maxWidth: '90vw',
          maxHeight: '80vh',
          background: '#fff',
          borderRadius: 12,
          boxShadow: '0 8px 32px rgba(0,0,0,0.12)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid #e5e7eb',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ fontSize: 16, fontWeight: 600 }}>Trash</div>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              fontSize: 20,
              cursor: 'pointer',
              color: '#6b7280',
            }}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {error && (
          <div
            style={{
              padding: '8px 20px',
              background: '#fef2f2',
              color: '#991b1b',
              fontSize: 13,
              borderBottom: '1px solid #fecaca',
            }}
          >
            {error}
          </div>
        )}

        <div style={{ overflow: 'auto', padding: 8 }}>
          {loading ? (
            <div style={{ padding: 20, color: '#6b7280' }}>Loading…</div>
          ) : rows.length === 0 ? (
            <div style={{ padding: 20, color: '#6b7280' }}>
              Nothing in the Trash. Deleted nodes appear here for 30 days
              before being purged permanently.
            </div>
          ) : (
            rows.map((row) => {
              const isRestoring = restoring === row.id;
              const deletedDate = new Date(row.deletedAt);
              const ago = formatRelative(deletedDate);
              return (
                <div
                  key={row.id}
                  style={{
                    padding: '10px 12px',
                    borderRadius: 8,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                    borderBottom: '1px solid #f3f4f6',
                  }}
                >
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 500,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={row.text}
                    >
                      {row.text}
                    </div>
                    <div style={{ fontSize: 12, color: '#6b7280' }}>
                      Deleted {ago}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      onClick={() => handleRestore(row.id, false)}
                      disabled={isRestoring}
                      style={primaryBtnStyle(isRestoring)}
                    >
                      {isRestoring ? 'Restoring…' : 'Restore'}
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

function formatRelative(d: Date): string {
  const diffMs = Date.now() - d.getTime();
  const min = Math.round(diffMs / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  const day = Math.round(hr / 24);
  return `${day} day${day === 1 ? '' : 's'} ago`;
}

function primaryBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: '6px 12px',
    fontSize: 13,
    background: disabled ? '#9ca3af' : '#2563eb',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    cursor: disabled ? 'not-allowed' : 'pointer',
  };
}
