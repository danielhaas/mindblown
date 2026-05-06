import { useEffect, useState } from 'react';
import { useMindmapStore } from './store.js';
import { colorForUser } from './CursorPresence.js';

const STALE_AFTER_MS = 30_000;

export function PresenceBar() {
  const presence = useMindmapStore((s) => s.presence);
  const followingUserId = useMindmapStore((s) => s.followingUserId);
  const setFollowingUser = useMindmapStore((s) => s.setFollowingUser);
  const currentUserId = useMindmapStore((s) => s.user?.id ?? null);

  // Tick once a second so stale users fade out without a manual refresh.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, []);

  const now = Date.now();
  const others = Object.values(presence).filter(
    (p) => p.userId !== currentUserId && now - p.lastSeen < STALE_AFTER_MS,
  );

  if (others.length === 0 && !followingUserId) return null;

  const followed = followingUserId ? presence[followingUserId] : null;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        background: '#fff',
        border: '1px solid #e2e8f0',
        borderRadius: 6,
        padding: '3px 6px',
        boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
      }}
    >
      {followed && (
        <>
          <span style={{ fontSize: 10, fontWeight: 600, color: '#64748b' }}>
            Following
          </span>
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: colorForUser(followed.userId),
            }}
          >
            {followed.name}
          </span>
          <button
            onClick={() => setFollowingUser(null)}
            title="Stop following (or pan/zoom manually)"
            style={{
              background: 'transparent',
              border: 'none',
              color: '#94a3b8',
              cursor: 'pointer',
              padding: '0 2px',
              fontSize: 13,
              lineHeight: 1,
              fontFamily: 'inherit',
            }}
          >
            ×
          </button>
          {others.length > 0 && (
            <div style={{ width: 1, height: 14, background: '#e2e8f0' }} />
          )}
        </>
      )}

      {others.map((p) => {
        const color = colorForUser(p.userId);
        const isFollowed = p.userId === followingUserId;
        const initial = (p.name || 'U')[0].toUpperCase();
        return (
          <button
            key={p.userId}
            onClick={() => setFollowingUser(isFollowed ? null : p.userId)}
            title={isFollowed ? `Stop following ${p.name}` : `Follow ${p.name}`}
            style={{
              width: 22,
              height: 22,
              borderRadius: '50%',
              background: color,
              color: '#fff',
              fontSize: 10,
              fontWeight: 700,
              fontFamily: 'inherit',
              border: isFollowed ? '2px solid #1e293b' : '2px solid transparent',
              boxShadow: '0 1px 2px rgba(0,0,0,0.15)',
              cursor: 'pointer',
              padding: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'border-color 0.15s, transform 0.1s',
            }}
            onMouseOver={(e) => {
              e.currentTarget.style.transform = 'scale(1.1)';
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.transform = 'scale(1)';
            }}
          >
            {initial}
          </button>
        );
      })}
    </div>
  );
}
