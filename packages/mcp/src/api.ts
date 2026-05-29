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
  actualEffort: number | null;
  percentComplete: number | null;
  status: string | null;
  blockedReason: string | null;
  assigneeIds: string[];
  priority: string | null;
  dueDate: string | null;
  startDate: string | null;
  tags: string[];
  dependencies: Array<{ targetNodeId: string; type: string; lag: number }>;
  versionId: string | null;
  cycleId: string | null;
  externalLinks: Array<{ provider: string; externalId: string; url: string; syncEnabled: boolean; lastSyncedAt: string | null }>;
  collapsed: boolean;
  createdAt: string;
  updatedAt: string;
  computedEffort: number;
  computedProgress: number;
  healthSignal: string;
  isBlocked: boolean;
  blockedBy: {
    manual: boolean;
    predecessorIds: string[];
    blockedDescendantCount: number;
  };
}

export interface MapDetail {
  map: MapSummary & {
    statusWorkflow: Array<{ id: string; name: string; category: string; color: string; position: number }>;
    baselines: unknown[];
    wipLimit: number | null;
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
  projectStartDate: string;
  effortUnit: 'hours' | 'days' | 'points';
  unitsPerDay: number;
  versionId?: string | null;
  crossVersionDependencies?: Array<{
    fromNodeId: string;
    fromText: string;
    toNodeId: string;
    toText: string;
    type: string;
  }>;
}

export interface VersionInfo {
  id: string;
  mapId: string;
  name: string;
  description: string | null;
  status: string;
  targetDate: string | null;
  sortOrder: number;
  createdAt: string;
}

export interface CycleInfo {
  id: string;
  mapId: string;
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
    ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
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

export function updateMap(
  mapId: string,
  fields: {
    name?: string;
    description?: string | null;
    wipLimit?: number | null;
    projectStartDate?: string | null;
    hoursPerDay?: number;
  },
): Promise<MapSummary> {
  return request<MapSummary>(`/api/maps/${mapId}`, {
    method: 'PUT',
    body: JSON.stringify(fields),
  });
}

export function deleteMap(mapId: string): Promise<void> {
  return request<void>(`/api/maps/${mapId}`, {
    method: 'DELETE',
  });
}

export function getSchedule(mapId: string, versionId?: string): Promise<ScheduleResult> {
  const qs = versionId ? `?versionId=${encodeURIComponent(versionId)}` : '';
  return request<ScheduleResult>(`/api/maps/${mapId}/schedule${qs}`);
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

export function listCycles(mapId: string): Promise<CycleInfo[]> {
  return request<CycleInfo[]>(`/api/cycles?mapId=${encodeURIComponent(mapId)}`);
}

export function getCycle(cycleId: string): Promise<CycleDetail> {
  return request<CycleDetail>(`/api/cycles/${cycleId}`);
}

export function createCycle(
  mapId: string,
  name: string,
  startDate: string,
  endDate: string,
  versionId?: string,
): Promise<CycleInfo> {
  return request<CycleInfo>('/api/cycles', {
    method: 'POST',
    body: JSON.stringify({ mapId, name, startDate, endDate, versionId }),
  });
}

export function updateCycle(
  cycleId: string,
  fields: { name?: string; startDate?: string; endDate?: string; status?: 'planned' | 'active' | 'completed'; versionId?: string | null },
): Promise<CycleInfo> {
  return request<CycleInfo>(`/api/cycles/${cycleId}`, {
    method: 'PUT',
    body: JSON.stringify(fields),
  });
}

export function assignNodeToCycle(cycleId: string, nodeId: string): Promise<any> {
  return request(`/api/cycles/${cycleId}/assign`, {
    method: 'POST',
    body: JSON.stringify({ nodeId }),
  });
}

export function unassignNodeFromCycle(cycleId: string, nodeId: string): Promise<any> {
  return request(`/api/cycles/${cycleId}/assign/${nodeId}`, {
    method: 'DELETE',
  });
}

export function rolloverCycle(fromCycleId: string, targetCycleId: string): Promise<any> {
  return request(`/api/cycles/${fromCycleId}/rollover`, {
    method: 'POST',
    body: JSON.stringify({ targetCycleId }),
  });
}

// ── GitHub Integration ─────────────────────────────────────────

export function connectGitHubRepo(
  workspaceId: string,
  owner: string,
  repo: string,
  token: string,
  webhookSecret?: string,
): Promise<{ id: string; provider: string; enabled: boolean }> {
  return request('/api/integrations/github/connect', {
    method: 'POST',
    body: JSON.stringify({ workspaceId, owner, repo, token, webhookSecret }),
  });
}

export function importGitHubIssues(
  mapId: string,
  createdBy: string,
  parentNodeId?: string,
  includeAll?: boolean,
): Promise<{
  imported: number;
  linked: number;
  skipped: number;
  nodes: Array<{ nodeId: string; issueNumber: number }>;
  linkedNodes: Array<{ nodeId: string; issueNumber: number }>;
  skippedNodes: Array<{ nodeId: string; issueNumber: number }>;
  versions: Record<string, string>;
}> {
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

export function createGitHubIssueFromNode(
  mapId: string,
  nodeId: string,
): Promise<{
  node: { id: string; externalLinks: Array<{ provider: string; externalId: string; url: string }> };
  issue: { number: number; html_url: string; title: string };
}> {
  return request(`/api/maps/${mapId}/nodes/${nodeId}/github/create`, {
    method: 'POST',
  });
}

export interface GitHubSyncOverview {
  repo: string;
  includeClosed: boolean;
  counts: {
    synced: number;
    onlyInMindBlown: number;
    onlyInGitHub: number;
  };
  synced: Array<{
    nodeId: string;
    text: string;
    externalId: string;
    issueNumber: number;
    issueUrl: string;
    issueState: 'open' | 'closed';
    issueTitle: string;
  }>;
  onlyInMindBlown: Array<{ nodeId: string; text: string }>;
  onlyInGitHub: Array<{
    issueNumber: number;
    title: string;
    state: 'open' | 'closed';
    url: string;
  }>;
}

export function getGitHubSyncOverview(
  mapId: string,
  includeClosed = false,
): Promise<GitHubSyncOverview> {
  const qs = includeClosed ? '?includeClosed=true' : '';
  return request(`/api/maps/${mapId}/github/sync-overview${qs}`);
}

// ── Scope simulation ──────────────────────────────────────────

export type SimulationPatch =
  | { action: 'remove'; nodeId: string }
  | { action: 'add'; parentId: string; text: string; effortEstimate: number; dueDate?: string | null }
  | {
      action: 'update';
      nodeId: string;
      effortEstimate?: number | null;
      startDate?: string | null;
      dueDate?: string | null;
      percentComplete?: number | null;
    };

export interface MapProjection {
  totalScope: number;
  totalDone: number;
  totalRemaining: number;
  weightedProgress: number;
  leafCount: number;
  noEstimateCount: number;
  plannedFinishDate: string | null;
  plannedFinishOffsetDays: number | null;
}

export function simulateMap(
  mapId: string,
  patches: SimulationPatch[],
): Promise<{ before: MapProjection; after: MapProjection }> {
  return request(`/api/maps/${mapId}/simulate`, {
    method: 'POST',
    body: JSON.stringify({ patches }),
  });
}

// ── Change history ────────────────────────────────────────────

export interface ChangeEvent {
  id: string;
  mapId: string;
  nodeId: string | null;
  userId: string | null;
  eventType: 'node.created' | 'node.deleted' | 'node.moved' | 'node.field_changed';
  fieldName: string | null;
  oldValue: unknown;
  newValue: unknown;
  createdAt: string;
}

export function getChangeHistory(
  mapId: string,
  opts: { nodeId?: string; eventType?: string; fieldName?: string; sinceDays?: number; limit?: number } = {},
): Promise<{ events: ChangeEvent[] }> {
  const params = new URLSearchParams();
  if (opts.nodeId) params.set('nodeId', opts.nodeId);
  if (opts.eventType) params.set('eventType', opts.eventType);
  if (opts.fieldName) params.set('fieldName', opts.fieldName);
  if (opts.sinceDays != null) params.set('sinceDays', String(opts.sinceDays));
  if (opts.limit != null) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return request<{ events: ChangeEvent[] }>(`/api/maps/${mapId}/changes${qs ? `?${qs}` : ''}`);
}

// ── Versions ──────────────────────────────────────────────────

export function listVersions(mapId: string): Promise<VersionInfo[]> {
  return request<VersionInfo[]>(`/api/versions?mapId=${encodeURIComponent(mapId)}`);
}

export function createVersion(
  mapId: string,
  name: string,
  description?: string,
  targetDate?: string,
): Promise<VersionInfo> {
  return request<VersionInfo>('/api/versions', {
    method: 'POST',
    body: JSON.stringify({ mapId, name, description, targetDate }),
  });
}

// ── AI ────────────────────────────────────────────────────────

export interface BreakdownSuggestion {
  text: string;
  estimate: number | null;
}

export interface BraindumpNode {
  text: string;
  estimate: number | null;
  children: BraindumpNode[];
}

export interface AiEstimateResult {
  estimate: number;
  rawEstimate: number;
  confidence: 'low' | 'medium' | 'high';
  notes?: string;
  samplesUsed: number;
  fudgeFactor: number;
  effortUnit: string;
}

export interface SemanticMatch {
  nodeId: string;
  text: string;
  score: number;
}

export interface AiStandupResult {
  narrative: string;
  recentlyChanged: number;
  inProgress: number;
  blocked: number;
  sinceHours: number;
}

export function aiBreakdown(
  mapId: string,
  nodeId: string,
  count?: number,
  hint?: string,
): Promise<{ suggestions: BreakdownSuggestion[] }> {
  return request<{ suggestions: BreakdownSuggestion[] }>('/api/ai/breakdown', {
    method: 'POST',
    body: JSON.stringify({ mapId, nodeId, count, hint }),
  });
}

export function aiBreakdownAccept(
  mapId: string,
  parentId: string,
  tasks: BreakdownSuggestion[],
): Promise<{ created: NodeWithComputed[] }> {
  return request<{ created: NodeWithComputed[] }>('/api/ai/breakdown/accept', {
    method: 'POST',
    body: JSON.stringify({ mapId, parentId, tasks }),
  });
}

export function aiBraindump(
  mapId: string,
  parentId: string,
  prose: string,
  maxDepth?: number,
): Promise<{ tree: BraindumpNode[] }> {
  return request<{ tree: BraindumpNode[] }>('/api/ai/braindump', {
    method: 'POST',
    body: JSON.stringify({ mapId, parentId, prose, maxDepth }),
  });
}

export function aiBraindumpAccept(
  mapId: string,
  parentId: string,
  tree: BraindumpNode[],
): Promise<{ createdCount: number }> {
  return request<{ createdCount: number }>('/api/ai/braindump/accept', {
    method: 'POST',
    body: JSON.stringify({ mapId, parentId, tree }),
  });
}

export function aiEstimate(
  mapId: string,
  opts: { text?: string; nodeId?: string; hint?: string },
): Promise<AiEstimateResult> {
  return request<AiEstimateResult>('/api/ai/estimate', {
    method: 'POST',
    body: JSON.stringify({ mapId, ...opts }),
  });
}

export function aiSemanticSearch(
  mapId: string,
  q: string,
  limit?: number,
): Promise<{ matches: SemanticMatch[] }> {
  const params = new URLSearchParams({ mapId, q });
  if (limit != null) params.set('limit', String(limit));
  return request<{ matches: SemanticMatch[] }>(`/api/ai/search?${params.toString()}`);
}

export function aiStandup(mapId: string, sinceHours?: number): Promise<AiStandupResult> {
  return request<AiStandupResult>('/api/ai/standup', {
    method: 'POST',
    body: JSON.stringify({ mapId, sinceHours }),
  });
}
