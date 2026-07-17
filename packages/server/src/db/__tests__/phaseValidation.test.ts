/**
 * Unit coverage for assertPhaseIdKnown — the app-level referential guard
 * between nodes.phase_id and the map's PhaseDef list (maps.phases is
 * jsonb, so there is no FK to lean on). Exercised with a stub DbHandle
 * (mergeTags pattern: no Postgres needed) that mimics the drizzle
 * select().from().where() chain.
 */

import { describe, it, expect } from 'vitest';
import { assertPhaseIdKnown, PhaseIdValidationError } from '../nodes.js';
import type { DbHandle } from '../nodes.js';

/** Stub handle returning a fixed maps row (or none) and counting queries. */
function stubHandle(mapRow?: { phases: unknown }): { handle: DbHandle; queries: () => number } {
  let count = 0;
  const handle = {
    select: () => {
      count++;
      return {
        from: () => ({
          where: async () => (mapRow ? [mapRow] : []),
        }),
      };
    },
  } as unknown as DbHandle;
  return { handle, queries: () => count };
}

const PHASES = [
  { id: 'ph-1', name: 'M1', position: 0 },
  { id: 'ph-2', name: 'M2', position: 1 },
];

describe('assertPhaseIdKnown', () => {
  it('passes for a phaseId present in the map phases', async () => {
    const { handle } = stubHandle({ phases: PHASES });
    await expect(assertPhaseIdKnown(handle, 'map-1', 'ph-2')).resolves.toBeUndefined();
  });

  it('throws PhaseIdValidationError for an unknown phaseId', async () => {
    const { handle } = stubHandle({ phases: PHASES });
    await expect(assertPhaseIdKnown(handle, 'map-1', 'ph-nope')).rejects.toThrow(
      PhaseIdValidationError,
    );
  });

  it('throws when the map has no phases at all', async () => {
    const { handle } = stubHandle({ phases: [] });
    await expect(assertPhaseIdKnown(handle, 'map-1', 'ph-1')).rejects.toThrow(
      PhaseIdValidationError,
    );
  });

  it('treats a null phases column defensively as empty', async () => {
    const { handle } = stubHandle({ phases: null });
    await expect(assertPhaseIdKnown(handle, 'map-1', 'ph-1')).rejects.toThrow(
      PhaseIdValidationError,
    );
  });

  it('throws when the map row does not exist', async () => {
    const { handle } = stubHandle(undefined);
    await expect(assertPhaseIdKnown(handle, 'map-1', 'ph-1')).rejects.toThrow(
      PhaseIdValidationError,
    );
  });

  it('null / undefined phaseId short-circuits without touching the DB', async () => {
    const { handle, queries } = stubHandle({ phases: PHASES });
    await expect(assertPhaseIdKnown(handle, 'map-1', null)).resolves.toBeUndefined();
    await expect(assertPhaseIdKnown(handle, 'map-1', undefined)).resolves.toBeUndefined();
    expect(queries()).toBe(0);
  });
});
