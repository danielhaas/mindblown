/**
 * Fleet journal route + window parsing. The loader is stubbed; what is
 * pinned here is the contract the Fleet tab and `fleet_journal` rely on:
 * the default window, the 400s, and that from/to reach the loader as
 * Dates.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const loadMock = vi.fn();
vi.mock('../../services/fleetJournal.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/fleetJournal.js')>();
  return { ...actual, loadFleetJournal: (...args: unknown[]) => loadMock(...args) };
});

import { fleetJournalRoutes } from '../fleetJournal.js';
import { parseJournalWindow } from '../../services/fleetJournal.js';

const MAP_ID = 'mmmm-mmmm-mmmm-mmmm';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(fleetJournalRoutes);
  return app;
}

beforeEach(() => {
  loadMock.mockReset();
  loadMock.mockResolvedValue({ window: { from: 'a', to: 'b' }, ticks: [], delivered: [], totals: { ticks: 0 } });
});

describe('GET /api/maps/:id/fleet-journal', () => {
  it('passes an explicit window to the loader as Dates and returns the journal + server clock', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/maps/${MAP_ID}/fleet-journal?from=2026-09-02T15:00:00Z&to=2026-09-03T05:00:00Z` });
    await app.close();
    expect(res.statusCode).toBe(200);
    const [mapId, from, to] = loadMock.mock.calls[0] as [string, Date, Date];
    expect(mapId).toBe(MAP_ID);
    expect(from.toISOString()).toBe('2026-09-02T15:00:00.000Z');
    expect(to.toISOString()).toBe('2026-09-03T05:00:00.000Z');
    expect(res.json().journal.totals.ticks).toBe(0);
    expect(typeof res.json().now).toBe('string');
  });

  it('defaults to the trailing 24 h', async () => {
    const app = await buildApp();
    const before = Date.now();
    const res = await app.inject({ method: 'GET', url: `/api/maps/${MAP_ID}/fleet-journal` });
    await app.close();
    expect(res.statusCode).toBe(200);
    const [, from, to] = loadMock.mock.calls[0] as [string, Date, Date];
    expect(to.getTime()).toBeGreaterThanOrEqual(before);
    expect(to.getTime() - from.getTime()).toBe(24 * 3_600_000);
  });

  it('refuses a bad date, an inverted window and one over 31 days', async () => {
    const app = await buildApp();
    const bad = await app.inject({ method: 'GET', url: `/api/maps/${MAP_ID}/fleet-journal?from=yesterday` });
    const inverted = await app.inject({ method: 'GET', url: `/api/maps/${MAP_ID}/fleet-journal?from=2026-09-03T00:00:00Z&to=2026-09-02T00:00:00Z` });
    const long = await app.inject({ method: 'GET', url: `/api/maps/${MAP_ID}/fleet-journal?from=2026-07-01T00:00:00Z&to=2026-09-02T00:00:00Z` });
    await app.close();
    expect([bad.statusCode, inverted.statusCode, long.statusCode]).toEqual([400, 400, 400]);
    expect(loadMock).not.toHaveBeenCalled();
  });
});

describe('parseJournalWindow', () => {
  it('from defaults to to − 24 h when only to is given', () => {
    const w = parseJournalWindow({ to: '2026-09-03T05:00:00Z' });
    expect('error' in w).toBe(false);
    if ('error' in w) return;
    expect(w.from.toISOString()).toBe('2026-09-02T05:00:00.000Z');
  });
});
