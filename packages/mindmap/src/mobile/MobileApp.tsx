import { useEffect, useState } from 'react';
import { useMindmapStore } from '../store.js';
import { AuthScreen } from '../AuthScreen.js';
import { MobileMapList } from './MobileMapList.js';
import { MobileViewer } from './MobileViewer.js';
import type { MapSummary } from '../api.js';
import './mobile.css';

export function MobileApp() {
  const user = useMindmapStore((s) => s.user);
  const checkAuth = useMindmapStore((s) => s.checkAuth);

  const [selectedMap, setSelectedMap] = useState<MapSummary | null>(null);

  useEffect(() => {
    document.body.classList.add('mobile');
    return () => {
      document.body.classList.remove('mobile');
    };
  }, []);

  useEffect(() => {
    void checkAuth();
  }, [checkAuth]);

  if (!user) {
    return (
      <div className="mb-mobile">
        <AuthScreen />
      </div>
    );
  }

  if (!selectedMap) {
    return (
      <div className="mb-mobile">
        <div className="mb-topbar">
          <span style={{ width: 60 }} />
          <div className="mb-topbar-title">MindBlown</div>
          <button
            className="mb-topbar-btn"
            onClick={() => useMindmapStore.getState().logout()}
          >
            Sign out
          </button>
        </div>
        <MobileMapList onPick={setSelectedMap} />
      </div>
    );
  }

  return (
    <div className="mb-mobile">
      <div className="mb-topbar">
        <button
          className="mb-topbar-btn"
          onClick={() => setSelectedMap(null)}
        >
          ← Maps
        </button>
        <div className="mb-topbar-title">{selectedMap.name}</div>
        <span style={{ width: 60 }} />
      </div>
      <MobileViewer map={selectedMap} />
    </div>
  );
}
