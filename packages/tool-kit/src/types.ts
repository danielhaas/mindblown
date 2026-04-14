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
  isMilestone: boolean;
  versionId: string | null;
  milestoneId: string | null;
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
  computedEffort: number;
  computedProgress: number;
  healthSignal: string;
}

export interface MapDetail {
  map: MapSummary & {
    statusWorkflow: Array<{ id: string; name: string; category: string; color: string; position: number }>;
    baselines: unknown[];
    wipLimit: number | null;
  };
  nodes: NodeWithComputed[];
}
