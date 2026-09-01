/**
 * updateMap audit trail (Leidang dispatch knobs).
 *
 * Every write to maxActiveClaims / dispatchGate / dispatchPolicy (and the
 * other AUDITED_MAP_FIELDS) lands as one `map.field_changed` row with
 * node_id = null, attributed to the caller. Before this the only trace of
 * "who put the fleet on hold?" was the orchestrator's own tick log — and
 * nothing at all for a PUT from a human.
 *
 * Drizzle is stubbed with the same chainable as versionAudit.test.ts, plus
 * an insert capture so the REAL events module runs (recordMapFieldChanges
 * calls recordEvent through a module-internal reference, so stubbing the
 * export would test nothing). The assertion surface is the rows inserted
 * into change_events.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
  lastSet: null as Record<string, unknown> | null,
  inserted: [] as Record<string, unknown>[],
}));

vi.mock('../connection.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async () => (state.current ? [state.current] : []),
      }),
    }),
    update: () => ({
      set: (updates: Record<string, unknown>) => {
        state.lastSet = updates;
        return {
          where: () => ({
            returning: async () => (state.current ? [{ ...state.current, ...updates }] : []),
          }),
        };
      },
    }),
    insert: () => ({
      values: async (row: Record<string, unknown>) => {
        state.inserted.push(row);
      },
    }),
  },
}));
vi.mock('../schema.js', () => ({ maps: { id: 'id' }, mapPermissions: {}, nodes: {}, changeEvents: {} }));
vi.mock('../nodes.js', () => ({ notDeleted: {} }));
vi.mock('drizzle-orm', () => ({
  eq: () => ({}),
  and: () => ({}),
  inArray: () => ({}),
  or: () => ({}),
  desc: () => ({}),
  gte: () => ({}),
  sql: () => ({}),
}));

import { updateMap } from '../maps.js';

beforeEach(() => {
  state.inserted = [];
  state.lastSet = null;
  state.current = {
    id: 'map-1',
    workspaceId: 'ws-1',
    name: 'Roadmap',
    description: null,
    effortUnit: 'days',
    statusWorkflow: [],
    customFieldDefs: [],
    phases: [],
    baselines: [],
    wipLimit: null,
    maxActiveClaims: 0,
    dispatchGate: ['version:mvp'],
    dispatchPolicy: [],
    profilePolicy: null,
    focusFactor: 1,
    workerCount: 1,
    createdBy: 'user-1',
    createdAt: new Date('2026-07-01T00:00:00Z'),
    updatedAt: new Date('2026-07-01T00:00:00Z'),
  };
});

describe('updateMap — map.field_changed audit', () => {
  it('records a cap change with old/new values, attributed to the caller', async () => {
    const updated = await updateMap('map-1', { maxActiveClaims: 6 }, 'user-42');
    expect(updated?.maxActiveClaims).toBe(6);
    expect(state.inserted).toEqual([
      {
        mapId: 'map-1',
        nodeId: null,
        userId: 'user-42',
        eventType: 'map.field_changed',
        fieldName: 'maxActiveClaims',
        oldValue: 0,
        newValue: 6,
      },
    ]);
  });

  it('diffs arrays by value: re-sending the same gate is a no-op, a new gate is one row', async () => {
    await updateMap('map-1', { dispatchGate: ['version:mvp'] }, 'user-42');
    expect(state.inserted).toEqual([]);

    await updateMap('map-1', { dispatchGate: ['type:bug'] }, 'user-42');
    expect(state.inserted).toHaveLength(1);
    expect(state.inserted[0]).toMatchObject({
      fieldName: 'dispatchGate',
      oldValue: ['version:mvp'],
      newValue: ['type:bug'],
    });
  });

  it('writes one row per changed audited field and none for unaudited ones', async () => {
    await updateMap('map-1', { name: 'Renamed', maxActiveClaims: 12, dispatchPolicy: ['bugs', 'size'] }, 'user-42');
    const fields = state.inserted.map((r) => r.fieldName).sort();
    expect(fields).toEqual(['dispatchPolicy', 'maxActiveClaims']);
  });

  it('attributes system writes to null and still records them', async () => {
    await updateMap('map-1', { maxActiveClaims: 3 });
    expect(state.inserted).toHaveLength(1);
    expect(state.inserted[0]).toMatchObject({ userId: null, newValue: 3 });
  });

  it('returns null and records nothing for an unknown map', async () => {
    state.current = null;
    expect(await updateMap('nope', { maxActiveClaims: 1 }, 'user-42')).toBeNull();
    expect(state.inserted).toEqual([]);
  });
});
