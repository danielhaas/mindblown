/**
 * Fleet pull (#478) against real Postgres: the weighted pick between maps
 * and the fleet cap under concurrent pulls through both routes' service
 * calls. The unit tests stub the transaction; advisory locks and the
 * conditional claim only prove themselves on a real database.
 *
 * Skipped unless FLEET_PULL_TEST_DATABASE_URL points at a THROWAWAY
 * database (it runs every migration and writes test rows):
 *
 *   createdb mindblown_fleet_pull_test
 *   FLEET_PULL_TEST_DATABASE_URL=postgresql:///mindblown_fleet_pull_test?host=/var/run/postgresql \
 *     npx vitest run src/services/__tests__/fleet-pull.db.test.ts
 *   dropdb mindblown_fleet_pull_test
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

const URL = process.env.FLEET_PULL_TEST_DATABASE_URL;

vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));

type Orchestration = typeof import('../orchestration.js');
type Pool = import('pg').Pool;

describe.skipIf(!URL)('fleet pull on Postgres (#478)', () => {
  let svc: Orchestration;
  let pool: Pool;
  const q = <R extends Record<string, unknown> = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    pool.query<R>(text, params).then((r) => r.rows);
  let fleetId = '';
  const mapIds: Record<'A' | 'B' | 'Hold' | 'Empty', string> = { A: '', B: '', Hold: '', Empty: '' };
  let all: Set<string>;

  beforeAll(async () => {
    // db/connection reads DATABASE_URL at import — point it at the throwaway DB first.
    process.env.DATABASE_URL = URL;
    const { runMigrations } = await import('../../db/migrate.js');
    await runMigrations();
    ({ pool } = await import('../../db/connection.js'));
    svc = await import('../orchestration.js');

    const [u] = await q<{ id: string }>(
      `INSERT INTO users (email, name) VALUES ('fleet-pull@example.test', 'P')
       ON CONFLICT (email) DO UPDATE SET name = 'P' RETURNING id`,
    );
    const [w] = await q<{ id: string }>(
      `INSERT INTO workspaces (name, slug, owner_id) VALUES ('W', 'fleet-pull-' || gen_random_uuid(), $1) RETURNING id`,
      [u.id],
    );
    const [f] = await q<{ id: string }>(`INSERT INTO fleets (name, owner_id, max_active_claims) VALUES ('F', $1, 100) RETURNING id`, [u.id]);
    fleetId = f.id;
    const brief = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Do it' }] }] });
    const mkMap = async (name: string, share: number, cap: number, leaves: number) => {
      const [m] = await q<{ id: string }>(
        `INSERT INTO maps (workspace_id, name, created_by, max_active_claims, fleet_id, fleet_share)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [w.id, name, u.id, cap, fleetId, share],
      );
      const [root] = await q<{ id: string }>(`INSERT INTO nodes (map_id, text, created_by) VALUES ($1, $2, $3) RETURNING id`, [m.id, name, u.id]);
      for (let i = 0; i < leaves; i++) {
        await q(
          `INSERT INTO nodes (map_id, parent_id, text, description, status, created_by) VALUES ($1, $2, $3, $4::jsonb, 'todo', $5)`,
          [m.id, root.id, `${name} ${i}`, brief, u.id],
        );
      }
      return m.id;
    };
    mapIds.A = await mkMap('A', 2, 100, 20);
    mapIds.B = await mkMap('B', 1, 100, 20);
    mapIds.Hold = await mkMap('Hold', 1, 0, 5);
    mapIds.Empty = await mkMap('Empty', 1, 100, 0);
    all = new Set(Object.values(mapIds));
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await q(`UPDATE nodes SET claimed_by_session = NULL, claimed_at = NULL WHERE map_id = ANY($1)`, [[...all]]);
    await q(`UPDATE fleets SET pull_deficits = '{}'::jsonb, max_active_claims = 100 WHERE id = $1`, [fleetId]);
  });

  const claimsIn = async (mapId: string) =>
    Number((await q<{ n: string }>(`SELECT count(*) AS n FROM nodes WHERE map_id = $1 AND claimed_by_session IS NOT NULL`, [mapId]))[0].n);

  it('grants shares 2:1 in a 2:1 ratio; the held and the empty map are skipped without blocking', async () => {
    const granted: string[] = [];
    for (let i = 0; i < 9; i++) {
      const r = await svc.pullFleetTicket(fleetId, `w${i}`, { allowedMapIds: all });
      expect(r.granted).toBe(true);
      expect(r.ticket?.mapId).toBe(r.mapId);
      granted.push(r.mapId === mapIds.A ? 'A' : r.mapId === mapIds.B ? 'B' : 'other');
      if (i === 0) {
        expect(r.maps).toEqual(
          expect.arrayContaining([
            { mapId: mapIds.Hold, name: 'Hold', reason: 'hold' },
            { mapId: mapIds.Empty, name: 'Empty', reason: 'empty' },
          ]),
        );
      }
    }
    expect(granted).toEqual(['A', 'B', 'A', 'A', 'B', 'A', 'A', 'B', 'A']);
    expect(await claimsIn(mapIds.Hold)).toBe(0);
  });

  it('mapIds narrows the pull to the declared maps', async () => {
    for (let i = 0; i < 3; i++) {
      const r = await svc.pullFleetTicket(fleetId, `w${i}`, { allowedMapIds: all, mapIds: [mapIds.B] });
      expect(r.mapId).toBe(mapIds.B);
    }
  });

  it('never takes from a map outside allowedMapIds', async () => {
    const r = await svc.pullFleetTicket(fleetId, 'w', { allowedMapIds: new Set([mapIds.B]) });
    expect(r.mapId).toBe(mapIds.B);
    const none = await svc.pullFleetTicket(fleetId, 'w', { allowedMapIds: new Set() });
    expect(none).toMatchObject({ granted: false, reason: 'empty', maps: [] });
  });

  it('the map route counts against the fleet cap too', async () => {
    await q(`UPDATE fleets SET max_active_claims = 2 WHERE id = $1`, [fleetId]);
    expect((await svc.getNextTicket(mapIds.A, 'w1')).granted).toBe(true);
    expect((await svc.pullFleetTicket(fleetId, 'w2', { allowedMapIds: all })).granted).toBe(true);
    const third = await svc.getNextTicket(mapIds.B, 'w3');
    expect(third).toMatchObject({ granted: false, reason: 'fleet_cap', fleet: { active: 2, cap: 2 } });
    expect((await svc.pullFleetTicket(fleetId, 'w4', { allowedMapIds: all })).reason).toBe('fleet_cap');
  });

  it("fleet cap 0 is no fleet-wide limit — only the maps' own caps apply", async () => {
    await q(`UPDATE fleets SET max_active_claims = 0 WHERE id = $1`, [fleetId]);
    await q(`UPDATE maps SET max_active_claims = 2 WHERE id = $1`, [mapIds.A]);
    try {
      expect((await svc.getNextTicket(mapIds.A, 'w1')).granted).toBe(true);
      expect((await svc.getNextTicket(mapIds.A, 'w2')).granted).toBe(true);
      expect((await svc.getNextTicket(mapIds.A, 'w3')).reason).toBe('cap');
      expect((await svc.pullFleetTicket(fleetId, 'w4', { allowedMapIds: all })).mapId).toBe(mapIds.B);
    } finally {
      await q(`UPDATE maps SET max_active_claims = 100 WHERE id = $1`, [mapIds.A]);
    }
  });

  it('N parallel pulls through both routes never exceed the fleet cap', async () => {
    const CAP = 5;
    await q(`UPDATE fleets SET max_active_claims = $2 WHERE id = $1`, [fleetId, CAP]);
    const pulls = Array.from({ length: 24 }, (_, i) =>
      i % 3 === 0
        ? svc.getNextTicket(mapIds.A, `p${i}`)
        : i % 3 === 1
          ? svc.getNextTicket(mapIds.B, `p${i}`)
          : svc.pullFleetTicket(fleetId, `p${i}`, { allowedMapIds: all }),
    );
    const results = await Promise.all(pulls);
    expect(results.filter((r) => r.granted)).toHaveLength(CAP);
    expect(results.filter((r) => !r.granted).every((r) => r.reason === 'fleet_cap')).toBe(true);
    expect((await claimsIn(mapIds.A)) + (await claimsIn(mapIds.B))).toBe(CAP);
  });
});
