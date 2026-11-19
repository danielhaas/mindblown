/**
 * Outgoing webhooks, per event, on the map's Fleet tab: what reached the
 * subscribers this hour and over 24 h, and the repeats the dedupe ledger
 * held back (the same ask / blocker / empty queue again). A loop shows as
 * a big "held back" number here instead of only in a subscriber's log.
 * Nothing renders while the map has sent nothing.
 */
import { useEffect, useState } from 'react';
import type { WebhookEventStat } from '@mindblown/core';
import * as api from './api.js';
import { Card } from './DigestView.js';

const POLL_MS = 5 * 60_000;

export function WebhookTraffic({ mapId }: { mapId: string }) {
  const [stats, setStats] = useState<WebhookEventStat[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .fetchWebhookStats(mapId)
        .then((s) => !cancelled && setStats(s))
        .catch(() => !cancelled && setStats(null));
    void load();
    const t = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [mapId]);

  if (!stats || stats.length === 0) return null;
  return (
    <div style={{ marginTop: 16 }} data-testid="webhook-traffic">
      <Card title="Webhooks sent">
        <table style={{ fontSize: 12, color: '#334155', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ color: '#64748b', textAlign: 'left' }}>
              <th style={cell}>Event</th>
              <th style={num}>This hour</th>
              <th style={num}>24 h</th>
              <th style={num} title="The same ask, blocker or empty queue again within 24 h, not sent">Repeats held back</th>
            </tr>
          </thead>
          <tbody>
            {stats.map((s) => (
              <tr key={s.event} data-testid={`webhook-traffic-${s.event}`}>
                <td style={cell}>{s.event}</td>
                <td style={num}>{s.sentLastHour}</td>
                <td style={num}>{s.sent24h}</td>
                <td style={{ ...num, color: s.suppressed24h > 0 ? '#9a3412' : undefined }}>{s.suppressed24h}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

const cell = { padding: '2px 12px 2px 0' } as const;
const num = { ...cell, textAlign: 'right' } as const;
