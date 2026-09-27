/**
 * The chat backend checks the map on every scoped call (#403).
 *
 * The model chooses the mapId a tool call names, so the map the chat was
 * opened on guarantees nothing. This walks every method of a real
 * `createChatBackend()` and pins: unscoped methods pass untouched, reads
 * need view, writes need edit, and the refusal happens before any DB
 * module is touched (they are stubbed to throw a recognisable error).
 */

import { describe, it, expect, vi } from 'vitest';

// `vi.mock` factories are hoisted above every declaration, so what they
// share has to be hoisted with them.
const { DB_TOUCHED, throwing } = vi.hoisted(() => {
  const DB_TOUCHED = 'db touched';
  // Every named export throws; module-shape probes (`then`, symbols,
  // `default`) answer undefined so the loader does not trip over them.
  const throwing = () =>
    new Proxy(
      {},
      {
        has: () => true,
        get: (_t, key) =>
          typeof key === 'symbol' || key === 'then' || key === 'default' || key === '__esModule'
            ? undefined
            : () => {
                throw new Error(DB_TOUCHED);
              },
      },
    );
  return { DB_TOUCHED, throwing };
});

vi.mock('../../db/maps.js', () => throwing());
vi.mock('../../db/nodes.js', () => throwing());
vi.mock('../../db/events.js', () => throwing());
vi.mock('../../db/fleet.js', () => throwing());
vi.mock('../../db/asks.js', () => throwing());
vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../embeddings.js', () => ({ scheduleEmbedNode: vi.fn() }));
vi.mock('../../services/orchestration.js', () => throwing());
vi.mock('../../services/unblock.js', () => throwing());
vi.mock('../../services/asks.js', () => throwing());
vi.mock('../../services/fleetJournal.js', () => throwing());
vi.mock('../../sync/closedIssueAudit.js', () => throwing());
vi.mock('../../lib/githubContext.js', () => throwing());
vi.mock('../../lib/media.js', () => throwing());
vi.mock('../../lib/attachmentText.js', () => throwing());

vi.mock('../../db/permissions.js', () => {
  const levels: Record<string, number> = { view: 1, edit: 2, admin: 3 };
  return {
    getPermission: async (mapId: string, userId: string) =>
      ({ 'map-view': 'view', 'map-edit': 'edit' }[mapId] && userId === 'u1' ? ({ 'map-view': 'view', 'map-edit': 'edit' }[mapId] as string) : null),
    hasPermission: (actual: string | null, required: string) =>
      !!actual && levels[actual] >= levels[required],
  };
});

import { createChatBackend, CHAT_BACKEND_ADMIN_METHODS, CHAT_BACKEND_READ_METHODS, CHAT_BACKEND_UNSCOPED_METHODS } from '../backend.js';
import type { ToolBackend } from '@mindblown/tool-kit';

type AnyFn = (...args: unknown[]) => Promise<unknown>;

function scopedMethods(backend: ToolBackend): string[] {
  return Object.keys(backend).filter(
    (k) => typeof (backend as unknown as Record<string, unknown>)[k] === 'function' && !CHAT_BACKEND_UNSCOPED_METHODS.has(k as keyof ToolBackend),
  );
}

async function outcome(fn: AnyFn, ...args: unknown[]): Promise<string> {
  try {
    await fn(...args);
    return 'ok';
  } catch (err) {
    return (err as Error).message;
  }
}

describe('chat backend — map guard', () => {
  const backend = createChatBackend('u1');
  const asRecord = backend as unknown as Record<string, AnyFn>;

  it('covers every method except the unscoped two', () => {
    const scoped = scopedMethods(backend);
    expect(scoped.length).toBeGreaterThan(20);
    expect(scoped).not.toContain('listMaps');
    expect(scoped).not.toContain('createMap');
    for (const name of CHAT_BACKEND_READ_METHODS) expect(scoped).toContain(name);
  });

  it('refuses a map the user cannot see, before touching the database', async () => {
    for (const name of scopedMethods(backend)) {
      const msg = await outcome(asRecord[name], 'map-none', 'x', 'y', 'z');
      expect(msg, name).toMatch(/access to this map|edit permission|admin permission/);
      expect(msg, name).not.toBe(DB_TOUCHED);
    }
  });

  it('refuses a missing mapId outright', async () => {
    for (const name of scopedMethods(backend)) {
      expect(await outcome(asRecord[name], undefined, 'x'), name).toMatch(/mapId is required/);
    }
  });

  it('a viewer may read but not write', async () => {
    for (const name of scopedMethods(backend)) {
      const msg = await outcome(asRecord[name], 'map-view', 'x', 'y', 'z');
      if (CHAT_BACKEND_READ_METHODS.has(name as keyof ToolBackend)) {
        // Past the guard: the stubbed DB is what stops it now.
        expect(msg, name).not.toMatch(/access to this map|edit permission|admin permission/);
      } else if (CHAT_BACKEND_ADMIN_METHODS.has(name as keyof ToolBackend)) {
        expect(msg, name).toMatch(/admin permission/);
      } else {
        expect(msg, name).toMatch(/edit permission/);
      }
    }
  });

  it('an editor gets past the guard on every method except the admin ones', async () => {
    for (const name of scopedMethods(backend)) {
      const msg = await outcome(asRecord[name], 'map-edit', 'x', 'y', 'z');
      if (CHAT_BACKEND_ADMIN_METHODS.has(name as keyof ToolBackend)) {
        expect(msg, name).toMatch(/admin permission/);
      } else {
        expect(msg, name).not.toMatch(/access to this map|edit permission|admin permission/);
      }
    }
  });

  it('deleting the map needs admin, as REST does', () => {
    expect(CHAT_BACKEND_ADMIN_METHODS.has('deleteMap')).toBe(true);
  });

  it('leaves the unscoped methods alone', async () => {
    // listMaps reaches the (throwing) DB straight away — no guard in between.
    expect(await outcome(asRecord.listMaps)).toBe(DB_TOUCHED);
  });
});
