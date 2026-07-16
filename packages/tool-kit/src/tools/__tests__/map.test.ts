/**
 * Tool-kit schema/handler regression tests for the map tools.
 *
 * Pins the MCP surface of update_map — specifically that `focusFactor`
 * round-trips through the tool so agents (Jenna et al.) can set a map's
 * capacity-leakage knob through their normal tools, not a direct REST call.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { updateMapTool } from '../map.js';
import type { ToolBackend } from '../../backend.js';

function makeRecordingBackend(): {
  backend: ToolBackend;
  lastUpdate: { mapId: string; fields: Record<string, unknown> } | null;
} {
  const state = { lastUpdate: null as { mapId: string; fields: Record<string, unknown> } | null };
  const backend = {
    updateMap: async (mapId: string, fields: Record<string, unknown>) => {
      state.lastUpdate = { mapId, fields };
      return { id: mapId, name: 'stub map' };
    },
  } as unknown as ToolBackend;
  return {
    backend,
    get lastUpdate() {
      return state.lastUpdate;
    },
  };
}

describe('update_map tool — focusFactor', () => {
  it('accepts a focusFactor in range', () => {
    const schema = z.object(updateMapTool.schema);
    expect(schema.parse({ mapId: 'm1', focusFactor: 0.5 }).focusFactor).toBe(0.5);
    expect(schema.parse({ mapId: 'm1', focusFactor: 1 }).focusFactor).toBe(1);
  });

  it('rejects a focusFactor above 1 or below the 0.05 floor', () => {
    const schema = z.object(updateMapTool.schema);
    expect(() => schema.parse({ mapId: 'm1', focusFactor: 1.5 })).toThrow();
    expect(() => schema.parse({ mapId: 'm1', focusFactor: 0 })).toThrow();
  });

  it('forwards focusFactor to the backend', async () => {
    const recorder = makeRecordingBackend();
    const result = await updateMapTool.handler(recorder.backend, {
      mapId: 'm1',
      focusFactor: 0.4,
    } as never);
    expect(recorder.lastUpdate).not.toBeNull();
    expect(recorder.lastUpdate?.fields).toMatchObject({ focusFactor: 0.4 });
    // Undefined fields stripped (handler's clean-fields contract).
    expect('workerCount' in (recorder.lastUpdate?.fields ?? {})).toBe(false);
    expect(result).toContain('stub map');
  });
});
