/**
 * The chat's management-information tools run the MCP server's own handlers
 * in-process. These tests pin the two things that can silently break that:
 * the SDK's tool registry moving (every MI name must still resolve), and the
 * call path (chat map, chat user, in-process injector).
 */
import { describe, it, expect, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import type { Injector } from '@mindblown/mcp';
import { getMiChatTools, MI_CHAT_TOOL_NAMES } from '../miTools.js';

const tool = (name: string) => {
  const t = getMiChatTools().find((x) => x.name === name);
  if (!t) throw new Error(`${name} missing`);
  return t;
};

describe('getMiChatTools', () => {
  it('resolves every MI tool from the MCP server, with its schema', () => {
    const tools = getMiChatTools();
    expect(tools.map((t) => t.name)).toEqual([...MI_CHAT_TOOL_NAMES]);
    for (const t of tools) {
      expect(t.description.length, t.name).toBeGreaterThan(10);
      expect(Object.keys(t.schema), t.name).toContain('mapId');
    }
  });

  it('runs the handler as the chat user against the chat map, through the injector', async () => {
    const injector = vi.fn<Injector>(async () => ({
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([
        { id: 'v1', name: 'V1', status: 'active', targetDate: '2026-11-01', releasedAt: null },
      ]),
    }));

    const out = await tool('list_versions').run(
      { mapId: 'some-other-map' },
      { userId: 'user-1', mapId: 'map-1', injector },
    );

    expect(out).toContain('V1 (id: v1)');
    expect(out).toContain('target: 2026-11-01');
    expect(injector).toHaveBeenCalledTimes(1);
    const req = injector.mock.calls[0][0];
    expect(req.url).toBe('/api/versions?mapId=map-1');
    const bearer = req.headers?.Authorization?.replace(/^Bearer /, '') ?? '';
    expect(jwt.decode(bearer)).toMatchObject({ userId: 'user-1', kind: 'loopback' });
  });

  it('applies schema defaults and reports invalid arguments instead of throwing', async () => {
    const out = await tool('risk_scan').run(
      { stalledDays: 'soon' },
      { userId: 'user-1', mapId: 'map-1', injector: vi.fn() },
    );
    expect(out).toMatch(/^Error: invalid arguments for risk_scan: stalledDays/);
  });
});
