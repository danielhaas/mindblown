/**
 * updateMap's setupCompleted switch (guided onboarding): true stamps
 * setup_completed_at once, false clears it so the checklist shows again,
 * and the stamp round-trips through dbMapToCore as an ISO string.
 * Same drizzle stub as mapAudit.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
  lastSet: null as Record<string, unknown> | null,
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
    insert: () => ({ values: async () => {} }),
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

const STAMP = new Date('2026-10-01T08:00:00Z');

beforeEach(() => {
  state.lastSet = null;
  state.current = {
    id: 'map-1',
    workspaceId: 'ws-1',
    name: 'Shop',
    description: null,
    effortUnit: 'days',
    statusWorkflow: [],
    customFieldDefs: [],
    phases: [],
    baselines: [],
    maxActiveClaims: 0,
    dispatchGate: [],
    dispatchPolicy: [],
    createdBy: 'user-1',
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    setupCompletedAt: null,
  };
});

describe('updateMap — setupCompleted', () => {
  it('true stamps setupCompletedAt on an open checklist', async () => {
    const updated = await updateMap('map-1', { setupCompleted: true }, 'user-1');
    expect(state.lastSet?.setupCompletedAt).toBeInstanceOf(Date);
    expect(typeof updated?.setupCompletedAt).toBe('string');
  });

  it('true keeps the first stamp; false clears it', async () => {
    state.current!.setupCompletedAt = STAMP;
    const kept = await updateMap('map-1', { setupCompleted: true }, 'user-1');
    expect('setupCompletedAt' in state.lastSet!).toBe(false);
    expect(kept?.setupCompletedAt).toBe(STAMP.toISOString());

    const reopened = await updateMap('map-1', { setupCompleted: false }, 'user-1');
    expect(state.lastSet?.setupCompletedAt).toBeNull();
    expect(reopened?.setupCompletedAt).toBeNull();
  });

  it('anything but a boolean leaves it alone', async () => {
    await updateMap('map-1', { setupCompleted: null as never, name: 'Renamed' }, 'user-1');
    expect('setupCompletedAt' in state.lastSet!).toBe(false);
  });
});
