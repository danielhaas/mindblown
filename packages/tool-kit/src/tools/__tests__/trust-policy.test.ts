/**
 * #491 — trustPolicy on update_map: the zod schema takes the whole policy
 * (or null = back to the defaults), refuses unknown knobs, forwards it to
 * the backend, and the reply shows the policy now in force.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { updateMapTool } from '../map.js';
import type { ToolBackend } from '../../backend.js';

const POLICY = {
  trustedUserIds: ['u-1'],
  trustedForgeLogins: ['octocat'],
  levels: { known: { dispatch: 'auto', merge: 'pr-only' }, external: { dispatch: 'approval', merge: 'pr-only' } },
};

function recorder() {
  const calls: Array<Record<string, unknown>> = [];
  const backend = {
    updateMap: async (mapId: string, fields: Record<string, unknown>) => {
      calls.push(fields);
      return { id: mapId, name: 'stub map', ...(fields.trustPolicy !== undefined ? { trustPolicy: fields.trustPolicy ?? POLICY } : {}) };
    },
  } as unknown as ToolBackend;
  return { backend, calls };
}

describe('update_map — trustPolicy', () => {
  const schema = z.object(updateMapTool.schema);

  it('accepts a full policy and null', () => {
    expect(schema.parse({ mapId: 'm1', trustPolicy: POLICY }).trustPolicy).toEqual(POLICY);
    expect(schema.parse({ mapId: 'm1', trustPolicy: null }).trustPolicy).toBeNull();
  });

  it('refuses unknown knobs, a missing level and extra keys', () => {
    const bad = (trustPolicy: unknown) => () => schema.parse({ mapId: 'm1', trustPolicy });
    expect(bad({ ...POLICY, levels: { ...POLICY.levels, known: { dispatch: 'auto', merge: 'deploy' } } })).toThrow();
    expect(bad({ ...POLICY, levels: { known: POLICY.levels.known } })).toThrow();
    expect(bad({ ...POLICY, deploy: 'auto' })).toThrow();
  });

  it('round-trips: forwards the policy and prints the one in force', async () => {
    const r = recorder();
    const out = await updateMapTool.handler(r.backend, { mapId: 'm1', trustPolicy: POLICY } as never);
    expect(r.calls[0]).toEqual({ trustPolicy: POLICY });
    expect(out).toContain('trusted forge logins: octocat');
    expect(out).toContain('known: dispatch auto, merge pr-only');
    expect(out).toContain('external: dispatch approval, merge pr-only');
  });

  it('null is forwarded as null (back to the defaults)', async () => {
    const r = recorder();
    const out = await updateMapTool.handler(r.backend, { mapId: 'm1', trustPolicy: null } as never);
    expect(r.calls[0]).toEqual({ trustPolicy: null });
    expect(out).toContain('Trust policy (defaults)');
  });

  it('an update without it says nothing about trust', async () => {
    const r = recorder();
    const out = await updateMapTool.handler(r.backend, { mapId: 'm1', name: 'x' } as never);
    expect(r.calls[0]).not.toHaveProperty('trustPolicy');
    expect(out).not.toContain('Trust policy');
  });
});
