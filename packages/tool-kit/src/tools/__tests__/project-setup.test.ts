/**
 * Guided onboarding on the MCP surface: project_setup_status reads the
 * checklist an agent walks a person through, and update_map(setupCompleted)
 * closes it — the same two things the wizard and the map card use.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { projectSetupStatusTool, updateMapTool } from '../map.js';
import type { ToolBackend } from '../../backend.js';

function backendWith(map: Record<string, unknown>, nodes: Array<{ id: string; parentId: string | null }>): ToolBackend {
  return {
    getMap: async () => ({
      map: { id: 'm1', name: 'Shop', description: null, rootNodeId: 'root', ...map },
      nodes,
    }),
  } as unknown as ToolBackend;
}

const root = { id: 'root', parentId: null };

describe('project_setup_status', () => {
  it('lists open steps with the tool that finishes each, the repo before the plan', async () => {
    const out = await projectSetupStatusTool.handler(backendWith({}, [root]), { mapId: 'm1' });
    expect(out).toContain('Setup of "Shop": 1/5 steps done.');
    expect(out).toContain('1. [ ] Describe the project');
    expect(out.indexOf('Connect the repository')).toBeLessThan(out.indexOf('Lay out the plan'));
    expect(out).toContain('How: connect_forge_repo');
    expect(out).toContain('Next: Describe the project.');
  });

  it('a held fleet asks for the start step; everything done asks to close the checklist', async () => {
    const held = await projectSetupStatusTool.handler(
      backendWith({ description: 'A shop', forgeKind: 'github', githubRepoOwner: 'o', githubRepoName: 'r', fleetId: 'f', fleetName: 'claudia', maxActiveClaims: 0 }, [root, { id: 'a', parentId: 'root' }]),
      { mapId: 'm1' },
    );
    expect(held).toContain('[x] Pick who does the work (optional) — Fleet "claudia" connected.');
    expect(held).toContain('Next: Start.');

    const all = await projectSetupStatusTool.handler(
      backendWith({ description: 'A shop', forgeKind: 'github', fleetId: 'f', maxActiveClaims: 1 }, [root, { id: 'a', parentId: 'root' }]),
      { mapId: 'm1' },
    );
    expect(all).toContain('Every step is done.');
    expect(all).toContain('update_map(setupCompleted: true)');
  });
});

describe('update_map — setupCompleted', () => {
  it('forwards the switch to the backend', async () => {
    expect(z.object(updateMapTool.schema).parse({ mapId: 'm1', setupCompleted: true }).setupCompleted).toBe(true);
    let sent: Record<string, unknown> | null = null;
    const backend = {
      updateMap: async (_id: string, fields: Record<string, unknown>) => {
        sent = fields;
        return { id: 'm1', name: 'Shop' };
      },
    } as unknown as ToolBackend;
    await updateMapTool.handler(backend, { mapId: 'm1', setupCompleted: true } as never);
    expect(sent).toEqual({ setupCompleted: true });
  });
});
