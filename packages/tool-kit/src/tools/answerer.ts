/**
 * answerer_name — the name the caller's asks are filed under on the
 * Questions card. Questions for a map's owner (lint, gate, question-kind
 * blockers) go under the owner's answerer name, so one person is one group
 * (Daniel Haas sets "Dan" — the name the fleet's collector already uses).
 */
import { z } from 'zod';
import type { AnswererSetting } from '@mindblown/core';
import { defineTool } from '../spec.js';

function render(s: AnswererSetting): string {
  return s.answererName
    ? `Your asks are filed under "${s.effective}" (your answerer name).`
    : `Your asks are filed under "${s.effective}" (your first name; no answerer name set).`;
}

export const answererNameTool = defineTool({
  name: 'answerer_name',
  description:
    'The name your questions are filed under on the Questions card (list_asks `answerer`, waiting_on_humans). Questions for a map you own — lint asks, the gate ask, question-kind blockers — go to this name. Default: your first name. Without `name`: show it. With `name`: set it (one word, e.g. "Dan" so they group with the fleet\'s asks for Dan); `name: null` clears it back to the first name.',
  schema: {
    name: z.string().max(40).nullable().optional().describe('Set your answerer name (one word, e.g. "Dan"); null clears it. Omit to read it.'),
  },
  handler: async (backend, { name }) => {
    if (name === undefined) return render(await backend.getAnswererName());
    return `Saved. ${render(await backend.setAnswererName(name))}`;
  },
});

export const answererTools = [answererNameTool];
