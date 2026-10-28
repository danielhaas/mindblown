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
import { isForgeLink } from './types.js';
import { effectiveVersionId } from './versions.js';
import { isReady } from './dependencies.js';
import { buildIsDonePredicate, buildTodoIds } from './statusWorkflow.js';
import { proseMirrorToPlainText } from './richtext.js';

/** Default ranking when `dispatchPolicy` is empty. */
export const DEFAULT_DISPATCH_POLICY = ['bugs', 'priority', 'age'];

/** Every FIXED key `dispatchPolicy` understands, in the order the UI offers
 *  them. The one parametric key (`mix:bugs=<N>`, below) is deliberately not
 *  in this list — it is not a chip the UI toggles but a valued entry with
 *  its own control, and every consumer that iterates "the plain keys"
 *  (chip pickers, per-key comparators) must not see it. */
export const DISPATCH_POLICY_KEYS = ['bugs', 'size', 'priority', 'age'] as const;
export type DispatchPolicyKey = (typeof DISPATCH_POLICY_KEYS)[number];

/** Prefix of the one parametric policy entry, `mix:bugs=<N>`. */
export const MIX_BUGS_PREFIX = 'mix:bugs=';
/** The full valid shape: integer N in 0–100, no leading zeros, no signs. */
export const MIX_BUGS_REGEX = /^mix:bugs=(100|[1-9]?[0-9])$/;

/**
 * Parse the `mix:bugs=<N>` entry out of a dispatchPolicy — the ONE shared
 * reading of the parametric key (server weave, cockpit control, MCP schema
 * all lean on this file so no second parser can drift).
 *
 * Returns the FIRST valid entry's ratio, or null when none is present.
 * Invalid shapes (`mix:bugs=101`, `mix:bugs=x`, `mix:bugs=`) are simply
 * not matched — downstream they behave like any unknown policy key:
 * inert in the sort, rejected at the tool layer.
 */
export function parseMixBugs(policy: string[]): { ratio: number } | null {
  for (const entry of policy) {
    const m = MIX_BUGS_REGEX.exec(entry);
    if (m) return { ratio: Number(m[1]) };
  }
  return null;
}

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
 * A title this long is a request in itself, not a label: "Done tickets
 * should show how long they needed …" (28.10.2026) was typed in the app
 * as a title alone and refused as briefless. The worker prompt carries the
 * title on its Ticket line, so the text reaches the agent either way.
 */
export const TITLE_BRIEF_MIN_WORDS = 10;

/**
 * Empty-brief guard: a ticket is dispatchable only if the worker gets a
 * self-contained brief — a non-empty description, a linked GitHub
 * issue it can read (inbound sync copies issue bodies into the
 * description, so a linked node normally carries the text locally too),
 * or a title of at least TITLE_BRIEF_MIN_WORDS words.
 * This is the predicate; the `needs-brief` TAG is only the trace the pull
 * leaves behind and is never removed when a brief is added later.
 */
export function hasBrief(node: Pick<Node, 'text' | 'description' | 'externalLinks'>): boolean {
  if (proseMirrorToPlainText(node.description).trim() !== '') return true;
  if ((node.text ?? '').trim().split(/\s+/).filter(Boolean).length >= TITLE_BRIEF_MIN_WORDS) return true;
  return node.externalLinks.some((l) => isForgeLink(l));
}

/** Tag the fleet's give-up path (blocked.sh) sets next to status=blocked + blockedReason. */
export const BLOCKED_TAG = 'blocked';

/**
 * "Fleet can fix it" on a worker's red-CI or merge-conflict blocker: the
 * worker that holds the claim runs its agent on the PR branch again, then
 * drops the tag (claude-fleet fleet-worker fix_pr).
 */
export const FLEET_FIX_TAG = 'fleet-fix';

/**
 * The note a fleet worker writes on a claim it keeps while its PR waits on
 * a person (red CI, a conflict, no CI, a refused merge). Session ids have no
 * spaces. Server SQL twin: db/fleets `holdsCapSlotSql`.
 */
export const WORKER_WAIT_NOTE = /^Fleet worker [^ ]+: /;

/**
 * A claim that uses up the map's / fleet's cap. The one exception: the
 * worker's own wait note on its PR, with no fix asked for — the worker
 * follows the PR but runs no agent, so the slot is free for the next
 * ticket. Every other blocker still counts: a person's Stop lands while the
 * agent runs, and a fix run (fleet-fix / fleet-check tag) is an agent.
 */
