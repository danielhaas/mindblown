/**
 * Pace, one line — the Cockpit's Pace card shrunk to a strip for the views
 * people work in (Kanban, List). Dan: the speed should be visible in the
 * Developer view too, not only behind the PM's Today tab.
 *
 * Same numbers as the card: estimated work finished per calendar day against
 * what the plan assumes a day delivers, batch writes left out.
 */
import { useEffect, useState } from 'react';
import { summarisePace } from '@mindblown/core';
import * as api from './api.js';
import { useMindmapStore } from './store.js';
import { isTabVisible } from './roles.js';

// Same window as the Cockpit card, so both show the same numbers.
const PACE_FETCH_DAYS = 56;
const PACE_DAYS = 14;
const REFRESH_MS = 5 * 60 * 1000;

export function PaceStrip() {
  const currentMapId = useMindmapStore((s) => s.currentMapId);
  const viewRole = useMindmapStore((s) => s.viewRole);
  const setActiveView = useMindmapStore((s) => s.setActiveView);
  const [velocity, setVelocity] = useState<api.VelocityPaceResponse | null>(null);

  useEffect(() => {
    if (!currentMapId) return;
    let cancelled = false;
    setVelocity(null);
    const load = () =>
      api
        .fetchVelocity(currentMapId, PACE_FETCH_DAYS)
        .then((v) => !cancelled && setVelocity(v))
        .catch(() => {}); // the strip just stays away; the views work without it
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [currentMapId]);

  if (!velocity) return null;
  const daily = velocity.daily.slice(-PACE_DAYS);
  if (daily.every((d) => d.completed === 0) && velocity.nominalCapacity <= 0) return null;

  const unit = velocity.effortUnit === 'hours' ? 'h' : velocity.effortUnit === 'days' ? 'd' : 'pts';
  const pace = summarisePace(daily, velocity.nominalCapacity, velocity.effortUnit);
  const fmt = (n: number) => (n >= 10 ? n.toFixed(0) : n.toFixed(1));
  const max = Math.max(...daily.map((d) => d.completed), velocity.nominalCapacity, 0.0001);
  const H = 18;
  const color = pace.ratio >= 1.5 ? '#15803d' : pace.ratio > 0 && pace.ratio <= 0.67 ? '#b45309' : '#334155';
  const canOpenCockpit = isTabVisible(viewRole, 'cockpit');

  return (
    <div
      // With no planned capacity there is nothing to compare against.
      title={velocity.nominalCapacity > 0 ? pace.note : undefined}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '6px 16px',
        borderBottom: '1px solid #e2e8f0',
        background: '#f8fafc',
        fontSize: 12,
        color: '#475569',
        flexWrap: 'wrap',
      }}
    >
      <span style={{ fontWeight: 700, letterSpacing: 0.4, color: '#64748b' }}>PACE</span>
      {pace.ratio > 0 && (
        <span style={{ color, fontWeight: 600 }}>
          {pace.ratio >= 1.5
            ? `${fmt(pace.ratio)}× faster than planned`
            : pace.ratio > 0.67
              ? 'about the planned speed'
              : `${fmt(pace.ratio)}× the planned speed`}
        </span>
      )}
      <span>
        today <strong style={{ color: '#0f172a' }}>{fmt(pace.today)}{unit}</strong>
      </span>
      <span>
        7 days <strong style={{ color: '#0f172a' }}>{fmt(pace.last7)}{unit}</strong>
      </span>
      <span style={{ color: '#94a3b8' }}>plan {fmt(velocity.nominalCapacity)}{unit}/day</span>
      <span
        role="img"
        aria-label={`Estimated work finished per day, last ${daily.length} days`}
        style={{ display: 'inline-flex', alignItems: 'flex-end', gap: 2, height: H, width: 120, position: 'relative' }}
      >
        <span
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: `${(velocity.nominalCapacity / max) * H}px`,
            borderTop: '1px dashed #94a3b8',
          }}
        />
        {daily.map((d, i) => (
          <span
            key={d.day}
            title={`${d.day}: ${fmt(d.completed)}${unit} finished`}
            style={{
              flex: 1,
              height: `${Math.max(d.completed > 0 ? 2 : 0, (d.completed / max) * H)}px`,
              background: i === daily.length - 1 ? '#4f46e5' : '#c7d2fe',
              borderRadius: 1,
            }}
          />
        ))}
      </span>
      {canOpenCockpit && (
        <button
          onClick={() => setActiveView('cockpit')}
          style={{ border: 'none', background: 'none', color: '#4f46e5', cursor: 'pointer', fontSize: 12, padding: 0 }}
        >
          details
        </button>
      )}
    </div>
  );
}
