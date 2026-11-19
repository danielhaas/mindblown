/**
 * Notes to the agent (claude-fleet#92): a person's note to the fleet agent
 * running a ticket, stored as a node comment of kind 'fleet-note'. The fleet
 * worker polls them, hands them to its agent as written by that person and
 * marks each one delivered ("picked up" on the card).
 */
import { z } from 'zod';
import type { NodeComment } from '@mindblown/core';
import { defineTool } from '../spec.js';

function hhmm(iso: string): string {
  return iso.slice(11, 16);
}

/** One comment line: `[id] 2026-11-19 10:02 Dan (note to the agent, picked up 10:03): text`. */
export function renderComment(c: NodeComment): string {
  const who = c.userName || c.userId;
  const when = c.createdAt.slice(0, 16).replace('T', ' ');
  const tag =
    c.kind === 'fleet-note'
      ? ` (note to the agent, ${c.deliveredAt ? `picked up ${hhmm(c.deliveredAt)} UTC` : 'not picked up yet'})`
      : '';
  return `[${c.id}] ${when} ${who}${tag}: ${c.text}`;
}

export const addNoteToAgentTool = defineTool({
  name: 'add_note_to_agent',
  description: [
    'Write a note to the fleet agent working a ticket right now (or fixing its',
    'open PR before the merge). The fleet worker picks it up within about a',
    'minute, stops its agent and continues on the same branch with the note',
    'added to the brief — the work so far is kept (unlike flag_blocker, which',
    'stops and discards). The note is handed over as written by you. Needs',
    'edit on the map. Shows on the card as a note to the agent, "sent" until',
    'the worker picks it up.',
  ].join('\n'),
  schema: {
    mapId: z.string().describe('The map ID'),
    nodeId: z.string().describe('The ticket (node) the agent is working'),
    text: z.string().min(1).describe('The note: what the agent should do differently or also consider'),
  },
  handler: async (backend, { mapId, nodeId, text }) => {
    const c = await backend.addComment(mapId, nodeId, { text, kind: 'fleet-note' });
    return `Note to the agent sent.\n${renderComment(c)}`;
  },
});

export const listNotesToAgentTool = defineTool({
  name: 'list_notes_to_agent',
  description: [
    'The notes to the agent on a ticket (comments of kind fleet-note), oldest',
    'first, each with its id, author and whether the fleet worker has picked',
    'it up. `since` (ISO 8601) returns only notes written after it — the',
    "worker passes its claim time. Read-only. Pass `kind: 'all'` for every",
    'comment on the node instead.',
  ].join('\n'),
  schema: {
    mapId: z.string().describe('The map ID'),
    nodeId: z.string().describe('The node ID'),
    since: z.string().optional().describe('Only comments created after this ISO 8601 instant'),
    kind: z.enum(['fleet-note', 'comment', 'all']).optional().describe("Default 'fleet-note'"),
  },
  handler: async (backend, { mapId, nodeId, since, kind }) => {
    const k = kind ?? 'fleet-note';
    const list = await backend.listComments(mapId, nodeId, { kind: k === 'all' ? undefined : k, since });
    const what = k === 'fleet-note' ? 'notes to the agent' : k === 'comment' ? 'comments' : 'comments and notes';
    if (list.length === 0) return `No ${what}${since ? ` since ${since}` : ''}.`;
    return [`${list.length} ${what}:`, ...list.map(renderComment)].join('\n');
  },
});

export const ackNoteToAgentTool = defineTool({
  name: 'ack_note_to_agent',
  description: [
    'Mark a note to the agent as picked up — the fleet worker calls this once',
    'it handed the note to its agent; the card then shows "picked up at',
    'HH:MM". Marking it again keeps the first time. Needs edit on the map.',
  ].join('\n'),
  schema: {
    mapId: z.string().describe('The map ID'),
    nodeId: z.string().describe('The node ID'),
    commentId: z.string().describe('The note id (list_notes_to_agent)'),
    deliveredAt: z.string().optional().describe('When it was handed over, ISO 8601 (default now)'),
  },
  handler: async (backend, { mapId, nodeId, commentId, deliveredAt }) => {
    const c = await backend.ackFleetNote(mapId, nodeId, commentId, deliveredAt);
    return `Marked picked up.\n${renderComment(c)}`;
  },
});

export const commentTools = [addNoteToAgentTool, listNotesToAgentTool, ackNoteToAgentTool];
