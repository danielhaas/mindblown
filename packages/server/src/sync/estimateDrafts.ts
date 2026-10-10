/**
 * AI estimate drafts (#318): committed work never sits on a null estimate.
 *
 * Every 10 minutes, on each map that is not archived, has drafts switched
 * on (`maps.ai_estimate_drafts`, default true) and an AI policy other than
 * `none`: leaves that are committed work — a todo / in-progress status, or
 * in the map's active version — and still have no estimate get one from
 * `estimateEffort` (the calibrated prompt behind /api/ai/estimate), stored
 * with `estimateSource: 'ai'` so it reads as a draft until a person sets or
 * accepts it. A sweep rather than a hook on every lane-entry path
 * (assign_to_version, bulk assigns, ingest, status writes, the UI): it
 * catches all of them and absorbs bulk waves by its per-map cap.
 *
 * Local model only. This runs unattended; it must never spend cloud credits
 * or send a map's content to a cloud provider nobody chose for it. With no
 * reachable local backend the whole run is skipped.
 */
import { isNull } from 'drizzle-orm';
import { proseMirrorToPlainText, resolveStatusDef, type Node as CoreNode } from '@mindblown/core';
import { db } from '../db/connection.js';
import { maps } from '../db/schema.js';
import * as mapDb from '../db/maps.js';
import * as nodeDb from '../db/nodes.js';
import * as versionDb from '../db/versions.js';
import { aiEnabled } from '../ai/client.js';
import { localChatUsable } from '../ai/health.js';
import { getMapAiPolicy } from '../ai/policy.js';
import { ollamaProvider } from '../ai/providers/ollama.js';
import { estimateEffort } from '../ai/estimate.js';
import { pickActiveLane } from '../lib/activeLane.js';
import { broadcast } from '../ws.js';

/** Drafts per map per run — bulk lane entries drain over a few runs. */
export const DRAFTS_PER_MAP = 5;
/** A node whose draft failed is left alone this long. */
const RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
const failedAt = new Map<string, number>();

export interface EstimateDraftsResult {
  drafted: number;
  maps: number;
  errors: string[];
  /** Why nothing ran, when nothing could. */
  skipped?: 'no-local-model';
}

/** Unestimated leaves that are committed work, oldest first. Pure. */
export function draftCandidates(
  nodes: CoreNode[],
  workflow: Parameters<typeof resolveStatusDef>[0],
  activeLaneId: string | null,
  now: number = Date.now(),
): CoreNode[] {
  const live = nodes.filter((n) => !n.deletedAt);
  const hasLiveChild = new Set(live.map((n) => n.parentId).filter((id): id is string => id != null));
  return live
    .filter((n) => {
      if (hasLiveChild.has(n.id) || n.parentId == null) return false;
      if (n.effortEstimate != null) return false;
      if ((n.percentComplete ?? 0) >= 100) return false;
      const category = resolveStatusDef(workflow, n.status)?.category;
      if (category === 'done') return false;
      const committed = category === 'todo' || category === 'in_progress' || (activeLaneId != null && n.versionId === activeLaneId);
      if (!committed) return false;
      const failed = failedAt.get(n.id);
      return failed == null || now - failed > RETRY_AFTER_MS;
    })
    .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
}

function ancestorPath(node: CoreNode, byId: Map<string, CoreNode>): string {
  const path: string[] = [];
  let current = node.parentId ? byId.get(node.parentId) : undefined;
  while (current) {
    path.unshift(current.text);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path.join(' → ');
}

export async function runEstimateDrafts(now: number = Date.now()): Promise<EstimateDraftsResult> {
  const result: EstimateDraftsResult = { drafted: 0, maps: 0, errors: [] };
  if (!aiEnabled || !localChatUsable()) return { ...result, skipped: 'no-local-model' };

  const candidatesMaps = await db
    .select({ id: maps.id, aiEstimateDrafts: maps.aiEstimateDrafts })
    .from(maps)
    .where(isNull(maps.archivedAt));

  for (const { id: mapId, aiEstimateDrafts } of candidatesMaps) {
    if (!aiEstimateDrafts) continue;
    if ((await getMapAiPolicy(mapId)) === 'none') continue;
    const detail = await mapDb.getMap(mapId);
    if (!detail) continue;
    const lane = pickActiveLane(await versionDb.listVersions(mapId));
    const picks = draftCandidates(detail.nodes, detail.map.statusWorkflow, lane?.id ?? null, now).slice(0, DRAFTS_PER_MAP);
    if (picks.length === 0) continue;
    result.maps += 1;
    const byId = new Map(detail.nodes.map((n) => [n.id, n]));

    for (const node of picks) {
      try {
        const description = proseMirrorToPlainText(node.description).trim();
        const estimate = await estimateEffort(ollamaProvider, detail, {
          text: node.text,
          description: description || undefined,
          path: ancestorPath(node, byId) || undefined,
        });
        // Re-read: someone may have estimated it while the model thought.
        const fresh = await nodeDb.getNode(node.id);
        if (!fresh || fresh.effortEstimate != null) continue;
        const updated = await nodeDb.updateNode(node.id, { effortEstimate: estimate.estimate, estimateSource: 'ai' });
        if (updated) {
          broadcast(mapId, { type: 'node:updated', nodeId: node.id, fields: ['effortEstimate', 'estimateSource'], node: updated });
          result.drafted += 1;
        }
      } catch (err) {
        failedAt.set(node.id, now);
        result.errors.push(`${node.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return result;
}

/** Test seam: forget remembered failures. */
export function _resetEstimateDraftFailures(): void {
  failedAt.clear();
}
