/**
 * answerer_name: read and set the name your asks are filed under, round
 * trip through the backend — the MCP surface of users.answerer_name. And
 * list_asks takes any answerer name, not a fixed list.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { answererName, type AnswererSetting } from '@mindblown/core';
import { answererNameTool } from '../answerer.js';
import { listAsksTool } from '../asks.js';
import { allTools } from '../../index.js';
import type { ToolBackend } from '../../backend.js';

function memoryBackend(fullName: string): ToolBackend {
  let own: string | null = null;
  const s = (): AnswererSetting => ({ answererName: own, effective: answererName(fullName, own) });
  return {
    getAnswererName: async () => s(),
    setAnswererName: async (name: string | null) => {
      own = name?.trim() || null;
      return s();
    },
  } as unknown as ToolBackend;
}

describe('answerer_name', () => {
  it('is registered on the shared tool list', () => {
    expect(allTools.map((t) => t.name)).toContain('answerer_name');
  });

  it('first name by default; set "Dan" → asks under Dan; null clears it', async () => {
    const backend = memoryBackend('Daniel Haas');
    expect(await answererNameTool.handler(backend, {} as never)).toContain('"Daniel" (your first name');
    expect(await answererNameTool.handler(backend, { name: 'Dan' } as never)).toContain('"Dan" (your answerer name)');
    expect(await answererNameTool.handler(backend, {} as never)).toContain('"Dan"');
    expect(await answererNameTool.handler(backend, { name: null } as never)).toContain('"Daniel"');
  });
});

describe('list_asks answerer filter', () => {
  it('accepts any answerer name on the card', () => {
    const schema = z.object(listAsksTool.schema);
    for (const answerer of ['Dan', 'Daniel', 'Rita', 'Ola']) expect(schema.safeParse({ mapId: 'm1', answerer }).success).toBe(true);
    expect(schema.safeParse({ mapId: 'm1', answerer: '' }).success).toBe(false);
  });
});
