import { useEffect, useState } from 'react';
import * as api from '../api.js';
import type { MapDetail, MapSummary, NodeWithComputed } from '../api.js';
import { MobileListView } from './MobileListView.js';
import { MobileKanbanView } from './MobileKanbanView.js';
import { MobileGanttView } from './MobileGanttView.js';
import { MobileMindmapView } from './MobileMindmapView.js';
import { MobileNodeDetailSheet } from './MobileNodeDetailSheet.js';

type ViewKey = 'list' | 'kanban' | 'gantt' | 'mindmap';

const VIEW_KEY = 'mb_mobile_view';

function readDefaultView(): ViewKey {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    if (v === 'list' || v === 'kanban' || v === 'gantt' || v === 'mindmap') return v;
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
  const [reloadTick, setReloadTick] = useState(0);

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
  }, [map.id, reloadTick]);

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
        {(['list', 'kanban', 'gantt', 'mindmap'] as const).map((k) => (
          <button
            key={k}
            role="tab"
            aria-selected={view === k}
            onClick={() => setViewPersist(k)}
            className="mb-view-tab"
          >
            {k === 'list'
              ? 'List'
              : k === 'kanban'
                ? 'Kanban'
                : k === 'gantt'
                  ? 'Gantt'
                  : 'Mindmap'}
          </button>
        ))}
        <button
          className="mb-view-refresh"
          onClick={() => setReloadTick((t) => t + 1)}
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
        </>
      )}

      {selectedNode && (
        <MobileNodeDetailSheet
          node={selectedNode}
          map={detail!.map}
          byId={byId}
          onClose={() => setSelectedId(null)}
        />
      )}
    </>
  );
}
