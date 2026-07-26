/**
 * What is actually in a release?
 *
 * The requirements register answers "which requirements ship in V1". It
 * does not answer "what is V1", because a release also carries bugs,
 * infrastructure, cleanup and features nobody ever wrote a requirement
 * for. On a real map that second pile is the majority: on the Fulcrum
 * roadmap, 223 of V1's 293 leaves attribute to no requirement at all.
 *
 * A release view built only from requirements therefore reports on a
 * quarter of the release and looks green while the other three quarters
 * decide the date. This module computes the whole split.
 *
 * ── Attribution ───────────────────────────────────────────────────
 *
 * A leaf counts as requirement work when either holds:
 *
 *   1. STRUCTURAL — a requirement node sits on its path to the root.
 *      The work hangs beneath the business statement it implements.
 *
 *   2. BY ISSUE LINK — the leaf shares a GitHub issue with a
 *      requirement, via collectRequirementGhLinks (which already rolls
 *      up links from a requirement's descendants).
 *
 * Rule 2 is the one that matters. The tree is organised by functional
 * area, so the ticket that implements PER-05 usually lives under
 * "Compliance, KYC & Regulatory", nowhere near the requirement. Without
 * the link join, every such ticket reads as unattributed and the
 * coverage number is noise.
 *
 * ── Coverage is counted in TICKETS, not effort ────────────────────
 *
 * Effort would be the better unit if the estimates were complete. They
 * are not: finished work tends to lose its estimate (V1 carries 183
 * unestimated leaves, nearly all of them done), so an effort-weighted
 * coverage silently understates whatever already shipped. Ticket counts
 * are always complete. Effort is reported alongside — with the
 * unestimated count, so a caller can see how much to trust it.
 */
import { collectRequirementGhLinks } from './requirements.js';
import { effectiveVersionId } from './versions.js';

/** Minimal node shape. Structurally satisfied by the core `Node` type. */
export interface CompositionNode {
  id: string;
  parentId: string | null;
  childrenIds?: string[] | null;
  versionId?: string | null;
  requirementId?: string | null;
  text: string;
  tags?: string[] | null;
  effortEstimate?: number | null;
  percentComplete?: number | null;
  externalLinks?: Array<{
    provider: string;
    externalId: string;
    url: string;
    state?: 'open' | 'closed';
  }> | null;
}

export interface CompositionBucket {
  /** Leaves in this bucket. Always complete — the honest denominator. */
  count: number;
  /** Leaves below 100 % complete. */
  openCount: number;
  /** Summed leaf estimates. Understates reality by `unestimated` leaves. */
  effort: number;
  /** Estimate × progress, summed. */
  doneEffort: number;
  /** Leaves carrying no estimate at all. */
  unestimated: number;
}

/** One requirement's share of the release. */
export interface RequirementShare {
  nodeId: string;
  /** The register id ("PER-05"), when the requirement carries one. */
  requirementId: string | null;
  text: string;
  count: number;
  openCount: number;
  effort: number;
  doneEffort: number;
}

/** One class of unattributed work, e.g. everything tagged `type:bug`. */
export interface ClassificationShare {
  /** The tag value with its prefix stripped, or the unclassified label. */
  label: string;
  count: number;
  openCount: number;
  effort: number;
}

export interface UnattributedItem {
  nodeId: string;
  text: string;
  effort: number | null;
  /** 0–100; a leaf with no progress set counts as 0. */
  progress: number;
  /** First GitHub link, when there is one. */
  externalId: string | null;
  url: string | null;
  label: string;
}

export interface ReleaseComposition {
  versionId: string;
  requirementWork: CompositionBucket;
  otherWork: CompositionBucket;
  /**
   * Share of the release's leaves that attribute to a requirement, 0–100.
   * Null when the release holds no leaves — no work supports no claim.
   */
  coveragePct: number | null;
  /** Requirements touched by this release, largest share first. */
  byRequirement: RequirementShare[];
  /** The rest, grouped by classification tag, largest first. */
  byClassification: ClassificationShare[];
  /** Every unattributed leaf, worst-progress first. Callers may cap. */
  unattributed: UnattributedItem[];
}

export interface CompositionOptions {
  /**
   * Tag prefix that classifies work. GitHub label sync writes issue
   * labels onto `tags`, so `type:bug` / `type:tech-debt` arrive for free.
   *
   * Deliberately NOT a heuristic over the node title. Title regexes
   * ("fix(", "infra:") look convincing on a demo and quietly mislabel
   * everything that does not follow the convention of the day — and the
   * misfiled tickets are exactly the ones this view exists to surface.
   */
  typeTagPrefix?: string;
  /** Bucket for work carrying no classifying tag. */
  unclassifiedLabel?: string;
}

const DEFAULT_PREFIX = 'type:';
const DEFAULT_UNCLASSIFIED = 'unclassified';

function emptyBucket(): CompositionBucket {
  return { count: 0, openCount: 0, effort: 0, doneEffort: 0, unestimated: 0 };
}

function isLeaf(n: CompositionNode): boolean {
  return (n.childrenIds?.length ?? 0) === 0;
}

