/**
 * flag_blocker with a kind, and the hourly classification of blockers set
 * without one (core blockerKinds.ts). Every node write goes the hand-edit
 * way: nodeDb + change events + claim trail + broadcast + outbound sync.
 *
 *   question     blockedReason + blockerInfo {question, answerer, options}
 *                → a question row on the Questions card (derivedAsks)
 *   person-step  the needs-human fix: tag, "Next step (a person): …"
 *   external     blockedReason + blockerInfo {external, recheckAt}
 *                → a re-check row on the card once the date has come
 *   waits-on     a finish-to-start dependency, no blocker
 */
import {
  answererName,
  blockerRefs,
  buildIsDonePredicate,
  classifyUnkinded,
  externalRecheckAt,
  isForgeLink,
  isWorkerNote,
  unkindedDue,
  waitedOnNode,
  type BlockerInfo,
  type FlagBlockerKind,
  type MindMap,
  type Node as CoreNode,
} from '@mindblown/core';
import * as nodeDb from '../db/nodes.js';
import * as mapDb from '../db/maps.js';
import { userAnswerer } from '../db/answerer.js';
import { recordClaimTransition, recordFieldChanges } from '../db/events.js';
import { broadcast } from '../ws.js';
import { syncNodeToGitHub } from '../routes/nodes.js';
import { applyLintFix } from '../lint/fix.js';

export class FlagBlockerError extends Error {
  constructor(
    public readonly code: 'NODE_NOT_FOUND' | 'BAD_INPUT' | 'NO_TARGET',
    message: string,
  ) {
    super(message);
    this.name = 'FlagBlockerError';
  }
}

export interface FlagBlockerInput {
  /** Omitted = an unkinded blocker (old clients): classified after an hour. */
  kind?: FlagBlockerKind;
  reason: string;
  /** question: who answers — default the map owner. */
  answerer?: string | null;
  /** question: the answers to offer. */
  options?: string[];
  /** external: days until it is asked again (default 7). */
  recheckDays?: number;
  /** waits-on: the ticket — a node id, or "#12" / "owner/repo#12" of its issue or PR. Default: the one the reason names. */
  waitsOn?: string | null;
}

export interface FlagBlockerOutcome {
  node: CoreNode;
  kind: FlagBlockerKind | null;
  changedFields: string[];
  /** waits-on: the ticket it now depends on. */
  dependsOn?: { id: string; text: string };
}

/** The map owner's answerer name (db/answerer) — the default answerer of a blocker question, lint and gate asks. */
export async function mapOwnerAnswerer(map: Pick<MindMap, 'createdBy'>): Promise<string> {
  return map.createdBy ? await userAnswerer(map.createdBy).catch(() => answererName(null)) : answererName(null);
}

async function fanOut(mapId: string, userId: string | null, before: CoreNode, updated: CoreNode, changedFields: string[]): Promise<void> {
  await recordFieldChanges(mapId, updated.id, userId, before, updated).catch(() => {});
  const becameBlocked = updated.blockedReason != null && before.blockedReason == null;
  await recordClaimTransition(mapId, updated.id, userId, before, updated, {
    reason: becameBlocked ? 'blocked' : 'release',
    note: becameBlocked ? updated.blockedReason : null,
  }).catch(() => {});
  broadcast(mapId, { type: 'node:updated', nodeId: updated.id, fields: changedFields, node: updated });
  syncNodeToGitHub(updated, changedFields).catch(() => {});
}

/** The ticket `ref` names on this map: a node id, or the node linked to issue/PR "#12" / "owner/repo#12". */
function resolveTarget(ref: string, nodes: CoreNode[]): CoreNode | null {
  const r = ref.trim();
  const byId = nodes.find((n) => n.id === r);
  if (byId) return byId;
  for (const want of blockerRefs(r.includes('#') ? r : `#${r}`)) {
    const hit = nodes.find((n) =>
      (n.externalLinks ?? []).some((l) => {
        if (!isForgeLink(l)) return false;
        const m = /^(.+)#(\d+)$/.exec(l.externalId);
        return m != null && Number(m[2]) === want.number && (want.repo == null || m[1].toLowerCase() === want.repo);
      }),
    );
    if (hit) return hit;
  }
  return null;
}

