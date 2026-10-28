import { useEffect, useState } from 'react';
import { markOffline, useOffline } from './offline.js';

function savedAt(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? ` from ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : ` from ${d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`;
}

/**
 * Pinned notice while the server can't be reached (#572): the app shows the
 * last data it saw and nothing can be saved. Once the browser reports the
 * network back, it offers a reload for fresh data.
 */
export function OfflineBanner() {
  const offline = useOffline((s) => s.offline);
  const servedFrom = useOffline((s) => s.servedFrom);
  const [networkBack, setNetworkBack] = useState(false);

  useEffect(() => {
    const goOffline = () => {
      markOffline();
      setNetworkBack(false);
    };
    const goOnline = () => setNetworkBack(true);
    if (typeof navigator !== 'undefined' && navigator.onLine === false) markOffline();
    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);
    return () => {
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
    };
  }, []);

  if (!offline) return null;

  return (
    <div
      role="status"
      style={{
        position: 'fixed',
        left: '50%',
        bottom: 16,
        transform: 'translateX(-50%)',
        zIndex: 10000,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        maxWidth: 'calc(100vw - 32px)',
        padding: '8px 12px',
        borderRadius: 8,
        background: '#1e293b',
        color: '#f8fafc',
        fontSize: 13,
        boxShadow: '0 4px 16px rgba(15,23,42,0.25)',
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: networkBack ? '#22c55e' : '#f59e0b' }} />
      <span>
        {networkBack ? (
          'Connection is back — reload for the latest data.'
        ) : (
          <>
            <strong>Offline — read-only.</strong> Showing saved data{savedAt(servedFrom)}; changes can't be saved.
          </>
        )}
      </span>
      <button
        onClick={() => window.location.reload()}
        style={{
          flexShrink: 0,
          padding: '3px 10px',
          borderRadius: 4,
          border: '1px solid #475569',
          background: 'transparent',
          color: '#f8fafc',
          fontSize: 12,
          fontFamily: 'inherit',
          cursor: 'pointer',
        }}
      >
        {networkBack ? 'Reload' : 'Retry'}
      </button>
    </div>
  );
}
