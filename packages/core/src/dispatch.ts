/**
 * Pull-queue predicates shared by the server (get_next_ticket) and the
 * mindmap client (Dispatch card in the PM cockpit).
 *
 * The client renders "what would the fleet pull right now?" from the map it
 * already holds, so it must apply exactly the fence the server applies —
 * a second, slightly different reading of the gate would show a healthy
 * queue while every satellite gets `reason: empty`, or the reverse. Same
 * reason the PR gates moved into core: one predicate, two consumers.
 *
 * Vocabulary is deliberately tiny: `version:<versionId>` and `type:bug`.
 * Unknown entries match NOTHING (fail-closed): a typo in the gate empties
 * the queue loudly instead of silently opening the fence.
 */
import type { Node, NodeMap, StatusDef } from './types.js';
import { effectiveVersionId } from './versions.js';
import { isReady } from './dependencies.js';
import { buildIsDonePredicate, buildTodoIds } from './statusWorkflow.js';

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

/** Bug detection for gate/policy purposes: node carries the "bug" tag
 *  (node.tags mirrors GitHub labels, so a GH `bug` label counts). */
export function isBugNode(node: Pick<Node, 'tags'>): boolean {
  return node.tags.some((t) => t.toLowerCase() === 'bug');
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
 * no status), unclaimed, with every dependency predecessor done. This is
 * the exact filter `selectPullCandidates` applies server-side.
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
  /** Pullable AND inside the gate — what the fleet can actually receive. */
  inGate: number;
  /** In-gate tickets the queue will refuse (tagged needs-brief on a prior pull). */
  needsBrief: number;
  /** In-gate tickets without an effort estimate. */
  unestimated: number;
  /**
   * Pullable tickets with NO effective version while the gate fences on a
   * version — invisible to the fleet until someone versions them. The
   * release-focus failure mode named in the Leidang design.
   */
  unversionedOutsideGate: number;
  /** Gate entries the server cannot interpret — each one empties the queue. */
  unknownGateEntries: string[];
  /** In-gate ticket ids, for drill-down lists. */
  inGateIds: string[];
  state: DispatchState;
}

/**
 * What the pull queue looks like right now, from a full node list.
 *
 * `state` precedence mirrors the server's refusal order: hold (cap 0) →
 * full (claims ≥ cap) → empty (nothing pullable inside the gate) →
 * running. "empty" with a cap > 0 is the phase-change signal from the
 * design (queue ran dry), OR a fail-closed gate — `unknownGateEntries`
 * tells the two apart.
 */
export function dispatchQueueSnapshot(
  nodes: Node[],
  opts: { workflow: StatusDef[]; cap: number; gate: string[] },
): DispatchQueueSnapshot {
  const cap = Math.max(0, Math.floor(opts.cap));
  const activeClaims = nodes.filter((n) => n.claimedBySession !== null).length;
  const { pullable, nodeMap } = pullableNodes(nodes, opts.workflow);
  const inGate = pullable.filter((n) => matchesDispatchGate(n, opts.gate, nodeMap));
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
    needsBrief: inGate.filter((n) => n.tags.includes(NEEDS_BRIEF_TAG)).length,
    unestimated: inGate.filter((n) => n.effortEstimate === null).length,
    unversionedOutsideGate,
    unknownGateEntries,
    inGateIds: inGate.map((n) => n.id),
    state,
  };
}