/** Nearest requirement on the node's path to the root, itself included. */
function nearestRequirement<T extends CompositionNode>(
  nodeId: string,
  byId: Map<string, T>,
): T | null {
  const seen = new Set<string>();
  let cur: T | undefined = byId.get(nodeId);
  while (cur) {
    if (cur.requirementId != null) return cur;
    const parentId: string | null = cur.parentId;
    if (parentId == null || seen.has(parentId)) return null;
    seen.add(parentId);
    cur = byId.get(parentId);
  }
  return null;
}

function githubLinks(n: CompositionNode) {
  return (n.externalLinks ?? []).filter((l) => l.provider === 'github');
}

function classify(n: CompositionNode, prefix: string, fallback: string): string {
  for (const tag of n.tags ?? []) {
    if (tag.startsWith(prefix) && tag.length > prefix.length) {
      return tag.slice(prefix.length);
    }
  }
  return fallback;
}

function addLeaf(bucket: CompositionBucket, effort: number | null, progress: number): void {
  bucket.count += 1;
  if (progress < 100) bucket.openCount += 1;
  if (effort == null) {
    bucket.unestimated += 1;
    return;
  }
  bucket.effort += effort;
  bucket.doneEffort += (effort * progress) / 100;
}

/** Floating-point noise from repeated addition has no business in a report. */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function tidy(b: CompositionBucket): CompositionBucket {
  return { ...b, effort: round(b.effort), doneEffort: round(b.doneEffort) };
}

export function computeReleaseComposition<T extends CompositionNode>(
  nodes: Iterable<T>,
  versionId: string,
  opts: CompositionOptions = {},
): ReleaseComposition {
  const prefix = opts.typeTagPrefix ?? DEFAULT_PREFIX;
  const unclassified = opts.unclassifiedLabel ?? DEFAULT_UNCLASSIFIED;

  const byId = new Map<string, T>();
  for (const n of nodes) byId.set(n.id, n);
  const get = (id: string) => byId.get(id);

  // ── Issue → requirement index ───────────────────────────────────
  //
  // Built once over every requirement on the map, not just the ones
  // already tagged for this release: a leaf sitting in V1 may well
  // implement a requirement whose own version tag says V2. Attribution
  // is a statement about the work, not about the release plan.
  //
  // First writer wins when two requirements claim the same issue. That
  // is arbitrary but stable — and a shared issue is a modelling error
  // worth surfacing elsewhere, not worth double-counting here.
  const ghToRequirement = new Map<string, T>();
  for (const n of byId.values()) {
    if (n.requirementId == null) continue;
    for (const link of collectRequirementGhLinks(get, n.id)) {
      if (!ghToRequirement.has(link.externalId)) ghToRequirement.set(link.externalId, n);
    }
  }

  const requirementWork = emptyBucket();
  const otherWork = emptyBucket();
  const shares = new Map<string, RequirementShare>();
  const classes = new Map<string, ClassificationShare>();
  const unattributed: UnattributedItem[] = [];

  for (const node of byId.values()) {
    if (!isLeaf(node)) continue;
    if (effectiveVersionId(node.id, byId) !== versionId) continue;

    const effort = node.effortEstimate ?? null;
    const progress = node.percentComplete ?? 0;

    let requirement = nearestRequirement(node.id, byId);
    if (requirement == null) {
      for (const link of githubLinks(node)) {
        const hit = ghToRequirement.get(link.externalId);
        if (hit) {
          requirement = hit;
          break;
        }
      }
    }

    if (requirement) {
      addLeaf(requirementWork, effort, progress);
      let share = shares.get(requirement.id);
      if (!share) {
        share = {
          nodeId: requirement.id,
          requirementId: requirement.requirementId ?? null,
          text: requirement.text,
          count: 0,
          openCount: 0,
          effort: 0,
          doneEffort: 0,
        };
        shares.set(requirement.id, share);
      }
      share.count += 1;
      if (progress < 100) share.openCount += 1;
      if (effort != null) {
        share.effort += effort;
        share.doneEffort += (effort * progress) / 100;
      }
      continue;
    }

    addLeaf(otherWork, effort, progress);
    const label = classify(node, prefix, unclassified);
    let cls = classes.get(label);
    if (!cls) {
      cls = { label, count: 0, openCount: 0, effort: 0 };
      classes.set(label, cls);
    }
    cls.count += 1;
    if (progress < 100) cls.openCount += 1;
    if (effort != null) cls.effort += effort;

    const [first] = githubLinks(node);
    unattributed.push({
      nodeId: node.id,
      text: node.text,
      effort,
      progress,
      externalId: first?.externalId ?? null,
      url: first?.url ?? null,
      label,
    });
  }

  const total = requirementWork.count + otherWork.count;

  return {
    versionId,
    requirementWork: tidy(requirementWork),
    otherWork: tidy(otherWork),
    coveragePct: total === 0 ? null : Math.round((requirementWork.count / total) * 100),
    byRequirement: [...shares.values()]
      .map((s) => ({ ...s, effort: round(s.effort), doneEffort: round(s.doneEffort) }))
      .sort((a, b) => b.count - a.count || b.effort - a.effort),
    byClassification: [...classes.values()]
      .map((c) => ({ ...c, effort: round(c.effort) }))
      .sort((a, b) => b.count - a.count || b.effort - a.effort),
    // Open work first, and within it the biggest — the order someone
    // triaging unattributed work actually wants.
    unattributed: unattributed.sort(
      (a, b) => a.progress - b.progress || (b.effort ?? 0) - (a.effort ?? 0),
    ),
  };
}
