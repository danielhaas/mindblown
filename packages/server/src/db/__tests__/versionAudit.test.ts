/**
 * updateVersion audit trail (#331).
 *
 * Before this, a re-dated release left no trace except
 * release_snapshots.target_date. Now every changed audited field
 * (name / status / targetDate / sortOrder) lands as one
 * `version.field_changed` row in change_events, attributed to the caller,
 * with node_id = null. Description edits are not audited (noise, same as
 * on nodes). updated_at is stamped on every write.
 *
 * Drizzle is stubbed with a minimal chainable so this runs without
 * Postgres; the assertion surface is what recordEvent is called with and
 * what `set()` received.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
  lastSet: null as Record<string, unknown> | null,
  recordEvent: vi.fn(async (_row: Record<string, unknown>) => undefined),
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
  },
}));
vi.mock('../schema.js', () => ({
  versions: { id: 'id', mapId: 'map_id', targetDate: 'target_date', sortOrder: 'sort_order', name: 'name' },
  cycles: {},
  nodes: {},
  maps: {},
}));
vi.mock('drizzle-orm', () => ({ eq: () => ({}), asc: () => ({}), sql: () => ({}) }));
vi.mock('../../sync/mapContext.js', () => ({ invalidateMapContext: vi.fn() }));
vi.mock('../events.js', () => ({ recordEvent: state.recordEvent }));

import { updateVersion } from '../versions.js';

beforeEach(() => {
  state.recordEvent.mockClear();
  state.lastSet = null;
  state.current = {
    id: 'v-1',
    mapId: 'map-1',
    name: 'V1',
    description: null,
    status: 'planning',
    targetDate: '2026-09-02',
    sortOrder: 0,
    releasedAt: null,
    createdAt: new Date('2026-07-01T00:00:00Z'),
    updatedAt: null,
  };
});

describe('updateVersion — change_events + updated_at (#331)', () => {
  it('writes one version.field_changed row for a targetDate change, attributed to the caller', async () => {
    const updated = await updateVersion('v-1', { targetDate: '2026-12-18' }, 'user-42');
    expect(updated?.targetDate).toBe('2026-12-18');
    expect(state.recordEvent).toHaveBeenCalledTimes(1);
    expect(state.recordEvent).toHaveBeenCalledWith({
      mapId: 'map-1',
      nodeId: null,
      userId: 'user-42',
      eventType: 'version.field_changed',
      fieldName: 'targetDate',
      oldValue: '2026-09-02',
      newValue: '2026-12-18',
    });
  });

  it('stamps updated_at on every write and exposes it on the returned version', async () => {
    const updated = await updateVersion('v-1', { description: 'x' });
    expect(state.lastSet?.updatedAt).toBeInstanceOf(Date);
    expect(typeof updated?.updatedAt).toBe('string');
  });

  it('audits name / status / sortOrder but not description', async () => {
    await updateVersion('v-1', { name: 'V1 GA', status: 'active', sortOrder: 10, description: 'noise' }, null);
    const fields = state.recordEvent.mock.calls.map((c) => c[0].fieldName).sort();
    expect(fields).toEqual(['name', 'sortOrder', 'status']);
    for (const c of state.recordEvent.mock.calls) {
      expect(c[0].userId).toBeNull();
      expect(c[0].nodeId).toBeNull();
    }
  });

  it('records nothing when the value did not change', async () => {
    await updateVersion('v-1', { targetDate: '2026-09-02' }, 'user-42');
    expect(state.recordEvent).not.toHaveBeenCalled();
  });

  it('records a cleared date as old → null', async () => {
    await updateVersion('v-1', { targetDate: null }, 'user-42');
    expect(state.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ fieldName: 'targetDate', oldValue: '2026-09-02', newValue: null }),
    );
  });

  it('returns null and records nothing for an unknown version', async () => {
    state.current = null;
    expect(await updateVersion('nope', { targetDate: '2026-12-18' }, 'user-42')).toBeNull();
    expect(state.recordEvent).not.toHaveBeenCalled();
  });
});
