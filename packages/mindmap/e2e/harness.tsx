/**
 * Playwright harness (#610): the real Kanban board + detail view, desktop
 * (`?shell=desktop`: KanbanView + PropertyPanel off the store's loadMap)
 * or phone (`?shell=phone`: MobileViewer, as the app renders it). Not the
 * whole App shell — no login, map list or routing — so the check needs no
 * server: the spec answers /api and the socket with page.route.
 */
import { createRoot } from 'react-dom/client';
import { useMindmapStore } from '../src/store.js';
import { KanbanView } from '../src/KanbanView.js';
import { PropertyPanel } from '../src/PropertyPanel.js';
import { MobileViewer } from '../src/mobile/MobileViewer.js';
import type { MapSummary } from '../src/api.js';
import '../src/mobile/mobile.css';

const shell = new URLSearchParams(window.location.search).get('shell') ?? 'desktop';
const mapId = 'map-1';
useMindmapStore.setState({ user: { id: 'u1', name: 'Daniel Haas', email: 'dan@example.com' } as never });

const root = createRoot(document.getElementById('root')!);
if (shell === 'phone') {
  const map = (await fetch(`/api/maps/${mapId}`).then((r) => r.json())).map as MapSummary;
  root.render(<MobileViewer map={map} />);
} else {
  await useMindmapStore.getState().loadMap(mapId);
  root.render(
    <div style={{ display: 'flex', height: '100vh' }}>
      <div style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
        <KanbanView />
      </div>
      <PropertyPanel />
    </div>,
  );
}
