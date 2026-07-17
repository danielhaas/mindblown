/**
 * ToolBackend is the abstract execution surface tool handlers call through.
 *
 * Two implementations exist:
 * - packages/mcp: HTTP client (api.ts) — talks to a remote MindBlown server
 * - packages/server: direct DB — runs inside the server process
 *
 * Adding a new backend method requires adding it to both implementations.
 */

import type { MapDetail, MapSummary, NodeWithComputed, PhaseDef } from './types.js';

// ── Triage shapes (#96 Phase 3) ────────────────────────────────────
// Mirrors the persisted `triage_decisions` row, plus the per-request
// filter set the HTTP route accepts.

export type TriageDecisionKind = 'place' | 'skip' | 'uncertain';

export interface TriageDecisionRow {
  id: string;
  mapId: string;
  externalId: string;
  issueTitle: string;
  issueState: 'open' | 'closed';
  decision: TriageDecisionKind;
  reason: string;
  confidence: number;
  placedNodeId: string | null;
  decidedAt: string;
  decidedBy: 'auto' | 'operator';
  reviewed: boolean;
  reviewedAt: string | null;
  reviewedBy: string | null;
}

export interface TriageListFilters {
  reviewed?: boolean;
  decision?: TriageDecisionKind;
  minConfidence?: number;
  maxConfidence?: number;
  issueState?: 'open' | 'closed';
  since?: string;
  limit?: number;
}

export interface TriageListResult {
  mapId: string;
  /**
   * Total number of rows matching the filter set, BEFORE the limit is
   * applied. Phase 3 follow-up (#104 item 12) — surfaces the true match
   * count so the MCP tool can render "Showing N of M". Prior to this
   * change `total` reflected the returned page size, which was useless
   * when the limit clipped the result set.
   */
  total: number;
  /**
   * Number of rows in `decisions` (after the server-side limit clip).
   * `returned <= total`; when they differ the MCP tool renders the
   * "of M total" suffix on its summary line.
   */
  returned: number;
  decisions: TriageDecisionRow[];
}

export interface TriageActionResult {
  decisionId: string;
  status: string;
  nodeId?: string | null;
  decision?: TriageDecisionKind;
  confidence?: number;
  reason?: string;
  parentNodeId?: string | null;
  placedNodeId?: string | null;
}

// ── Not-in-MindBlown unified view (#140) ─────────────────────────
// One result shape covers four buckets: skip + reviewed (skipped),
// skip + unreviewed (pending-skipped), uncertain, and orphans (GH
// issues that have no triage_decisions row + no node in the map).
// The orphan branch needs a live GitHub fetch; if it's unavailable
// (no integration / API error) the route still returns the decision-
// row buckets and signals via `orphansAvailable`/`orphansError`.

export type NotInMindBlownKind =
  | 'skipped'
  | 'pending-skipped'
  | 'uncertain'
  | 'orphan';

export interface NotInMindBlownItem {
  kind: NotInMindBlownKind;
  // Decision-row buckets carry these; orphans have neither.
  triageDecisionId?: string;
  decision?: 'skip' | 'uncertain';
  reason?: string;
  confidence?: number;
  decidedAt?: string;
  // Always set.
  externalId: string;
  issueTitle: string;
  issueState: 'open' | 'closed';
  issueUrl: string;
}

export interface NotInMindBlownFilters {
  bucket?: NotInMindBlownKind | 'all' | 'orphans';
  limit?: number;
  since?: string;
}

export interface NotInMindBlownResult {
  mapId: string;
  bucket: string;
  total: number;
  returned: number;
  orphansAvailable: boolean;
  orphansError: string | null;
  items: NotInMindBlownItem[];
}

// ── Orchestration substrate (#111) ─────────────────────────────────

export interface ReadyNode {
  id: string;
  text: string;
  status: string | null;
  priority: string | null;
  priorityRank: number | null;
  scopes: string[];
  claimedBySession: string | null;
  claimedAt: string | null;
  parentId: string | null;
}

export interface ReadyNodesResult {
  mapId: string;
  ready: ReadyNode[];
  total: number;
  returned: number;
}

export interface ClaimNodeResult {
  node: { id: string; text: string; claimedBySession: string | null; claimedAt: string | null };
  claimed: boolean;
  warned: boolean;
  warning?: string;
}

