import crypto from 'node:crypto';
import type { Node as CoreNode, MindMap, Version, Cycle } from '@mindblown/core';
import type { ReleaseForecastResult } from './releaseForecast.js';

const CRLF = '\r\n';
const TOKEN_PREFIX = 'v1';

// ── HMAC-signed per-map token ───────────────────────────────────
//
// Per-map share: anyone holding the URL can read the feed. The
// token is hmac(JWT_SECRET, "v1:<mapId>") base64url-encoded, so
// there is no DB row to manage and rotating JWT_SECRET invalidates
// every outstanding feed at once.
export function calendarTokenFor(mapId: string, secret: string): string {
  const h = crypto.createHmac('sha256', secret);
  h.update(`${TOKEN_PREFIX}:${mapId}`);
  return `${TOKEN_PREFIX}.${h.digest('base64url')}`;
}

export function verifyCalendarToken(
  mapId: string,
  token: string | undefined,
  secret: string,
): boolean {
  if (!token || !token.startsWith(`${TOKEN_PREFIX}.`)) return false;
  const expected = calendarTokenFor(mapId, secret);
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── ICS formatting helpers ──────────────────────────────────────

const escapeText = (s: string): string =>
  s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');

// RFC 5545 line folding: lines longer than 75 octets must be split,
// with continuation lines starting with a single space.
const fold = (line: string): string => {
  if (line.length <= 75) return line;
  const parts: string[] = [line.slice(0, 75)];
  let remaining = line.slice(75);
  while (remaining.length > 0) {
    parts.push(' ' + remaining.slice(0, 74));
    remaining = remaining.slice(74);
  }
  return parts.join(CRLF);
};

const dateOnly = (iso: string): string => iso.slice(0, 10).replace(/-/g, '');

// DTEND for all-day events is exclusive, so inclusive endDate → +1 day.
const addOneDay = (iso: string): string => {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

const stamp = (d: Date): string =>
  d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

// ── Main builder ────────────────────────────────────────────────

export interface CalendarIcsInput {
  map: MindMap;
  nodes: CoreNode[];
  versions: Version[];
  cycles: Cycle[];
  forecast: ReleaseForecastResult;
  doneStatusIds: Set<string>;
}

export function buildCalendarIcs(input: CalendarIcsInput): string {
  const { map, nodes, versions, cycles, forecast, doneStatusIds } = input;
  const dtstamp = stamp(new Date());

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//MindBlown//Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    fold(`X-WR-CALNAME:${escapeText(`${map.name} — MindBlown`)}`),
    fold(
      `X-WR-CALDESC:${escapeText(
        'MindBlown planning feed: leaves with due dates, version targets and projected finishes, sprint ranges.',
      )}`,
    ),
  ];

  const addEvent = (event: {
    uid: string;
    summary: string;
    startDate: string;
    endDate: string;
    categories?: string[];
    status?: 'CONFIRMED' | 'TENTATIVE';
  }): void => {
    lines.push('BEGIN:VEVENT');
    lines.push(fold(`UID:${event.uid}`));
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`DTSTART;VALUE=DATE:${dateOnly(event.startDate)}`);
    lines.push(`DTEND;VALUE=DATE:${dateOnly(addOneDay(event.endDate))}`);
    lines.push(fold(`SUMMARY:${escapeText(event.summary)}`));
    if (event.categories?.length) {
      lines.push(fold(`CATEGORIES:${event.categories.map(escapeText).join(',')}`));
    }
    lines.push(`STATUS:${event.status ?? 'CONFIRMED'}`);
    lines.push('TRANSP:TRANSPARENT');
    lines.push('END:VEVENT');
  };

  // 1) Leaf nodes with a manually authored dueDate.
  for (const n of nodes) {
    if (!n.dueDate) continue;
    if ((n.childrenIds?.length ?? 0) > 0) continue;
    if (n.status && doneStatusIds.has(n.status)) continue;
    const start = n.startDate ?? n.dueDate;
    addEvent({
      uid: `node-${n.id}@mindblown`,
      summary: n.text || '(untitled task)',
      startDate: start,
      endDate: n.dueDate,
      categories: ['MindBlown task'],
    });
  }

  // 2) Per-version target and velocity-adjusted projected finish.
  for (const v of versions) {
    if (v.status === 'archived') continue;
    if (v.targetDate) {
      addEvent({
        uid: `version-target-${v.id}@mindblown`,
        summary: `${v.name} — release target`,
        startDate: v.targetDate,
        endDate: v.targetDate,
        categories: ['MindBlown release target'],
      });
    }
    const row = forecast.releases.find((r) => r.versionId === v.id);
    if (row?.velocityAdjustedFinishDate) {
      addEvent({
        uid: `version-projected-${v.id}@mindblown`,
        summary: `${v.name} — projected finish`,
        startDate: row.velocityAdjustedFinishDate,
        endDate: row.velocityAdjustedFinishDate,
        categories: ['MindBlown release projection'],
        status: 'TENTATIVE',
      });
    }
  }

  // 3) Sprint / cycle ranges.
  for (const c of cycles) {
    if (!c.startDate || !c.endDate) continue;
    addEvent({
      uid: `cycle-${c.id}@mindblown`,
      summary: `Sprint: ${c.name}`,
      startDate: c.startDate,
      endDate: c.endDate,
      categories: [`MindBlown sprint · ${c.status}`],
    });
  }

  lines.push('END:VCALENDAR');
  return lines.join(CRLF) + CRLF;
}
