/**
 * Data shapes returned by backend operations.
 * Mirror the server's API response envelopes (also used by packages/mcp/src/api.ts).
 */

export interface MapSummary {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  rootNodeId: string;
  effortUnit: string;
  healthThreshold: number;
  computedProgress: number;
  healthSignal: string;
  createdAt: string;
  updatedAt: string;
}

export interface NodeWithComputed {
  id: string;
  mapId: string;
  parentId: string | null;
  childrenIds: string[];
  text: string;
  description: string | null;
  effortEstimate: number | null;
  actualEffort: number | null;
  percentComplete: number | null;
  status: string | null;
  assigneeIds: string[];
  priority: string | null;
  dueDate: string | null;
  startDate: string | null;
  tags: string[];
  dependencies: Array<{ targetNodeId: string; type: string; lag: number }>;
  versionId: string | null;
  cycleId: string | null;
  externalLinks: Array<{
    provider: string;
    externalId: string;
    url: string;
    syncEnabled: boolean;
    lastSyncedAt: string | null;
  }>;
  collapsed: boolean;
  createdAt: string;
  updatedAt: string;
  // Requirements register — non-null requirementId marks a requirement.
  requirementId: string | null;
  requirementPriority: 'must' | 'should' | 'could' | null;
  requirementText: string | null;
  // References a PhaseDef.id from the map's `phases` list (statusWorkflow
  // idiom). null = no phase assigned.
  phaseId: string | null;
  // Orchestration substrate (#111) — surfaced for slot accounting (#153).
  claimedBySession: string | null;
  claimedAt: string | null;
  computedEffort: number;
  computedProgress: number;
  healthSignal: string;
}

/** Pull-queue profile routing thresholds (mirrors core ProfilePolicy, #262). */
export interface ProfilePolicy {
  /** Heavy-class floor in hours. Omitted = one day (the map's hoursPerDay). */
  heavyMinHours?: number;
  /** Light-eligible ceiling in hours. Omitted = 2. */
  lightMaxHours?: number;
}

/** Project phase definition (mirrors core PhaseDef; statusWorkflow idiom). */
export interface PhaseDef {
  id: string;
  name: string;
  position: number;
  color?: string;
  targetDate?: string | null;
}

export interface MapDetail {
  map: MapSummary & {
    statusWorkflow: Array<{ id: string; name: string; category: string; color: string; position: number }>;
    baselines: unknown[];
    wipLimit: number | null;
    /** Project phase definitions; `position` = canonical phase order. */
    phases?: PhaseDef[];
  };
  nodes: NodeWithComputed[];
}
