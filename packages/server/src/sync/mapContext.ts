/**
 * Map-context summarizer for the AI triage pipeline (#92, #93).
 *
 * The triage prompt needs a compact view of "what does this map contain?"
 * so Claude can decide whether an inbound issue belongs at all and, if so,
 * which top-level epic to place it under. The summary covers:
 *
 *   - map name + description
 *   - every direct child of the root node (depth-1), with description text
 *
 * The exclusions are deliberate:
 *   - We do NOT walk the whole subtree. Two reasons: (1) prompt size — a
 *     mature map can have hundreds of nodes, and triage is a cheap
 *     classification step that should fit in a couple of K of tokens.
 *     (2) Operator-friendly defaults: depth-1 nodes ARE the "buckets" most
 *     teams already use to organise a map. Going deeper would force the
 *     LLM to pick a too-specific parent it has no business choosing.
 *   - The GitHub Inbox node IS included as an epic candidate. That's
 *     intentional — the triage pipeline can still legitimately route
 *     low-context issues to the inbox if nothing else fits.
 *
 * Caching: the result is memoised per mapId for 5 minutes. Map structure
 * changes infrequently relative to webhook ticks, and a stale cache costs
 * at most one extra retry on the next tick (Claude doesn't fail on an
 * outdated parent list; the operator can override). The cache also
 * invalidates explicitly via `invalidateMapContext(mapId)` — wired from
 * `nodeDb.createNode/updateNode/deleteNode` whenever a depth-1 node
 * changes, so the next triage call sees the up-to-date picture.
 *
 * The 5-min TTL is a fallback. The cache key is mapId, so a per-map
 * invalidation never clobbers other maps' entries.
 */

import { and, eq } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { maps, nodes } from '../db/schema.js';
import { notDeleted } from '../db/nodes.js';

// ── Public types ──────────────────────────────────────────────────

export interface MapContextEpic {
  nodeId: string;
  title: string;
  /** Empty string if the epic has no description set. */
  description: string;
}

export interface MapContext {
  mapId: string;
  mapName: string;
  mapDescription: string;
  /**
   * Direct children of the root node, in `childrenOrder` order. The
   * triage prompt presents these as the available "buckets" for a
   * place-decision. Empty array if the map has no epics yet (e.g. a
   * brand-new map with only the root + inbox).
   */
  epics: MapContextEpic[];
}

// ── Cache ─────────────────────────────────────────────────────────

interface CacheEntry {
  context: MapContext;
  expiresAt: number;
}

const TTL_MS = 5 * 60 * 1000; // 5 minutes
const cache = new Map<string, CacheEntry>();

/**
 * Drop the cached context for a specific map. Called from the node CRUD
 * helpers whenever a depth-1 child of the root is touched (created,
 * updated, deleted, or moved). Safe to call for any node mutation — the
 * mapContext cache key is mapId, so a wasted invalidation just forces
 * one extra DB round-trip on the next triage call. Cheap.
 */
export function invalidateMapContext(mapId: string): void {
  cache.delete(mapId);
}

/**
 * Drop the entire cache. Test-only escape hatch; production code paths
 * use `invalidateMapContext(mapId)` so unrelated maps don't pay for
 * one map's churn.
 */
export function _clearMapContextCacheForTests(): void {
  cache.clear();
}

// ── ProseMirror description → plain text ──────────────────────────

/**
 * Map node descriptions are stored as ProseMirror JSON (rich text), but
 * the triage prompt only needs plain text. Walk the doc and concatenate
 * every leaf `text` node, joining paragraphs with a single newline so
 * Claude sees something readable without HTML/JSON noise.
 *
 * Strings pass through unchanged so we tolerate legacy nodes whose
 * description was saved as a raw string before the ProseMirror migration.
 * Returns empty string for null/undefined/unknown shapes.
 */
export function proseMirrorToPlainText(description: unknown): string {
  if (description == null) return '';
  if (typeof description === 'string') return description;
  if (typeof description !== 'object') return '';

  const lines: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const obj = node as { type?: string; text?: unknown; content?: unknown };
    if (obj.type === 'text' && typeof obj.text === 'string') {
      lines.push(obj.text);
      return;
    }
    if (Array.isArray(obj.content)) {
      const before = lines.length;
      for (const child of obj.content) walk(child);
      // Treat block-level nodes as paragraph breaks. We don't try to
      // recreate exact formatting; the triage prompt only needs the gist.
      const isBlock = obj.type !== undefined && obj.type !== 'text' && obj.type !== 'doc';
      if (isBlock && lines.length > before) {
        lines.push('\n');
      }
    }
  };
  walk(description);
  return lines.join('').replace(/\n{3,}/g, '\n\n').trim();
}

// ── Builder ───────────────────────────────────────────────────────

/**
 * Build (or return cached) MapContext for the given map. Throws if the
 * map doesn't exist or has no root node — those are the same invariants
 * any other map-scoped sync helper relies on, so propagating the throw
 * keeps the failure mode consistent.
 */
export async function buildMapContext(mapId: string): Promise<MapContext> {
  const cached = cache.get(mapId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.context;
  }

  const [mapRow] = await db
    .select({
      id: maps.id,
      name: maps.name,
      description: maps.description,
      rootNodeId: maps.rootNodeId,
    })
    .from(maps)
    .where(eq(maps.id, mapId));
  if (!mapRow) {
    throw new Error(`buildMapContext: map ${mapId} not found`);
  }
  if (!mapRow.rootNodeId) {
    throw new Error(`buildMapContext: map ${mapId} has no root node`);
  }

  const [rootRow] = await db
    .select({
      id: nodes.id,
      childrenOrder: nodes.childrenOrder,
    })
    .from(nodes)
    .where(and(eq(nodes.id, mapRow.rootNodeId), notDeleted));

  const childrenOrder = (rootRow?.childrenOrder as string[]) ?? [];

  let epics: MapContextEpic[] = [];
  if (childrenOrder.length > 0) {
    // Fetch all depth-1 nodes in one batch, then re-order to match
    // childrenOrder so the LLM sees them in the same order the operator
    // does in the UI.
    const childRows = await db
      .select({
        id: nodes.id,
        text: nodes.text,
        description: nodes.description,
        parentId: nodes.parentId,
      })
      .from(nodes)
      .where(and(eq(nodes.parentId, mapRow.rootNodeId), notDeleted));
    const byId = new Map(childRows.map((r) => [r.id, r]));
    epics = childrenOrder
      .map((id) => byId.get(id))
      .filter((r): r is (typeof childRows)[number] => r != null)
      .map((r) => ({
        nodeId: r.id,
        title: r.text,
        description: proseMirrorToPlainText(r.description),
      }));
  }

  const context: MapContext = {
    mapId,
    mapName: mapRow.name,
    mapDescription: mapRow.description ?? '',
    epics,
  };
  cache.set(mapId, { context, expiresAt: Date.now() + TTL_MS });
  return context;
}
