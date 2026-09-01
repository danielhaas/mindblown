/**
 * Pull-queue predicates shared by the server (get_next_ticket) and the
 * mindmap client (Dispatch card in the PM cockpit).
 *
 * The client renders "what would the fleet pull right now?" from the map it
 * already holds, so it must apply exactly the fence the server applies —
 * a second, slightly different reading of the gate would show a healthy
 * queue while every satellite gets `reason: empty`, or the reverse. Same
 * reason the PR gates moved into core: one predicate, two consumers.
 * `selectPullCandidates` (server) builds on `pullableNodes`, `matchesDispatchGate`
 * and `hasBrief` from here; `dispatchQueueSnapshot` is the read-only view.
 *
 * Vocabulary is deliberately tiny: `version:<versionId>` and `type:bug`.
 * Unknown entries match NOTHING (fail-closed): a typo in the gate empties
 * the queue loudly instead of silently opening the fence.
 */
import type { Node, NodeMap, StatusDef } from './types.js';
import { effectiveVersionId } from './versions.js';
import { isReady } from './dependencies.js';
import { buildIsDonePredicate, buildTodoIds } from './statusWorkflow.js';
import { proseMirrorToPlainText } from './richtext.js';

/** Default ranking when `dispatchPolicy` is empty. */
export const DEFAULT_DISPATCH_POLICY = ['bugs', 'priority', 'age'];

/** Every key `dispatchPolicy` understands, in the order the UI offers them. */
export const DISPATCH_POLICY_KEYS = ['bugs', 'size', 'priority', 'age'] as const;
export type DispatchPolicyKey = (typeof DISPATCH_POLICY_KEYS)[number];

/** Tag auto-applied to ready nodes the pull queue refuses to hand out. */
export const NEEDS_BRIEF_TAG = 'needs-brief';

/** Gate entry that fences the queue to bug-tagged tickets. */
export const GATE_BUGS_ONLY = 'type:bug';
export const GATE_VERSION_PREFIX = 'version:';

/** Bug detection for gate/policy purposes: node carries the "bug" or
 *  "type:bug" tag, case-insensitive (node.tags mirrors GitHub labels, and
 *  the label mirror writes `type:bug`, so both spellings must count). */
export function isBugNode(node: Pick<Node, 'tags'>): boolean {
  return node.tags.some((t) => {
    const tag = t.toLowerCase();
    return tag === 'bug' || tag === 'type:bug';
  });
}

/**
 * Empty-brief guard: a ticket is dispatchable only if the worker gets a
 * self-contained brief — a non-empty description, or a linked GitHub
 * issue it can read (inbound sync copies issue bodies into the
 * description, so a linked node normally carries the text locally too).
 * This is the predicate; the `needs-brief` TAG is only the trace the pull
 * leaves behind and is never removed when a brief is added later.
 */
export function hasBrief(node: Pick<Node, 'description' | 'externalLinks'>): boolean {
  if (proseMirrorToPlainText(node.description).trim() !== '') return true;
  return node.externalLinks.some((l) => l.provider === 'github');
}

/** Tag the fleet's give-up path (blocked.sh) sets next to status=blocked + blockedReason. */
export const BLOCKED_TAG = 'blocked';

export interface UnblockPlan {
  /** New status, or undefined when the status stays as it is. */
  status?: string | null;
  /** Tags to remove — empty when the node never carried the blocked tag. */
  tagsRemove: string[];
}

/**
 * What "release this ticket back to the queue" writes, given the node and
 * the map's workflow. Three fields latch a parked ticket out of the pull
 * queue (status, blockedReason, tag); undoing one of them leaves it stuck
 * and invisible — the old clear_blocker did exactly that.
 *
 * Status rule: back to the workflow's first todo status (null when the
 * map has none — null is the todo category too) for `blocked` (not a
 * workflow status), null, and any workflow status outside `done` — an
 * in_progress ticket whose worker gave up is re-queued too, the queue is
 * where it gets picked up again. Left alone: done (finished work is never
 * re-opened), a status id the workflow does not know other than `blocked`
 * (e.g. a legacy `cancelled` on a map without it — no guessing), and a
 * node that is STILL CLAIMED: a PM click must not pull the ticket from
 * under a running worker, and a claimed node is not pullable anyway, so a
 * status flip would only lie about "pullable again". blocked.sh releases
 * its own claim before it stops, so the fleet path never hits this.
 */
export function planUnblock(
  node: Pick<Node, 'status' | 'tags' | 'claimedBySession'>,
  workflow: StatusDef[],
): UnblockPlan {
  const tagsRemove = node.tags.includes(BLOCKED_TAG) ? [BLOCKED_TAG] : [];
  const current = node.status;
  const def =
    current === null
      ? undefined
      : workflow.find((s) => s.id === current || s.name.toLowerCase() === current.toLowerCase());
  if (def?.category === 'done') return { tagsRemove };
  if (node.claimedBySession) return { tagsRemove };
  if (def === undefined && current !== null && current !== BLOCKED_TAG) return { tagsRemove };
  const target = workflow.find((s) => s.category === 'todo')?.id ?? null;
  if (current === target) return { tagsRemove };
  return { status: target, tagsRemove };
}

export type GateEntry =
  | { kind: 'version'; raw: string; versionId: string }
  | { kind: 'bugs'; raw: string }
  | { kind: 'unknown'; raw: string };

