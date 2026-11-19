/**
 * export_markdown / publish_to_wiki (#637): the options reach the backend,
 * the Markdown comes back verbatim, and the publish says whether it created
 * or updated the page.
 */
import { describe, it, expect, vi } from 'vitest';
import { exportMarkdownTool, publishToWikiTool, mapTools } from '../map.js';
import type { ToolBackend } from '../../backend.js';

describe('export_markdown', () => {
  it('passes the subtree, detail and zone through and returns the Markdown', async () => {
    const exportMarkdown = vi.fn(async () => '# Loke-Support — timeline\n');
    const out = await exportMarkdownTool.handler({ exportMarkdown } as unknown as ToolBackend, {
      mapId: 'm1',
      rootNodeId: 'n1',
      detail: 'full',
      timeZone: 'Europe/Zurich',
    });
    expect(exportMarkdown).toHaveBeenCalledWith('m1', { rootNodeId: 'n1', detail: 'full', timeZone: 'Europe/Zurich' });
    expect(out).toBe('# Loke-Support — timeline\n');
  });

  it('defaults leave the options unset — the server picks summary, whole map, UTC', async () => {
    const exportMarkdown = vi.fn(async () => 'md');
    await exportMarkdownTool.handler({ exportMarkdown } as unknown as ToolBackend, { mapId: 'm1' });
    expect(exportMarkdown).toHaveBeenCalledWith('m1', { rootNodeId: undefined, detail: undefined, timeZone: undefined });
  });

  it('rejects an unknown detail level in the schema', async () => {
    const { z } = await import('zod');
    expect(z.object(exportMarkdownTool.schema).safeParse({ mapId: 'm1', detail: 'everything' }).success).toBe(false);
  });
});

describe('publish_to_wiki', () => {
  it('reports a created page, then an updated one', async () => {
    const publishToWiki = vi
      .fn()
      .mockResolvedValueOnce({ documentId: 'd1', documentUrl: 'https://wiki/doc/a', created: true, publishedAt: '2026-11-19T08:00:00.000Z' })
      .mockResolvedValueOnce({ documentId: 'd1', documentUrl: 'https://wiki/doc/a', created: false, publishedAt: '2026-11-20T08:00:00.000Z' });
    const backend = { publishToWiki } as unknown as ToolBackend;
    expect(await publishToWikiTool.handler(backend, { mapId: 'm1' })).toMatch(/^Created the wiki page: https:\/\/wiki\/doc\/a/);
    expect(await publishToWikiTool.handler(backend, { mapId: 'm1' })).toMatch(/^Updated the wiki page: https:\/\/wiki\/doc\/a/);
    expect(publishToWiki).toHaveBeenCalledWith('m1');
  });

  it('both tools are registered with the map tools', () => {
    const names = mapTools.map((t) => t.name);
    expect(names).toContain('export_markdown');
    expect(names).toContain('publish_to_wiki');
  });
});
