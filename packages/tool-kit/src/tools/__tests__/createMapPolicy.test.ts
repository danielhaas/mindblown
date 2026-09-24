/**
 * create_map carries the AI policy (#375) to the backend — a private project
 * can be created private from an MCP client, not only via the settings.
 */
import { describe, it, expect, vi } from 'vitest';
import { createMapTool } from '../map.js';
import type { ToolBackend } from '../../backend.js';

function backend() {
  const createMap = vi.fn(async (name: string) => ({ id: 'm-new', name }));
  return { createMap } as unknown as ToolBackend & { createMap: typeof createMap };
}

describe('create_map aiPolicy', () => {
  it('passes a chosen policy through and says so', async () => {
    const b = backend();
    const out = await createMapTool.handler(b, { name: 'ISOlation', aiPolicy: 'local' } as never);
    expect(b.createMap).toHaveBeenCalledWith('ISOlation', undefined, { aiPolicy: 'local' });
    expect(out).toContain('AI policy: local');
  });

  it('omits the option when none was given (server default any)', async () => {
    const b = backend();
    const out = await createMapTool.handler(b, { name: 'Open', description: 'd' } as never);
    expect(b.createMap).toHaveBeenCalledWith('Open', 'd', undefined);
    expect(out).not.toContain('AI policy');
  });

  it('the schema only accepts the three known policies', () => {
    const schema = createMapTool.schema as { aiPolicy: { safeParse: (v: unknown) => { success: boolean } } };
    expect(schema.aiPolicy.safeParse('none').success).toBe(true);
    expect(schema.aiPolicy.safeParse('cloud').success).toBe(false);
    expect(schema.aiPolicy.safeParse(undefined).success).toBe(true);
  });
});
