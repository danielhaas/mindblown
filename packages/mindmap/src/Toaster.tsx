import { useToasts, dismissToast } from './toast.js';

/** Renders the toasts from toast.ts, top centre, above every modal. */
export function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  if (toasts.length === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        top: 12,
        left: 16,
        right: 16,
        zIndex: 10001,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 6,
        pointerEvents: 'none',
      }}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '8px 12px',
            borderRadius: 8,
            background: '#1e293b',
            color: '#f8fafc',
            fontSize: 13,
            boxShadow: '0 4px 16px rgba(15,23,42,0.25)',
            pointerEvents: 'auto',
          }}
        >
          <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: '#22c55e' }} />
          {t.href ? (
            <a href={t.href} target="_blank" rel="noreferrer" style={{ color: '#f8fafc' }}>
              {t.text}
            </a>
          ) : (
            <span>{t.text}</span>
          )}
          <button
            onClick={() => dismissToast(t.id)}
            aria-label="Dismiss"
            style={{
              flexShrink: 0,
              background: 'none',
              border: 'none',
              color: '#94a3b8',
              fontSize: 16,
              lineHeight: 1,
              padding: '0 2px',
              cursor: 'pointer',
            }}
          >
            &times;
          </button>
        </div>
      ))}
    </div>
  );
}