/** Classify each gate entry so a UI can render/validate it. */
export function parseGateEntry(raw: string): GateEntry {
  if (raw === GATE_BUGS_ONLY) return { kind: 'bugs', raw };
  if (raw.startsWith(GATE_VERSION_PREFIX) && raw.length > GATE_VERSION_PREFIX.length) {
    return { kind: 'version', raw, versionId: raw.slice(GATE_VERSION_PREFIX.length) };
  }
  return { kind: 'unknown', raw };
}

/**
 * AND-filter over the map's dispatchGate. Empty gate = no fence.
 * `version:` matches the node's EFFECTIVE version (own or inherited from
 * the nearest versioned ancestor), not only `node.versionId`.
 */
export function matchesDispatchGate(node: Node, gate: string[], nodeMap: NodeMap): boolean {
  return gate.every((entry) => {
    const parsed = parseGateEntry(entry);
    if (parsed.kind === 'bugs') return isBugNode(node);
    if (parsed.kind === 'version') return effectiveVersionId(node.id, nodeMap) === parsed.versionId;
    return false;
  });
}

/**
 * The pullable set BEFORE the gate: a non-root node in a todo status (or
 * no status), unclaimed, with every dependency predecessor done. The
 * server's `selectPullCandidates` starts from exactly this set.
 */
export function pullableNodes(nodes: Node[], workflow: StatusDef[]): { pullable: Node[]; nodeMap: NodeMap } {
  const isDone = buildIsDonePredicate(workflow);
  const todoIds = buildTodoIds(workflow);
  const nodeMap: NodeMap = new Map(nodes.map((n) => [n.id, n]));
  const pullable = nodes.filter(
    (n) =>
      n.parentId !== null &&
      (n.status === null || todoIds.has(n.status)) &&
      n.claimedBySession === null &&
      isReady(n, nodeMap, isDone),
  );
  return { pullable, nodeMap };
}

export type DispatchState = 'hold' | 'full' | 'empty' | 'running';

export interface DispatchQueueSnapshot {
  /** Nodes currently claimed by any session (what the cap counts). */
  activeClaims: number;
  cap: number;
  /** Pullable before the gate. */
  pullable: number;
  /** Pullable, inside the gate, WITH a brief — what a pull can actually grant. */
  inGate: number;
  /**
   * Pullable and inside the gate but without a brief — the pull refuses
   * these (and tags them `needs-brief`). Counted by the predicate, not the
   * tag, so a ticket that got its brief later drops out of this number.
   */
  needsBrief: number;
  /** Grantable (inGate) tickets without an effort estimate. */
  unestimated: number;
  /**
   * Pullable tickets with NO effective version while the gate fences on a
   * version — invisible to the fleet until someone versions them. The
   * release-focus failure mode named in the Leidang design.
   */
  unversionedOutsideGate: number;
  /** Gate entries the server cannot interpret — each one empties the queue. */
  unknownGateEntries: string[];
  /** Grantable ticket ids, for drill-down lists. */
  inGateIds: string[];
  state: DispatchState;
}

/**
 * What the pull queue looks like right now, from a full node list — the
 * FLEET-WIDE reading, i.e. what a *heavy* puller could be granted.
 * Profile routing (`profilePolicy`, server `isProfileEligible`) is not
 * modelled: it reserves P0/big tickets for heavy pullers, so a fleet with
 * only standard/light workers can receive fewer than `inGate` — how many
 * depends on the fleet's composition, which the map does not know. The
 * card says so when a profilePolicy is set. Known limitation.
 *
 * `state` precedence mirrors the server's refusal order: hold (cap 0) →
 * full (claims ≥ cap) → empty (nothing grantable inside the gate) →
 * running. "empty" with a cap > 0 is the phase-change signal from the
 * design (queue ran dry), OR a fail-closed gate, OR every in-gate ticket
 * lacking a brief — `unknownGateEntries` and `needsBrief` tell them apart.
 */
export function dispatchQueueSnapshot(
  nodes: Node[],
  opts: { workflow: StatusDef[]; cap: number; gate: string[] },
): DispatchQueueSnapshot {
  const cap = Math.max(0, Math.floor(opts.cap));
  const activeClaims = nodes.filter((n) => n.claimedBySession !== null).length;
  const { pullable, nodeMap } = pullableNodes(nodes, opts.workflow);
  const gated = pullable.filter((n) => matchesDispatchGate(n, opts.gate, nodeMap));
  const inGate = gated.filter(hasBrief);
  const gateHasVersion = opts.gate.some((g) => parseGateEntry(g).kind === 'version');
  const unversionedOutsideGate = gateHasVersion
    ? pullable.filter((n) => effectiveVersionId(n.id, nodeMap) === null).length
    : 0;
  const unknownGateEntries = opts.gate.filter((g) => parseGateEntry(g).kind === 'unknown');

  let state: DispatchState;
  if (cap === 0) state = 'hold';
  else if (activeClaims >= cap) state = 'full';
  else if (inGate.length === 0) state = 'empty';
  else state = 'running';

  return {
    activeClaims,
    cap,
    pullable: pullable.length,
    inGate: inGate.length,
    needsBrief: gated.length - inGate.length,
    unestimated: inGate.filter((n) => n.effortEstimate === null).length,
    unversionedOutsideGate,
    unknownGateEntries,
    inGateIds: inGate.map((n) => n.id),
    state,
  };
}