export function holdsCapSlot(node: Pick<Node, 'claimedBySession' | 'blockedReason' | 'tags'>): boolean {
  if (node.claimedBySession === null) return false;
  const waiting =
    WORKER_WAIT_NOTE.test((node.blockedReason ?? '').trim()) && !node.tags.includes(FLEET_FIX_TAG) && !node.tags.includes(FLEET_CHECK_TAG);
  return !waiting;
}

/** A blocker the fleet worker wrote about its own PR that an agent can work on: red CI, a merge conflict. */
export function fleetCanFix(blockedReason: string | null | undefined): boolean {
  return /^Fleet worker \S+: (CI failed on PR #\d+|PR #\d+ has merge conflicts)/.test((blockedReason ?? '').trim());
}

/**
 * "Fleet can fix it" on any other blocker: the queue hands the ticket out
 * again ahead of the rest, gate and blocker notwithstanding, with the
 * blocker in the brief — the agent gets past it or writes down what a
 * person must do (server orchestration claimFromMap, fleet-worker check).
 */
export const FLEET_CHECK_TAG = 'fleet-check';

/**
 * Which fix "Fleet can fix it" means: the worker's red-CI / conflict note →
 * the worker reworks its PR; else a check run. Not the MindBlown claim: the
 * worker follows its PR from its own claim file, and the node's claim can
 * be gone (released, swept) while it does — on 22.10.2026 three such PRs
 * were sent to the queue as fresh check runs, one of them over its open PR.
 */
export function fleetFixAction(blockedReason: string | null | undefined): 'fleet-fix' | 'fleet-check' {
  return fleetCanFix(blockedReason) ? 'fleet-fix' : 'fleet-check';
}

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

/** Separates the alternatives of one OR-entry: `type:bug|version:<id>`. */
export const GATE_OR = '|';

export type GateTerm =
  | { kind: 'version'; raw: string; versionId: string }
  | { kind: 'bugs'; raw: string };

export type GateEntry =
  | GateTerm
  /** Any one of `options` (#265) — e.g. "bugs, or the release". */
  | { kind: 'any'; raw: string; options: GateTerm[] }
  | { kind: 'unknown'; raw: string };

/**
 * Classify each gate entry so a UI can render/validate it.
 *
 * Entries AND together; inside one entry, `|` ORs its terms (#265). That is
 * how "bugs first, the release as fallback" is said: gate
 * `["type:bug|version:X"]` + policy `bugs` first — bugs from anywhere get
 * first refusal, the release takes the remaining capacity, and nothing else
 * leaks in. An OR-entry with any term the server cannot read is unknown as
 * a whole (fail-closed, like any other unknown entry).
 */
export function parseGateEntry(raw: string): GateEntry {
  if (raw.includes(GATE_OR)) {
    const options = raw.split(GATE_OR).map(parseGateTerm);
    if (options.length < 2 || options.some((o) => o === null)) return { kind: 'unknown', raw };
    return { kind: 'any', raw, options: options as GateTerm[] };
  }
  return parseGateTerm(raw) ?? { kind: 'unknown', raw };
}

function parseGateTerm(raw: string): GateTerm | null {
  if (raw === GATE_BUGS_ONLY) return { kind: 'bugs', raw };
  if (raw.startsWith(GATE_VERSION_PREFIX) && raw.length > GATE_VERSION_PREFIX.length) {
    return { kind: 'version', raw, versionId: raw.slice(GATE_VERSION_PREFIX.length) };
  }
  return null;
}

/** Every version id a gate names, inside OR-entries too. */
export function gateVersionIds(gate: string[]): string[] {
  return gate.flatMap((g) => {
    const p = parseGateEntry(g);
    if (p.kind === 'version') return [p.versionId];
    if (p.kind === 'any') return p.options.flatMap((o) => (o.kind === 'version' ? [o.versionId] : []));
    return [];
  });
}

/**
 * AND-filter over the map's dispatchGate; an entry with `|` matches when any
 * of its terms does (#265). Empty gate = no fence. `version:` matches the
 * node's EFFECTIVE version (own or inherited from the nearest versioned
 * ancestor), not only `node.versionId`.
 */
export function matchesDispatchGate(node: Node, gate: string[], nodeMap: NodeMap): boolean {
  const term = (t: GateTerm): boolean =>
    t.kind === 'bugs' ? isBugNode(node) : effectiveVersionId(node.id, nodeMap) === t.versionId;
  return gate.every((entry) => {
    const parsed = parseGateEntry(entry);
    if (parsed.kind === 'any') return parsed.options.some(term);
    if (parsed.kind === 'unknown') return false;
    return term(parsed);
  });
}

/**
 * The pullable set BEFORE the gate: a non-root LEAF in a todo status (or
 * no status), unclaimed, with every dependency predecessor done. The
 * server's `selectPullCandidates` starts from exactly this set.
 *
 * Leaves only, same rule as ready_nodes (#323): a node with children is a
 * container — its children are the work. The pull handed out an untagged
 * container ("Phase 2.5: Make it fun", 25.10.2026); the worker could only
 * flag a blocker on it, which held its whole subtree and emptied the queue.
 * "Has children" is read from `parentId` of the nodes passed in, so a
 * deleted child (not in the list) does not keep its parent a container.
 */
export function pullableNodes(nodes: Node[], workflow: StatusDef[]): { pullable: Node[]; nodeMap: NodeMap } {
  const isDone = buildIsDonePredicate(workflow);
  const todoIds = buildTodoIds(workflow);
  const nodeMap: NodeMap = new Map(nodes.map((n) => [n.id, n]));
  const hasChild = new Set(nodes.map((n) => n.parentId).filter((p): p is string => p !== null));
  const pullable = nodes.filter(
    (n) =>
      n.parentId !== null &&
      !hasChild.has(n.id) &&
      (n.status === null || todoIds.has(n.status)) &&
      n.claimedBySession === null &&
      isReady(n, nodeMap, isDone),
  );
  return { pullable, nodeMap };
}

/**
 * Tags that mark a ticket as NOT agent-actionable (#266) — the pre-Leidang
 * Kira dispatcher's SKIP_LABELS plus `needs-human`. A ticket carrying one
 * is never granted by get_next_ticket: it needs a person (a token scope, a
 * decision, credentials), and every worker turn spent on it came back
 * blocked. Case-insensitive.
 */
export const DISPATCH_SKIP_TAGS = ['kira-skip', 'needs-human', 'needs-daniel-input', 'needs-rita-review'] as const;

/** The skip tag a node carries, or null — the first match, as written on the node. */
export function dispatchSkipTag(node: Pick<Node, 'tags'>): string | null {
  const skip = new Set<string>(DISPATCH_SKIP_TAGS);
  // `?? []`: lint and test fixtures build nodes without tags.
  return (node.tags ?? []).find((t) => skip.has(t.toLowerCase())) ?? null;
}

/** The tag an epic leaf is held under (it shows where a skip tag would). */
export const EPIC_HOLD_TAG = 'epic';

const EPIC_TAGS = new Set(['epic', 'type:epic']);
// "#482 Epic: …", "Epic – …", "[EPIC] Source & Ingestion". Needs the colon,
// dash or brackets: "epic (danielhaas/epic)" is a repo name, not an epic.
const EPIC_TITLE = /^\s*(#\d+\s+)?(\[epic\]|epic\s*[:\-–—])/i;

/**
 * An epic sitting in the map as a leaf: its work lives in other issues or
 * sub-issues, not in the node. The pull handed #482 to an agent as if it
 * were a ticket (20.10.2026). Tag `epic` / `type:epic`, or a title that
 * starts with "Epic:" or "[EPIC]".
 */
export function isEpicLeaf(node: Pick<Node, 'tags' | 'text'>): boolean {
  return (node.tags ?? []).some((t) => EPIC_TAGS.has(t.toLowerCase())) || EPIC_TITLE.test(node.text ?? '');
}

/** Why a ticket waits for a person: a skip tag, a manual blocker, or both. */
export interface DispatchHold {
  tag: string | null;
  blockedReason: string | null;
  /** The open ancestor that carries the hold, or null when it is on the ticket itself. */
  heldBy: { id: string; text: string } | null;
}

function ownHold(node: Pick<Node, 'tags' | 'blockedReason'>): Omit<DispatchHold, 'heldBy'> | null {
  const tag = dispatchSkipTag(node);
  const blockedReason = node.blockedReason?.trim() ? node.blockedReason : null;
  return tag === null && blockedReason === null ? null : { tag, blockedReason };
}

/**
 * Whether a ticket is held for a person, or null when an agent may take it.
 * A skip tag (#266) or a manual blocker (`blockedReason`, set by
 * flag_blocker / the Blocked panel) — a flagged ticket keeps its todo
 * status, so without this the queue handed "waiting on Dan" straight to a
 * worker. Shared by get_next_ticket, ready_nodes and the Dispatch card.
 *
 * With `ancestors`, a hold on an OPEN ancestor holds the whole subtree: an
 * epic waiting on a decision makes its sub-tickets just as stuck. A done
 * ancestor's leftover reason does not count — it would silently freeze
 * every ticket added under it later (plan-lint flags that text instead).
 * The nearest holding ancestor wins.
 *
 * An epic leaf (`isEpicLeaf`) is held too, under the tag `epic`, but only
 * on the ticket itself: an epic ancestor with children is the normal tree
 * shape, and its sub-tickets are the work.
 */
export function dispatchHold(
  node: Pick<Node, 'tags' | 'blockedReason'> & { parentId?: string | null; text?: string },
  ancestors?: { nodeMap: NodeMap; isDone: (status: string | null) => boolean },
): DispatchHold | null {
  const own = ownHold(node) ?? (isEpicLeaf({ tags: node.tags, text: node.text ?? '' }) ? { tag: EPIC_HOLD_TAG, blockedReason: null } : null);
  if (own) return { ...own, heldBy: null };
  if (!ancestors) return null;
  const seen = new Set<string>();
  for (let id = node.parentId ?? null; id !== null && !seen.has(id); ) {
    seen.add(id);
    const a = ancestors.nodeMap.get(id);
    if (!a) break;
    if (!ancestors.isDone(a.status)) {
      const hold = ownHold(a);
      if (hold) return { ...hold, heldBy: { id: a.id, text: a.text } };
    }
    id = a.parentId;
  }
  return null;
}

/** An open parent whose skip tag or blocker holds tickets below it. */
export interface ParentHold {
  id: string;
  text: string;
  tag: string | null;
  blockedReason: string | null;
  /** Tickets below it that would otherwise be pullable. */
  count: number;
}

/**
 * The parents holding tickets, most first. A hold on a parent holds its
 * whole subtree (dispatchHold) — meant for "this epic waits on a
 * decision", but nothing shows how much it takes out of the queue: a
 * needs-human tag on the Navy security-audit umbrella silently held all
 * 18 of its findings (21.10.2026). Shared by the Dispatch card and the
 * hold-on-parent lint rule.
 */
export function parentHolds(
  tickets: Array<Pick<Node, 'tags' | 'blockedReason' | 'parentId' | 'text'>>,
  ancestors: { nodeMap: NodeMap; isDone: (status: string | null) => boolean },
): ParentHold[] {
  const byParent = new Map<string, ParentHold>();
  for (const t of tickets) {
    const hold = dispatchHold(t, ancestors);
    if (!hold?.heldBy) continue;
    const prev = byParent.get(hold.heldBy.id);
    if (prev) prev.count++;
    else byParent.set(hold.heldBy.id, { id: hold.heldBy.id, text: hold.heldBy.text, tag: hold.tag, blockedReason: hold.blockedReason, count: 1 });
  }
  return [...byParent.values()].sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));
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
  /** Pullable, inside the gate, but held for a person (skip tag or manual blocker, on it or an open ancestor — `dispatchHold`) — never granted. */
  humanOnly: number;
  /** The open parents behind `humanOnly` that hold tickets through their subtree, most first. */
  heldByParents: ParentHold[];
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
  const activeClaims = nodes.filter(holdsCapSlot).length;
  const { pullable, nodeMap } = pullableNodes(nodes, opts.workflow);
  const gatedAll = pullable.filter((n) => matchesDispatchGate(n, opts.gate, nodeMap));
  // Tickets held for a person (#266, blockers) are inside the gate but never granted.
  const ancestors = { nodeMap, isDone: buildIsDonePredicate(opts.workflow) };
  const gated = gatedAll.filter((n) => dispatchHold(n, ancestors) === null);
  const inGate = gated.filter(hasBrief);
  const gateHasVersion = gateVersionIds(opts.gate).length > 0;
  // Unversioned tickets the gate keeps out — with `type:bug|version:X` an
  // unversioned bug is inside, so count against the gate itself.
  const unversionedOutsideGate = gateHasVersion
    ? pullable.filter((n) => effectiveVersionId(n.id, nodeMap) === null && !matchesDispatchGate(n, opts.gate, nodeMap)).length
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
    humanOnly: gatedAll.length - gated.length,
    heldByParents: parentHolds(gatedAll, ancestors),
    unversionedOutsideGate,
    unknownGateEntries,
    inGateIds: inGate.map((n) => n.id),
    state,
  };
}
