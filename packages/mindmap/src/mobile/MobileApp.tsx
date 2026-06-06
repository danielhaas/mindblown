import { useEffect, useState } from 'react';
import { useMindmapStore } from '../store.js';
import { AuthScreen } from '../AuthScreen.js';
import { MobileMapList } from './MobileMapList.js';
import { MobileCapture } from './MobileCapture.js';
import { MobileReady } from './MobileReady.js';
import type { MapSummary } from '../api.js';
import './mobile.css';

type Screen = 'list' | 'capture' | 'ready';

function readShareTarget(): string {
  if (typeof window === 'undefined') return '';
  const params = new URLSearchParams(window.location.search);
  const text = params.get('share') ?? params.get('text') ?? '';
  const url = params.get('url') ?? '';
  const title = params.get('title') ?? '';
  return [title, text, url].filter(Boolean).join('\n').trim();
}

function clearShareTarget(): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  ['share', 'text', 'url', 'title'].forEach((k) => url.searchParams.delete(k));
  window.history.replaceState({}, '', url.pathname + url.search + url.hash);
}

export function MobileApp() {
  const user = useMindmapStore((s) => s.user);
  const checkAuth = useMindmapStore((s) => s.checkAuth);

  const [screen, setScreen] = useState<Screen>('list');
  const [selectedMap, setSelectedMap] = useState<MapSummary | null>(null);
  const [sharePrefill, setSharePrefill] = useState<string>('');

  useEffect(() => {
    document.body.classList.add('mobile');
    return () => {
      document.body.classList.remove('mobile');
    };
  }, []);

  useEffect(() => {
    void checkAuth();
  }, [checkAuth]);

  useEffect(() => {
    if (!user) return;
    const text = readShareTarget();
    if (text) {
      setSharePrefill(text);
      clearShareTarget();
    }
  }, [user]);

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
        <MobileMapList
          onPick={(m) => {
            setSelectedMap(m);
            setScreen('capture');
          }}
        />
      </div>
    );
  }

  const consumePrefill = () => {
    const v = sharePrefill;
    setSharePrefill('');
    return v;
  };

  return (
    <div className="mb-mobile">
      <div className="mb-topbar">
        <button
          className="mb-topbar-btn"
          onClick={() => {
            setSelectedMap(null);
            setScreen('list');
          }}
        >
          ← Maps
        </button>
        <div className="mb-topbar-title">{selectedMap.name}</div>
        <span style={{ width: 60 }} />
      </div>
      {screen === 'capture' && (
        <MobileCapture
          map={selectedMap}
          initialProse={sharePrefill}
          onConsumePrefill={consumePrefill}
        />
      )}
      {screen === 'ready' && <MobileReady map={selectedMap} />}
      <div className="mb-tabbar">
        <button
          aria-current={screen === 'capture' ? 'page' : undefined}
          onClick={() => setScreen('capture')}
        >
          Capture
        </button>
        <button
          aria-current={screen === 'ready' ? 'page' : undefined}
          onClick={() => setScreen('ready')}
        >
          Ready
        </button>
      </div>
    </div>
  );
}
