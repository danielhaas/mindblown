/**
 * ToolBackend is the abstract execution surface tool handlers call through.
 *
 * Two implementations exist:
 * - packages/mcp: HTTP client (api.ts) — talks to a remote MindBlown server
 * - packages/server: direct DB — runs inside the server process
 *
 * Adding a new backend method requires adding it to both implementations.
 */

import type { MapDetail, MapSummary, NodeWithComputed } from './types.js';

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
  released: boolean;
}

export interface ConflictEntry {
  id: string;
  text: string;
  status: string | null;
  claimedBySession: string | null;
  overlappingScopes: string[];
}

export interface ConflictScanResult {
  candidateId: string;
  candidateScopes: string[];
  conflicts: ConflictEntry[];
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
      autoImportNewIssues?: boolean;
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

  // ── Orchestration substrate (#111) ──────────────────────────────
  readyNodes(
    mapId: string,
    opts?: { limit?: number; scopeFilter?: string[] },
  ): Promise<ReadyNodesResult>;
  claimNode(mapId: string, nodeId: string, sessionId: string): Promise<ClaimNodeResult>;
  releaseNode(mapId: string, nodeId: string, sessionId: string): Promise<ReleaseNodeResult>;
  conflictScan(mapId: string, candidateNodeId: string): Promise<ConflictScanResult>;
}
