/**
 * Notes to the agent (claude-fleet#92): add_note_to_agent writes a
 * fleet-note comment, list_notes_to_agent reads it back (kind + since
 * forwarded), ack_note_to_agent marks it picked up — round trip over an
 * in-memory backend that behaves like the comments route.
 */
import { describe, expect, it } from 'vitest';
import type { CommentKind, NodeComment } from '@mindblown/core';
import { ackNoteToAgentTool, addNoteToAgentTool, listNotesToAgentTool, renderComment } from '../comments.js';
import { allTools } from '../../index.js';
import type { ToolBackend } from '../../backend.js';

function memoryBackend() {
  const rows: NodeComment[] = [];
  const calls: unknown[][] = [];
  let clock = Date.parse('2026-11-19T10:00:00Z');
  const backend = {
    async addComment(mapId: string, nodeId: string, input: { text: string; kind?: CommentKind }) {
      calls.push(['addComment', mapId, nodeId, input]);
      const at = new Date((clock += 60_000)).toISOString();
      const c: NodeComment = { id: `c${rows.length + 1}`, nodeId, userId: 'u1', userName: 'Dan', text: input.text, kind: input.kind ?? 'comment', deliveredAt: null, createdAt: at, updatedAt: at };
      rows.push(c);
      return c;
    },
    async listComments(mapId: string, nodeId: string, opts?: { kind?: CommentKind; since?: string }) {
      calls.push(['listComments', mapId, nodeId, opts]);
      return rows.filter((c) => c.nodeId === nodeId && (!opts?.kind || c.kind === opts.kind) && (!opts?.since || c.createdAt > opts.since));
    },
    async ackFleetNote(mapId: string, nodeId: string, commentId: string, deliveredAt?: string) {
      calls.push(['ackFleetNote', mapId, nodeId, commentId, deliveredAt]);
      const c = rows.find((r) => r.id === commentId)!;
      c.deliveredAt ??= deliveredAt ?? new Date(clock).toISOString();
      return c;
    },
  } as unknown as ToolBackend;
  return { backend, rows, calls };
}

describe('notes to the agent', () => {
  it('add → list → ack round-trips a fleet-note', async () => {
    const { backend, calls } = memoryBackend();
    await backend.addComment('m1', 'n1', { text: 'just a comment' });

    const sent = await addNoteToAgentTool.handler(backend, { mapId: 'm1', nodeId: 'n1', text: 'Use the v2 API, not v1' });
    expect(calls[1]).toEqual(['addComment', 'm1', 'n1', { text: 'Use the v2 API, not v1', kind: 'fleet-note' }]);
    expect(sent).toContain('Note to the agent sent.');
    expect(sent).toContain('[c2] 2026-11-19 10:02 Dan (note to the agent, not picked up yet): Use the v2 API, not v1');

    const listed = await listNotesToAgentTool.handler(backend, { mapId: 'm1', nodeId: 'n1', since: '2026-11-19T10:00:00Z' });
    expect(calls[2]).toEqual(['listComments', 'm1', 'n1', { kind: 'fleet-note', since: '2026-11-19T10:00:00Z' }]);
    expect(listed).toContain('1 notes to the agent:');
    expect(listed).toContain('Use the v2 API');
    expect(listed).not.toContain('just a comment');

    const acked = await ackNoteToAgentTool.handler(backend, { mapId: 'm1', nodeId: 'n1', commentId: 'c2', deliveredAt: '2026-11-19T10:05:00Z' });
    expect(calls[3]).toEqual(['ackFleetNote', 'm1', 'n1', 'c2', '2026-11-19T10:05:00Z']);
    expect(acked).toContain('picked up 10:05 UTC');

    const after = await listNotesToAgentTool.handler(backend, { mapId: 'm1', nodeId: 'n1' });
    expect(after).toContain('(note to the agent, picked up 10:05 UTC)');
  });

  it("kind 'all' lists every comment; an empty list says so", async () => {
    const { backend, calls } = memoryBackend();
    expect(await listNotesToAgentTool.handler(backend, { mapId: 'm1', nodeId: 'n1' })).toBe('No notes to the agent.');
    await backend.addComment('m1', 'n1', { text: 'hello' });
    const all = await listNotesToAgentTool.handler(backend, { mapId: 'm1', nodeId: 'n1', kind: 'all' });
    expect(calls.at(-1)).toEqual(['listComments', 'm1', 'n1', { kind: undefined, since: undefined }]);
    expect(all).toContain('Dan: hello');
  });

  it('a plain comment renders without the note tag', () => {
    expect(renderComment({ id: 'c1', nodeId: 'n', userId: 'u', userName: null, text: 'x', kind: 'comment', deliveredAt: null, createdAt: '2026-11-19T10:00:00Z', updatedAt: '2026-11-19T10:00:00Z' })).toBe('[c1] 2026-11-19 10:00 u: x');
  });

  it('is in allTools', () => {
    const names = allTools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['add_note_to_agent', 'list_notes_to_agent', 'ack_note_to_agent']));
  });
});
