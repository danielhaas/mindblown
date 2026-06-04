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
  total: number;
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
}
