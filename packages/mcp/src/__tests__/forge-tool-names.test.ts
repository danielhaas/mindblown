/**
 * Forge-neutral tool names: the github_* names stay registered as
 * deprecated aliases of the new ones (same schema, same handler), and the
 * sync overview names the map's actual forge instead of always "GitHub".
 */

import { describe, it, expect, vi } from 'vitest';
import { createMindblownMcpServer, DEPRECATED_TOOL_ALIASES, runWithApiContext } from '../index.js';

interface Registered {
  description?: string;
  inputSchema: { shape: unknown };
  handler: (args: unknown, extra: unknown) => Promise<{ content: Array<{ text: string }> }>;
}

function registeredTools(): Record<string, Registered> {
  return (createMindblownMcpServer() as unknown as { _registeredTools: Record<string, Registered> })._registeredTools;
}

describe('forge-neutral tool names', () => {
  it('registers every old github_* name as an alias of the new tool', () => {
    const tools = registeredTools();
    for (const [name, alias] of Object.entries(DEPRECATED_TOOL_ALIASES)) {
      expect(tools[name], name).toBeDefined();
      expect(tools[alias], alias).toBeDefined();
      expect(tools[alias].handler).toBe(tools[name].handler);
      // The SDK wraps the raw shape in a fresh z.object per registration;
      // the shape inside is the very same one.
      expect(tools[alias].inputSchema.shape).toBe(tools[name].inputSchema.shape);
      expect(tools[alias].description).toBe(`Deprecated alias of ${name} — use ${name}. ${tools[name].description}`);
    }
    expect(DEPRECATED_TOOL_ALIASES.forge_sync_overview).toBe('github_sync_overview');
    expect(Object.keys(tools).filter((n) => n.includes('github')).sort()).toEqual(
      Object.values(DEPRECATED_TOOL_ALIASES).sort(),
    );
  });

  it('sync overview says "Gitea" for a Gitea map — through the alias too', async () => {
    const tools = registeredTools();
    const injector = vi.fn(async () => ({
      statusCode: 200,
      body: JSON.stringify({
        repo: 'acme/app',
        forgeKind: 'gitea',
        includeClosed: false,
        counts: { synced: 0, onlyInMindBlown: 1, onlyInGitHub: 1 },
        synced: [],
        onlyInMindBlown: [{ nodeId: 'n1', text: 'Leaf' }],
        onlyInGitHub: [{ issueNumber: 7, title: 'Bug', state: 'open', url: 'https://git.example/acme/app/issues/7' }],
      }),
      headers: { 'content-type': 'application/json' },
    }));

    for (const name of ['forge_sync_overview', 'github_sync_overview']) {
      const res = await runWithApiContext(
        { baseUrl: 'http://unused.invalid', token: 'mb_test', injector },
        () => tools[name].handler({ mapId: 'm1', format: 'full' }, {}),
      );
      const text = res.content[0].text;
      expect(text).toContain('Gitea sync status for acme/app');
      expect(text).toContain('only in Gitea: 1');
      expect(text).toContain('Only in Gitea — issues not linked');
      expect(text).not.toContain('GitHub');
    }
  });
});
