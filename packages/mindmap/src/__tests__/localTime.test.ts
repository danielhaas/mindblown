/**
 * ETAs and forecast days read on the viewer's clock (#595), pinned in two
 * zones: the same instant is a different wall-clock time — and near
 * midnight a different day — in UTC and in Tokyo (UTC+9).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localDateTime, localDay } from '../localTime.js';
import { etaLabel } from '../kanban.js';
import { openReleases } from '../landing.js';
import { pickCurrentCycle } from '../roles.js';
import type { ReleaseForecastRow } from '../api.js';

const savedTz = process.env.TZ;
function inZone(tz: string) {
  beforeEach(() => { process.env.TZ = tz; });
  afterEach(() => { process.env.TZ = savedTz; });
}

// 2026-11-13 20:30 UTC = 2026-11-14 05:30 in Tokyo.
const instant = '2026-11-13T20:30:00Z';
const now = new Date('2026-11-13T18:00:00Z'); // 18:00 UTC = 03:00 next day in Tokyo

const release = (versionName: string, targetDate: string) => ({
  versionName, targetDate, versionStatus: 'active', remainingTickets: 3, leaves: 3, sortOrder: 0,
}) as unknown as ReleaseForecastRow;
const cycles = [
  { id: 'thu', startDate: '2026-11-13', endDate: '2026-11-13', status: 'planned' },
  { id: 'fri', startDate: '2026-11-14', endDate: '2026-11-14', status: 'planned' },
];

describe('in UTC', () => {
  inZone('UTC');

  it('formats the instant on the UTC clock', () => {
    expect(localDay(new Date(instant))).toBe('2026-11-13');
    expect(localDateTime(new Date(instant))).toBe('Nov 13, 2026, 20:30 UTC');
  });

  it('shows an ETA later today as a time, with the zone in the tooltip', () => {
    expect(etaLabel(instant, now)).toEqual({ short: 'ETA 20:30', full: 'ETA Nov 13, 2026, 20:30 UTC', overdue: false });
  });

  it('a release due today is not yet overdue; today\'s cycle is current', () => {
    expect(openReleases([release('Wed', '2026-11-12'), release('Thu', '2026-11-13')], now).map((r) => r.versionName))
      .toEqual(['Wed', 'Thu']);
    expect(pickCurrentCycle(cycles, now)?.id).toBe('thu');
  });
});

describe('in Tokyo (UTC+9)', () => {
  inZone('Asia/Tokyo');

  it('formats the same instant on the Tokyo clock — the next day', () => {
    expect(localDay(new Date(instant))).toBe('2026-11-14');
    expect(localDateTime(new Date(instant))).toBe('Nov 14, 2026, 05:30 GMT+9');
  });

  it('the ETA is still today for the viewer, whose day already rolled over', () => {
    expect(etaLabel(instant, now)).toEqual({ short: 'ETA 05:30', full: 'ETA Nov 14, 2026, 05:30 GMT+9', overdue: false });
  });

  it('picks the day at the viewer\'s midnight: Thursday\'s release is already overdue', () => {
    expect(openReleases([release('Wed', '2026-11-12'), release('Thu', '2026-11-13')], now).map((r) => r.versionName))
      .toEqual(['Thu', 'Wed']); // both overdue, most recent first
    expect(pickCurrentCycle(cycles, now)?.id).toBe('fri');
  });
});