/**
 * Depend on `target` (finish-to-start) instead of waiting in a blocker.
 * `clearBlocker`: the free text it replaces goes too.
 */
async function dependOn(
  mapId: string,
  before: CoreNode,
  target: CoreNode,
  userId: string | null,
  clearBlocker: boolean,
): Promise<FlagBlockerOutcome> {
  if (target.id === before.id) throw new FlagBlockerError('BAD_INPUT', 'A node cannot wait on itself');
  const input: nodeDb.UpdateNodeInput = {};
  const changedFields: string[] = [];
  if (!before.dependencies.some((d) => d.targetNodeId === target.id)) {
    input.dependencies = [...before.dependencies, { targetNodeId: target.id, type: 'FS', lag: 0 }];
    changedFields.push('dependencies');
  }
  if (clearBlocker && before.blockedReason) {
    input.blockedReason = null;
    changedFields.push('blockedReason');
  }
  let node = before;
  if (changedFields.length > 0) {
    const updated = await nodeDb.updateNode(before.id, input);
    if (!updated) throw new FlagBlockerError('NODE_NOT_FOUND', `Node ${before.id} vanished`);
    await fanOut(mapId, userId, before, updated, changedFields);
    node = updated;
  }
  return { node, kind: 'waits-on', changedFields, dependsOn: { id: target.id, text: target.text } };
}

export async function flagBlocker(mapId: string, nodeId: string, input: FlagBlockerInput, userId: string | null, now: Date = new Date()): Promise<FlagBlockerOutcome> {
  const data = await mapDb.getMap(mapId);
  const before = data?.nodes.find((n) => n.id === nodeId);
  if (!data || !before) throw new FlagBlockerError('NODE_NOT_FOUND', `Node ${nodeId} not found`);
  const reason = (input.reason ?? '').trim();
  const kind = input.kind ?? null;

  if (kind === 'waits-on') {
    const isDone = buildIsDonePredicate(data.map.statusWorkflow ?? []);
    const target = input.waitsOn?.trim()
      ? resolveTarget(input.waitsOn, data.nodes.filter((n) => n.id !== nodeId))
      : waitedOnNode({ id: nodeId, blockedReason: reason }, data.nodes, isDone);
    if (!target) {
      throw new FlagBlockerError(
        'NO_TARGET',
        input.waitsOn?.trim()
          ? `No node on this map is "${input.waitsOn}" (a node id, or the #number of its linked issue / PR)`
          : 'waits-on needs the ticket it waits on: pass waitsOn (a node id or "#12"), or name its issue / PR in the reason',
      );
    }
    // Only free text (or nothing) gives way to the dependency; a question or an external wait stays.
    return dependOn(mapId, before, target, userId, !before.blockerInfo && !isWorkerNote(before.blockedReason));
  }

  if (!reason) throw new FlagBlockerError('BAD_INPUT', 'reason must not be empty');

  if (kind === 'person-step') {
    // The step is the new text; an earlier blocker text would be put on top as a second step.
    const out = await applyLintFix(mapId, nodeId, 'needs-human', userId, { note: reason });
    return { node: out.node, kind, changedFields: out.changedFields };
  }

  let blockerInfo: BlockerInfo | null = null;
  if (kind === 'question') {
    const options = (input.options ?? []).map((o) => o.trim()).filter(Boolean);
    blockerInfo = { kind: 'question', answerer: input.answerer?.trim() || (await mapOwnerAnswerer(data.map)), ...(options.length ? { options } : {}) };
  } else if (kind === 'external') {
    const days = input.recheckDays;
    if (days !== undefined && (!Number.isFinite(days) || days < 0)) throw new FlagBlockerError('BAD_INPUT', 'recheckDays must be a number ≥ 0');
    blockerInfo = { kind: 'external', recheckAt: externalRecheckAt(now, days) };
  } else if (kind !== null) {
    throw new FlagBlockerError('BAD_INPUT', `Unknown kind "${String(kind)}" — question, person-step, external or waits-on`);
  }

  const patch: nodeDb.UpdateNodeInput = { blockedReason: reason, ...(kind ? { blockerInfo } : {}) };
  const updated = await nodeDb.updateNode(nodeId, patch);
  if (!updated) throw new FlagBlockerError('NODE_NOT_FOUND', `Node ${nodeId} vanished`);
  const changedFields = ['blockedReason', ...(kind ? ['blockerInfo'] : [])];
  await fanOut(mapId, userId, before, updated, changedFields);
  return { node: updated, kind, changedFields };
}

