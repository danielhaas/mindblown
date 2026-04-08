/**
 * MindBlown API client for the MCP server.
 * Uses native fetch (Node.js 18+) to communicate with the backend.
 */

const API_URL = process.env.MINDBLOWN_API_URL ?? 'http://localhost:3001';
const TOKEN = process.env.MINDBLOWN_TOKEN ?? '';

// ── Types matching API responses ────────────────────────────────

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
  };
  nodes: NodeWithComputed[];
}

export interface ScheduleResult {
  schedule: Array<{
    nodeId: string;
    computedStart: number;
    computedEnd: number;
    duration: number;
  }>;
  criticalPath: {
    path: string[];
    totalDuration: number;
    float: Record<string, number>;
  };
}

export interface VersionInfo {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  status: string;
  targetDate: string | null;
  sortOrder: number;
  createdAt: string;
}

export interface MilestoneInfo {
  id: string;
  versionId: string | null;
  workspaceId: string;
  name: string;
  description: string | null;
  status: string;
  targetDate: string | null;
  sortOrder: number;
  createdAt: string;
}

export interface CycleInfo {
  id: string;
  workspaceId: string;
  versionId: string | null;
  name: string;
  startDate: string;
  endDate: string;
  status: string;
  createdAt: string;
}

export interface CycleDetail {
  cycle: CycleInfo;
  nodes: NodeWithComputed[];
  progress: number;
  totalNodes: number;
  completedNodes: number;
}

// ── API Error ───────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// ── Request helper ──────────────────────────────────────────────

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string> ?? {}),
  };
  if (TOKEN) {
    headers['Authorization'] = `Bearer ${TOKEN}`;
  }

  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(
      res.status,
      (body as any)?.error?.message ?? res.statusText,
      (body as any)?.error?.code,
    );
  }

  if (res.status === 204) return undefined as unknown as T;
  return res.json() as Promise<T>;
}

// ── Maps ────────────────────────────────────────────────────────

export function listMaps(): Promise<MapSummary[]> {
  return request<MapSummary[]>('/api/maps');
}

export function getMap(mapId: string): Promise<MapDetail> {
  return request<MapDetail>(`/api/maps/${mapId}`);
}

export function createMap(name: string, description?: string, workspaceId = 'default'): Promise<any> {
  return request('/api/maps', {
    method: 'POST',
    body: JSON.stringify({ name, description, workspaceId }),
  });
}

export function getSchedule(mapId: string): Promise<ScheduleResult> {
  return request<ScheduleResult>(`/api/maps/${mapId}/schedule`);
}

// ── Nodes ───────────────────────────────────────────────────────

export function createNode(
  mapId: string,
  parentId: string,
  text: string,
  fields?: Record<string, unknown>,
): Promise<NodeWithComputed> {
  return request<NodeWithComputed>(`/api/maps/${mapId}/nodes`, {
    method: 'POST',
    body: JSON.stringify({ parentId, text, ...fields }),
  });
}

export function updateNode(
  mapId: string,
  nodeId: string,
  fields: Record<string, unknown>,
): Promise<NodeWithComputed> {
  return request<NodeWithComputed>(`/api/maps/${mapId}/nodes/${nodeId}`, {
    method: 'PUT',
    body: JSON.stringify(fields),
  });
}

export function deleteNode(mapId: string, nodeId: string): Promise<void> {
  return request<void>(`/api/maps/${mapId}/nodes/${nodeId}`, {
    method: 'DELETE',
  });
}

export function moveNode(
  mapId: string,
  nodeId: string,
  newParentId: string,
  position?: number,
): Promise<NodeWithComputed> {
  return request<NodeWithComputed>(`/api/maps/${mapId}/nodes/${nodeId}/move`, {
    method: 'PUT',
    body: JSON.stringify({ newParentId, position }),
  });
}

// ── Cycles / Sprints ────────────────────────────────────────────

export function listCycles(workspaceId: string): Promise<CycleInfo[]> {
  return request<CycleInfo[]>(`/api/cycles?workspaceId=${encodeURIComponent(workspaceId)}`);
}

export function getCycle(cycleId: string): Promise<CycleDetail> {
  return request<CycleDetail>(`/api/cycles/${cycleId}`);
}

export function createCycle(
  workspaceId: string,
  name: string,
  startDate: string,
  endDate: string,
  versionId?: string,
): Promise<CycleInfo> {
  return request<CycleInfo>('/api/cycles', {
    method: 'POST',
    body: JSON.stringify({ workspaceId, name, startDate, endDate, versionId }),
  });
}

export function assignNodeToCycle(cycleId: string, nodeId: string): Promise<any> {
  return request(`/api/cycles/${cycleId}/assign`, {
    method: 'POST',
    body: JSON.stringify({ nodeId }),
  });
}

export function rolloverCycle(fromCycleId: string, targetCycleId: string): Promise<any> {
  return request(`/api/cycles/${fromCycleId}/rollover`, {
    method: 'POST',
    body: JSON.stringify({ targetCycleId }),
  });
}

// ── GitHub Integration ─────────────────────────────────────────

export function importGitHubIssues(
  mapId: string,
  createdBy: string,
  parentNodeId?: string,
  includeAll?: boolean,
): Promise<{ imported: number; nodes: Array<{ nodeId: string; issueNumber: number }>; versions: Record<string, string>; milestones: Record<string, string> }> {
  return request(`/api/maps/${mapId}/github/import`, {
    method: 'POST',
    body: JSON.stringify({ createdBy, parentNodeId, includeAll }),
  });
}

export function linkGitHubIssue(
  mapId: string,
  nodeId: string,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<any> {
  return request(`/api/maps/${mapId}/nodes/${nodeId}/github/link`, {
    method: 'POST',
    body: JSON.stringify({ owner, repo, issueNumber }),
  });
}

// ── Versions ──────────────────────────────────────────────────

export function listVersions(workspaceId: string): Promise<VersionInfo[]> {
  return request<VersionInfo[]>(`/api/versions?workspaceId=${encodeURIComponent(workspaceId)}`);
}

export function createVersion(
  workspaceId: string,
  name: string,
  description?: string,
  targetDate?: string,
): Promise<VersionInfo> {
  return request<VersionInfo>('/api/versions', {
    method: 'POST',
    body: JSON.stringify({ workspaceId, name, description, targetDate }),
  });
}

// ── Milestones ────────────────────────────────────────────────

export function listMilestones(workspaceId: string, versionId?: string): Promise<MilestoneInfo[]> {
  let url = `/api/milestones?workspaceId=${encodeURIComponent(workspaceId)}`;
  if (versionId) url += `&versionId=${encodeURIComponent(versionId)}`;
  return request<MilestoneInfo[]>(url);
}

export function createMilestone(
  workspaceId: string,
  name: string,
  versionId?: string,
  description?: string,
  targetDate?: string,
): Promise<MilestoneInfo> {
  return request<MilestoneInfo>('/api/milestones', {
    method: 'POST',
    body: JSON.stringify({ workspaceId, name, versionId, description, targetDate }),
  });
}
