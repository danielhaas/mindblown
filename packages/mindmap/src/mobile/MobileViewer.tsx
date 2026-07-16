import { useCallback, useEffect, useState } from 'react';
import * as api from '../api.js';
import type { MapDetail, MapSummary, NodeWithComputed } from '../api.js';
import { MobileListView } from './MobileListView.js';
import { MobileKanbanView } from './MobileKanbanView.js';
import { MobileGanttView } from './MobileGanttView.js';
import { MobileMindmapView } from './MobileMindmapView.js';
import { MobileRequirementsView } from './MobileRequirementsView.js';
import { MobileNodeDetailSheet } from './MobileNodeDetailSheet.js';
import { MobileAddNodeSheet } from './MobileAddNodeSheet.js';

type ViewKey = 'list' | 'kanban' | 'gantt' | 'mindmap' | 'requirements';

const VIEW_KEY = 'mb_mobile_view';

const VIEW_LABELS: Record<ViewKey, string> = {
  list: 'List',
  kanban: 'Kanban',
  gantt: 'Gantt',
  mindmap: 'Mindmap',
  requirements: 'Reqs',
};

function readDefaultView(): ViewKey {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    if (v && v in VIEW_LABELS) return v as ViewKey;
  } catch {}
  return 'list';
}

interface Props {
  map: MapSummary;
}

export function MobileViewer({ map }: Props) {
  const [detail, setDetail] = useState<MapDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewKey>(readDefaultView);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    api
      .fetchMap(map.id)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message ?? 'Failed to load map');
      });
    return () => {
      cancelled = true;
    };
  }, [map.id]);

  // Re-fetch without dropping the current detail, so edits made from the
  // node sheet update rollups in place instead of flashing "Loading map…".
  const silentReload = useCallback(() => {
    api
      .fetchMap(map.id)
      .then(setDetail)
      .catch(() => {
        // Keep showing the stale tree; the next manual refresh surfaces errors.
      });
  }, [map.id]);

  const setViewPersist = (v: ViewKey) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {}
  };

  const nodes: NodeWithComputed[] = detail?.nodes ?? [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const selectedNode = selectedId ? byId.get(selectedId) ?? null : null;

  return (
    <>
      <div className="mb-view-tabs" role="tablist">
        {(Object.keys(VIEW_LABELS) as ViewKey[]).map((k) => (
          <button
            key={k}
            role="tab"
            aria-selected={view === k}
            onClick={() => setViewPersist(k)}
            className="mb-view-tab"
          >
            {VIEW_LABELS[k]}
          </button>
        ))}
        <button
          className="mb-view-refresh"
          onClick={silentReload}
          aria-label="Refresh"
          title="Refresh"
        >
          ↻
        </button>
      </div>

      {error && (
        <div className="mb-body">
          <div className="mb-error">{error}</div>
        </div>
      )}
      {!error && !detail && (
        <div className="mb-body">
          <div style={{ color: '#64748b', textAlign: 'center', padding: 24 }}>
            Loading map…
          </div>
        </div>
      )}
      {detail && (
        <>
          {view === 'list' && (
            <MobileListView
              nodes={nodes}
              map={detail.map}
              onSelect={setSelectedId}
            />
          )}
          {view === 'kanban' && (
            <MobileKanbanView
              nodes={nodes}
              map={detail.map}
              onSelect={setSelectedId}
            />
          )}
          {view === 'gantt' && (
            <MobileGanttView
              nodes={nodes}
              map={detail.map}
              onSelect={setSelectedId}
            />
          )}
          {view === 'mindmap' && (
            <MobileMindmapView
              nodes={nodes}
              map={detail.map}
              onSelect={setSelectedId}
            />
          )}
          {view === 'requirements' && (
            <MobileRequirementsView
              nodes={nodes}
              map={detail.map}
              onSelect={setSelectedId}
            />
          )}

          <button
            className="mb-fab"
            aria-label="Add node"
            onClick={() => setAdding(true)}
          >
            +
          </button>
        </>
      )}

      {selectedNode && detail && (
        <MobileNodeDetailSheet
          node={selectedNode}
          map={detail.map}
          byId={byId}
          onClose={() => setSelectedId(null)}
          onChanged={silentReload}
        />
      )}

      {adding && detail && (
        <MobileAddNodeSheet
          nodes={nodes}
          map={detail.map}
          onClose={() => setAdding(false)}
          onCreated={silentReload}
        />
      )}
    </>
  );
}