/** One unkinded blocker and what the classification makes of it. */
export interface BlockerTriageItem {
  nodeId: string;
  text: string;
  reason: string;
  /** waits-on: the open ticket the text names; question: an ask to `answerer`. */
  plan: { kind: 'waits-on'; targetNodeId: string; targetText: string } | { kind: 'question'; answerer: string };
  error?: string;
}

export interface BlockerTriageMap {
  mapId: string;
  mapName: string;
  items: BlockerTriageItem[];
}

/**
 * Classify the unkinded blockers of these maps (default: every live map)
 * that have sat UNKINDED_GRACE_MINUTES: a dependency when the text names
 * an open ticket/PR of the same map, else a question to the map owner.
 * Fleet workers' notes are left alone. `dryRun` lists without writing —
 * the one-time run over today's blockers goes through it first.
 */
export async function classifyUnkindedBlockers(
  /** legacy: also blockers from before blockedAt existed — the one-time run (scripts/classify-blockers.ts). */
  opts: { mapIds?: string[]; dryRun?: boolean; legacy?: boolean; now?: Date; userId?: string | null } = {},
): Promise<BlockerTriageMap[]> {
  const now = opts.now ?? new Date();
  const mapIds = opts.mapIds ?? (await mapDb.listMaps()).filter((m) => !m.archivedAt).map((m) => m.id);
  const out: BlockerTriageMap[] = [];
  for (const mapId of mapIds) {
    const data = await mapDb.getMap(mapId);
    if (!data || data.map.archivedAt) continue;
    const isDone = buildIsDonePredicate(data.map.statusWorkflow ?? []);
    const due = data.nodes.filter((n) => !isDone(n.status) && unkindedDue(n, now, { legacy: opts.legacy }));
    if (due.length === 0) continue;
    const answerer = await mapOwnerAnswerer(data.map);
    const byId = new Map(data.nodes.map((n) => [n.id, n]));
    const items: BlockerTriageItem[] = [];
    for (const node of due) {
      const plan = classifyUnkinded(node, data.nodes, isDone);
      const item: BlockerTriageItem = {
        nodeId: node.id,
        text: node.text,
        reason: node.blockedReason!.trim(),
        plan: plan.kind === 'waits-on' ? { kind: 'waits-on', targetNodeId: plan.targetNodeId, targetText: byId.get(plan.targetNodeId)?.text ?? '' } : { kind: 'question', answerer },
      };
      items.push(item);
      if (opts.dryRun) continue;
      try {
        if (plan.kind === 'waits-on') {
          await dependOn(mapId, node, byId.get(plan.targetNodeId)!, opts.userId ?? null, true);
        } else {
          // The same text keeps its clock; only the kind is written.
          const updated = await nodeDb.updateNode(node.id, { blockerInfo: { kind: 'question', answerer, auto: true } });
          if (updated) broadcast(mapId, { type: 'node:updated', nodeId: node.id, fields: ['blockerInfo'], node: updated });
        }
      } catch (err) {
        item.error = err instanceof Error ? err.message : String(err);
      }
    }
    out.push({ mapId, mapName: data.map.name, items });
  }
  return out;
}

/** The timer's run: every live map, for real. */
export async function runBlockerTriage(now: Date = new Date()): Promise<{ maps: number; classified: number; errors: string[] }> {
  const maps = await classifyUnkindedBlockers({ now });
  const items = maps.flatMap((m) => m.items);
  return {
    maps: maps.length,
    classified: items.filter((i) => !i.error).length,
    errors: items.filter((i) => i.error).map((i) => `${i.nodeId.slice(0, 8)}: ${i.error}`),
  };
}
