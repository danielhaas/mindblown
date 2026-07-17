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

// Phase column — update_map is the write surface for the map's PhaseDef
// list (add / rename / reorder in REPLACE mode). The handler normalizes:
// missing ids are generated, missing positions default to the array index.
describe('update_map tool — phases', () => {
  it('accepts a full PhaseDef array', () => {
    const schema = z.object(updateMapTool.schema);
    const parsed = schema.parse({
      mapId: 'm1',
      phases: [
        { id: 'ph-1', name: 'M1', position: 0 },
        { id: 'ph-2', name: 'M2', position: 1, color: '#ff0000', targetDate: null },
      ],
    });
    expect(parsed.phases).toHaveLength(2);
  });

  it('rejects entries without a name', () => {
    const schema = z.object(updateMapTool.schema);
    expect(() => schema.parse({ mapId: 'm1', phases: [{ id: 'ph-1' }] })).toThrow();
    expect(() => schema.parse({ mapId: 'm1', phases: [{ name: '' }] })).toThrow();
  });

  it('forwards a reorder (position swap) to the backend with ids intact', async () => {
    const recorder = makeRecordingBackend();
    await updateMapTool.handler(recorder.backend, {
      mapId: 'm1',
      phases: [
        { id: 'ph-2', name: 'M2', position: 0 },
        { id: 'ph-1', name: 'M1', position: 1 },
      ],
    } as never);
    expect(recorder.lastUpdate?.fields).toMatchObject({
      phases: [
        { id: 'ph-2', name: 'M2', position: 0 },
        { id: 'ph-1', name: 'M1', position: 1 },
      ],
    });
  });

  it('generates an id for new entries and defaults position to the array index', async () => {
    const recorder = makeRecordingBackend();
    await updateMapTool.handler(recorder.backend, {
      mapId: 'm1',
      phases: [
        { id: 'ph-1', name: 'M1', position: 0 },
        { name: 'M9' }, // new phase: no id, no position
      ],
    } as never);
    const sent = (recorder.lastUpdate?.fields.phases ?? []) as Array<{
      id: string;
      name: string;
      position: number;
    }>;
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ id: 'ph-1', name: 'M1', position: 0 });
    expect(sent[1].name).toBe('M9');
    expect(sent[1].position).toBe(1);
    expect(typeof sent[1].id).toBe('string');
    expect(sent[1].id.length).toBeGreaterThan(0);
  });

  it('does not send phases when omitted', async () => {
    const recorder = makeRecordingBackend();
    await updateMapTool.handler(recorder.backend, {
      mapId: 'm1',
      name: 'renamed',
    } as never);
    expect('phases' in (recorder.lastUpdate?.fields ?? {})).toBe(false);
  });
});