export interface ReleaseNodeResult {
  node: { id: string; text: string };
  /** True when this call actually cleared a claim; false when nothing was claimed. */
  released: boolean;
  /**
   * True when the node was already unclaimed at call time (#118 issue 5).
   * `released` is false in this case — the call is a no-op success.
   * Callers logging "claim cleared" should suppress when this is true.
   */
  alreadyReleased?: boolean;
}

export interface ConflictEntry {
  id: string;
  text: string;
  status: string | null;
  claimedBySession: string | null;
  overlappingScopes: string[];
}

/** Nodes sharing one GitHub issue link — the duplicate-node pattern. */
export interface DuplicateLinkGroup {
  externalId: string;
  nodes: Array<{
    id: string;
    text: string;
    percentComplete: number | null;
    hasChildren: boolean;
  }>;
}

export interface ConflictScanResult {
  /** null in map-wide mode (no candidate given). */
  candidateId: string | null;
  candidateScopes: string[];
  conflicts: ConflictEntry[];
  /**
   * GitHub links attached to more than one node. Per-candidate scans
   * restrict this to the candidate's own links; map-wide scans (no
   * candidateNodeId) report every duplicated link in the map.
   */
  duplicateLinks: DuplicateLinkGroup[];
}

export interface ToolBackend {
  listMaps(): Promise<MapSummary[]>;
  getMap(mapId: string): Promise<MapDetail>;
  createMap(name: string, description?: string): Promise<{ id: string; name: string }>;
  updateMap(
    mapId: string,
    fields: {
      name?: string;
      description?: string | null;
      wipLimit?: number | null;
      projectStartDate?: string | null;
      hoursPerDay?: number;
      workerCount?: number;
      focusFactor?: number;
      autoImportNewIssues?: boolean;
      phases?: PhaseDef[];
    },
  ): Promise<MapSummary>;
  deleteMap(mapId: string): Promise<void>;

  createNode(
    mapId: string,
    parentId: string,
    text: string,
    fields?: Record<string, unknown>,
  ): Promise<NodeWithComputed>;
  updateNode(
    mapId: string,
    nodeId: string,
    fields: Record<string, unknown>,
  ): Promise<NodeWithComputed>;
  deleteNode(mapId: string, nodeId: string): Promise<void>;
  moveNode(
    mapId: string,
    nodeId: string,
    newParentId: string,
    position?: number,
  ): Promise<NodeWithComputed>;

  // ── Soft-delete + restore (#107) ───────────────────────────────
  restoreNode(
    mapId: string,
    nodeId: string,
    opts?: { recursive?: boolean },
  ): Promise<{ restoredIds: string[]; node: NodeWithComputed | null }>;
  listDeleted(
    mapId: string,
    opts?: { sinceDays?: number; limit?: number },
  ): Promise<
    Array<{
      id: string;
      mapId: string;
      parentId: string | null;
      text: string;
      deletedAt: string;
      effortEstimate: number | null;
      percentComplete: number | null;
    }>
  >;

  // ── Triage (#96 Phase 3) ────────────────────────────────────────
  listTriageDecisions(mapId: string, filters: TriageListFilters): Promise<TriageListResult>;
  overrideTriage(
    mapId: string,
    decisionId: string,
    body: {
      decision: TriageDecisionKind;
      parentNodeId?: string;
      reason?: string;
    },
  ): Promise<TriageActionResult>;
  reclassifyTriage(mapId: string, decisionId: string): Promise<TriageActionResult>;
  confirmTriage(mapId: string, decisionId: string): Promise<TriageActionResult>;

  // ── Not-in-MindBlown unified view (#140) ────────────────────────
  listNotInMindBlown(
    mapId: string,
    filters: NotInMindBlownFilters,
  ): Promise<NotInMindBlownResult>;

  // ── Orchestration substrate (#111) ──────────────────────────────
  readyNodes(
    mapId: string,
    opts?: { limit?: number; scopeFilter?: string[] },
  ): Promise<ReadyNodesResult>;
  claimNode(mapId: string, nodeId: string, sessionId: string): Promise<ClaimNodeResult>;
  releaseNode(mapId: string, nodeId: string, sessionId: string): Promise<ReleaseNodeResult>;
  conflictScan(mapId: string, candidateNodeId?: string): Promise<ConflictScanResult>;
}
