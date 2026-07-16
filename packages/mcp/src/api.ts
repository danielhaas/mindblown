/**
 * MindBlown API client for the MCP server.
 * Uses native fetch (Node.js 18+) to communicate with the backend.
 *
 * Configuration model:
 * - The default (process-wide) baseUrl + token come from env vars and
 *   serve the stdio MCP binary which is single-user per process.
 * - Concurrent callers (the HTTP-hosted MCP route inside the API server)
 *   override with `runWithApiContext({baseUrl, token}, async () => …)`
 *   which uses AsyncLocalStorage to bind the override to the duration
 *   of one tool call. This avoids rewriting 30+ exported functions to
 *   thread a config parameter through every signature.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Light-weight shape of a Fastify `app.inject(...)` response. We only
 * use these three fields, and we intentionally don't pull `fastify` into
 * the `@mindblown/mcp` package's dependency closure to type this — the
 * package still has to ship as a standalone stdio binary with no
 * Fastify import.
 */
export interface InjectResponse {
  statusCode: number;
  body: string;
  // Compatible with Node's `OutgoingHttpHeaders` shape (which Fastify's
  // `inject` returns) — `number` shows up there for things like
  // `content-length`. We don't actually read headers in the client,
  // but the type has to match what Fastify hands us.
  headers: Record<string, string | string[] | number | undefined>;
}

export interface InjectOptions {
  method: string;
  url: string;
  headers?: Record<string, string>;
  payload?: unknown;
}

/**
 * In-process Fastify request injector. Provided by the HTTP-MCP route so
 * tool calls run through Fastify's full lifecycle (preHandlers, auth,
 * permission checks) without taking a localhost TCP round-trip.
 *
 * Stdio MCP doesn't have a Fastify instance to bind here, so this stays
 * undefined and `request()` falls back to plain `fetch(baseUrl + path)`.
 */
export type Injector = (opts: InjectOptions) => Promise<InjectResponse>;

interface ApiContext {
  baseUrl: string;
  token: string;
  injector?: Injector;
}

// New env vars (`MINDBLOWN_MCP_URL` + `MINDBLOWN_MCP_TOKEN`) match the
// HTTP-MCP-era documentation, with the older `MINDBLOWN_API_URL` +
// `MINDBLOWN_TOKEN` kept as fallback so unmigrated stdio configs keep
// working through one release cycle.
const DEFAULT_API_URL =
  process.env.MINDBLOWN_MCP_URL ?? process.env.MINDBLOWN_API_URL ?? 'http://localhost:3001';
const DEFAULT_TOKEN = process.env.MINDBLOWN_MCP_TOKEN ?? process.env.MINDBLOWN_TOKEN ?? '';

const apiContextStorage = new AsyncLocalStorage<ApiContext>();

function getContext(): ApiContext {
  return (
    apiContextStorage.getStore() ?? { baseUrl: DEFAULT_API_URL, token: DEFAULT_TOKEN }
  );
}

/**
 * Run `fn` with `ctx` as the current API context. All `api.*` calls inside
 * `fn` (including transitive ones) will use `ctx.baseUrl` + `ctx.token`.
 *
 * Used by the HTTP-hosted MCP route to scope a Claude Code request to a
 * specific user's API key without rewriting every api function.
 */
export function runWithApiContext<T>(ctx: ApiContext, fn: () => Promise<T>): Promise<T> {
  return apiContextStorage.run(ctx, fn);
}

/**
 * Test-only helper: read the current effective api context. Used by unit
 * tests to assert AsyncLocalStorage isolation across concurrent calls.
 * Not part of the public surface — but harmless to leak (read-only).
 */
export function __peekApiContext(): ApiContext {
  return getContext();
}

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
  revision: number;
  // Requirements register — non-null requirementId marks a requirement.
  requirementId: string | null;
  requirementPriority: 'must' | 'should' | 'could' | null;
  requirementText: string | null;
  // Orchestration substrate (#111) — surfaced for slot accounting (#153).
  claimedBySession: string | null;
  claimedAt: string | null;
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
  /** Fraction of calendar time reaching planned work (0.05–1.0); default 1. */
  focusFactor?: number;
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
  const ctx = getContext();
  const headers: Record<string, string> = {
    ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
    ...(init?.headers as Record<string, string> ?? {}),
  };
  if (ctx.token) {
    headers['Authorization'] = `Bearer ${ctx.token}`;
  }

  // Fast path: in-process Fastify inject. Skips localhost TCP round-trip
  // (~1-2 ms per call) but still runs every preHandler/auth check
  // because Fastify's `inject` is the full request lifecycle.
  if (ctx.injector) {
    const method = (init?.method ?? 'GET').toUpperCase();
    // Pass the body through as a parsed payload when possible. The
    // request body shape on our API surface is always JSON; the
    // wrappers stringify before calling. Fastify's inject accepts
    // either string or object as `payload`, so pass the raw string
    // — that preserves byte-for-byte equivalence with fetch.
    const payload =
      init?.body == null ? undefined : (init.body as string | Buffer);
    const res = await ctx.injector({
      method,
      url: path,
      headers,
      payload,
    });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      let parsed: unknown = {};
      try {
        parsed = res.body ? JSON.parse(res.body) : {};
      } catch {
        /* non-JSON body — fall through with empty obj */
      }
      throw new ApiError(
        res.statusCode,
        (parsed as any)?.error?.message ?? `HTTP ${res.statusCode}`,
        (parsed as any)?.error?.code,
      );
    }
    if (res.statusCode === 204 || !res.body) return undefined as unknown as T;
    return JSON.parse(res.body) as T;
  }

  const res = await fetch(`${ctx.baseUrl}${path}`, {
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

/**
 * Raw-text GET for endpoints that return non-JSON bodies (e.g. the
 * Markdown requirements export). Mirrors request()'s auth + injector
 * fast path but returns the body verbatim.
 */
async function requestText(path: string): Promise<string> {
  const ctx = getContext();
  const headers: Record<string, string> = {};
  if (ctx.token) headers['Authorization'] = `Bearer ${ctx.token}`;

  if (ctx.injector) {
    const res = await ctx.injector({ method: 'GET', url: path, headers });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new ApiError(res.statusCode, `HTTP ${res.statusCode}`);
    }
    return res.body ?? '';
  }

  const res = await fetch(`${ctx.baseUrl}${path}`, { headers });
  if (!res.ok) throw new ApiError(res.status, res.statusText);
  return res.text();
}

export interface AcceptanceRow {
  id: string;
  nodeId: string;
  userId: string;
  userName: string;
  acceptedAt: string;
  progressAtAcceptance: number;
  nodeRevisionAtAcceptance: number;
}

export function getAcceptances(mapId: string): Promise<{ acceptances: AcceptanceRow[] }> {
  return request<{ acceptances: AcceptanceRow[] }>(`/api/maps/${mapId}/acceptances`);
}

export function acceptRequirement(mapId: string, nodeId: string): Promise<AcceptanceRow> {
  return request<AcceptanceRow>(`/api/maps/${mapId}/nodes/${nodeId}/acceptance`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function revokeAcceptance(mapId: string, nodeId: string): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`/api/maps/${mapId}/nodes/${nodeId}/acceptance`, {
    method: 'DELETE',
  });
}

export function exportRequirements(mapId: string): Promise<string> {
  return requestText(`/api/maps/${mapId}/requirements-export`);
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
    workerCount?: number;
    focusFactor?: number;
    autoImportNewIssues?: boolean;
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

// ── Soft-delete + restore (#107) ────────────────────────────────

export interface DeletedNodeSummary {
  id: string;
  mapId: string;
  parentId: string | null;
  text: string;
  deletedAt: string;
  effortEstimate: number | null;
  percentComplete: number | null;
}

export async function restoreNode(
  mapId: string,
  nodeId: string,
  opts?: { recursive?: boolean },
): Promise<{ restoredIds: string[]; node: NodeWithComputed | null }> {
  const res = await request<{
    restoredIds: string[];
    affectedParentIds: string[];
    node: NodeWithComputed | null;
  }>(`/api/maps/${mapId}/nodes/${nodeId}/restore`, {
    method: 'POST',
    body: JSON.stringify({ recursive: opts?.recursive === true }),
  });
  return { restoredIds: res.restoredIds, node: res.node };
}

export async function listDeleted(
  mapId: string,
  opts?: { sinceDays?: number; limit?: number },
): Promise<DeletedNodeSummary[]> {
  const params = new URLSearchParams();
  if (opts?.sinceDays != null) params.set('sinceDays', String(opts.sinceDays));
  if (opts?.limit != null) params.set('limit', String(opts.limit));
  const qs = params.toString();
  const res = await request<{ deleted: DeletedNodeSummary[] }>(
    `/api/maps/${mapId}/trash${qs ? `?${qs}` : ''}`,
  );
  return res.deleted;
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

// ── Plan lint ─────────────────────────────────────────────────

export interface LintFinding {
  nodeId: string | null;
  nodeText: string | null;
  priority: string | null;
  detail: string;
  dismissed: boolean;
}

export interface LintRuleReport {
  ruleId: string;
  severity: 'warn' | 'info';
  title: string;
  why: string;
  fix: string;
  findings: LintFinding[];
  activeCount: number;
  dismissedCount: number;
  ruleMuted: boolean;
  skipped?: string;
}

export interface LintReport {
  scopeLabel: string;
  warnCount: number;
  infoCount: number;
  rules: LintRuleReport[];
}

export function getLint(
  mapId: string,
  opts: { nodeId?: string; versionId?: string; stalledDays?: number; rule?: string } = {},
): Promise<LintReport> {
  const params = new URLSearchParams();
  if (opts.nodeId) params.set('nodeId', opts.nodeId);
  if (opts.versionId) params.set('versionId', opts.versionId);
  if (opts.stalledDays != null) params.set('stalledDays', String(opts.stalledDays));
  if (opts.rule) params.set('rule', opts.rule);
  const qs = params.toString();
  return request<LintReport>(`/api/maps/${mapId}/lint${qs ? `?${qs}` : ''}`);
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

export function updateVersion(
  versionId: string,
  fields: {
    name?: string;
    description?: string | null;
    targetDate?: string | null;
    status?: 'planning' | 'active' | 'released' | 'archived';
  },
): Promise<VersionInfo> {
  return request<VersionInfo>(`/api/versions/${versionId}`, {
    method: 'PUT',
    body: JSON.stringify(fields),
  });
}

// ── AI ────────────────────────────────────────────────────────

export interface BreakdownSuggestion {
  text: string;
  estimate: number | null;
  /** Optional grouped children — categories with leaf descendants. */
  children?: BreakdownSuggestion[];
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

// ── Triage (#96 Phase 3) ──────────────────────────────────────

export type TriageDecisionKindApi = 'place' | 'skip' | 'uncertain';

export interface TriageDecisionRowApi {
  id: string;
  mapId: string;
  externalId: string;
  issueTitle: string;
  issueState: 'open' | 'closed';
  decision: TriageDecisionKindApi;
  reason: string;
  confidence: number;
  placedNodeId: string | null;
  decidedAt: string;
  decidedBy: 'auto' | 'operator';
  reviewed: boolean;
  reviewedAt: string | null;
  reviewedBy: string | null;
}

export interface TriageListFiltersApi {
  reviewed?: boolean;
  decision?: TriageDecisionKindApi;
  minConfidence?: number;
  maxConfidence?: number;
  issueState?: 'open' | 'closed';
  since?: string;
  limit?: number;
}

export interface TriageActionResultApi {
  decisionId: string;
  status: string;
  nodeId?: string | null;
  decision?: TriageDecisionKindApi;
  confidence?: number;
  reason?: string;
  parentNodeId?: string | null;
  placedNodeId?: string | null;
}

export function listTriageDecisions(
  mapId: string,
  filters: TriageListFiltersApi,
): Promise<{ mapId: string; total: number; returned: number; decisions: TriageDecisionRowApi[] }> {
  const params = new URLSearchParams();
  if (filters.reviewed != null) params.set('reviewed', String(filters.reviewed));
  if (filters.decision) params.set('decision', filters.decision);
  if (filters.minConfidence != null) params.set('minConfidence', String(filters.minConfidence));
  if (filters.maxConfidence != null) params.set('maxConfidence', String(filters.maxConfidence));
  if (filters.issueState) params.set('issueState', filters.issueState);
  if (filters.since) params.set('since', filters.since);
  if (filters.limit != null) params.set('limit', String(filters.limit));
  const qs = params.toString();
  // Phase 3 follow-up (#104 item 12): server returns both `total`
  // (full match count) and `returned` (page size after limit). Older
  // server responses that didn't have `returned` will still satisfy
  // the type with `undefined`; the MCP tool falls back to
  // `decisions.length` if needed.
  return request<{ mapId: string; total: number; returned: number; decisions: TriageDecisionRowApi[] }>(
    `/api/maps/${mapId}/triage-decisions${qs ? `?${qs}` : ''}`,
  );
}

export function overrideTriage(
  mapId: string,
  decisionId: string,
  body: { decision: TriageDecisionKindApi; parentNodeId?: string; reason?: string },
): Promise<TriageActionResultApi> {
  return request<TriageActionResultApi>(
    `/api/maps/${mapId}/triage-decisions/${decisionId}/override`,
    { method: 'POST', body: JSON.stringify(body) },
  );
}

export function reclassifyTriage(
  mapId: string,
  decisionId: string,
): Promise<TriageActionResultApi> {
  return request<TriageActionResultApi>(
    `/api/maps/${mapId}/triage-decisions/${decisionId}/reclassify`,
    { method: 'POST' },
  );
}

export function confirmTriage(
  mapId: string,
  decisionId: string,
): Promise<TriageActionResultApi> {
  return request<TriageActionResultApi>(
    `/api/maps/${mapId}/triage-decisions/${decisionId}/confirm`,
    { method: 'POST' },
  );
}

// ── Not-in-MindBlown unified view (#140) ─────────────────────────

export type NotInMindBlownKindApi =
  | 'skipped'
  | 'pending-skipped'
  | 'uncertain'
  | 'orphan';

export interface NotInMindBlownItemApi {
  kind: NotInMindBlownKindApi;
  triageDecisionId?: string;
  decision?: 'skip' | 'uncertain';
  reason?: string;
  confidence?: number;
  decidedAt?: string;
  externalId: string;
  issueTitle: string;
  issueState: 'open' | 'closed';
  issueUrl: string;
}

export interface NotInMindBlownFiltersApi {
  bucket?: NotInMindBlownKindApi | 'all' | 'orphans';
  limit?: number;
  since?: string;
}

export interface NotInMindBlownResultApi {
  mapId: string;
  bucket: string;
  total: number;
  returned: number;
  orphansAvailable: boolean;
  orphansError: string | null;
  items: NotInMindBlownItemApi[];
}

export function listNotInMindBlown(
  mapId: string,
  filters: NotInMindBlownFiltersApi,
): Promise<NotInMindBlownResultApi> {
  const params = new URLSearchParams();
  if (filters.bucket) {
    // Server accepts both 'orphan' (singular) and 'orphans' (plural)
    // — normalize to the canonical 'orphans' query value.
    params.set('bucket', filters.bucket === 'orphan' ? 'orphans' : filters.bucket);
  }
  if (filters.limit != null) params.set('limit', String(filters.limit));
  if (filters.since) params.set('since', filters.since);
  const qs = params.toString();
  return request<NotInMindBlownResultApi>(
    `/api/maps/${mapId}/triage-decisions/not-in-mindblown${qs ? `?${qs}` : ''}`,
  );
}

// ── Orchestration substrate (#111) ────────────────────────────

export interface ReadyNodeApi {
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

export interface ReadyNodesResultApi {
  mapId: string;
  ready: ReadyNodeApi[];
  total: number;
  returned: number;
}

export interface ClaimNodeResultApi {
  node: { id: string; text: string; claimedBySession: string | null; claimedAt: string | null };
  claimed: boolean;
  warned: boolean;
  warning?: string;
}

export interface ReleaseNodeResultApi {
  node: { id: string; text: string };
  released: boolean;
  /** True when the node was already unclaimed (#118 issue 5 — no-op success). */
  alreadyReleased?: boolean;
}

export interface ConflictEntryApi {
  id: string;
  text: string;
  status: string | null;
  claimedBySession: string | null;
  overlappingScopes: string[];
}

export interface DuplicateLinkGroupApi {
  externalId: string;
  nodes: Array<{ id: string; text: string; percentComplete: number | null; hasChildren: boolean }>;
}

export interface ConflictScanResultApi {
  candidateId: string | null;
  candidateScopes: string[];
  conflicts: ConflictEntryApi[];
  duplicateLinks: DuplicateLinkGroupApi[];
}

export function readyNodes(
  mapId: string,
  opts: { limit?: number; scopeFilter?: string[] } = {},
): Promise<ReadyNodesResultApi> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.scopeFilter && opts.scopeFilter.length > 0) {
    params.set('scope', opts.scopeFilter.join(','));
  }
  const qs = params.toString();
  return request<ReadyNodesResultApi>(`/api/maps/${mapId}/nodes/ready${qs ? `?${qs}` : ''}`);
}

export function claimNode(
  mapId: string,
  nodeId: string,
  sessionId: string,
): Promise<ClaimNodeResultApi> {
  return request<ClaimNodeResultApi>(
    `/api/maps/${mapId}/nodes/${nodeId}/claim`,
    { method: 'POST', body: JSON.stringify({ sessionId }) },
  );
}

export function releaseNode(
  mapId: string,
  nodeId: string,
  sessionId: string,
): Promise<ReleaseNodeResultApi> {
  return request<ReleaseNodeResultApi>(
    `/api/maps/${mapId}/nodes/${nodeId}/release`,
    { method: 'POST', body: JSON.stringify({ sessionId }) },
  );
}

export function conflictScan(
  mapId: string,
  candidateNodeId?: string,
): Promise<ConflictScanResultApi> {
  return request<ConflictScanResultApi>(
    candidateNodeId === undefined
      ? `/api/maps/${mapId}/conflict-scan`
      : `/api/maps/${mapId}/nodes/${candidateNodeId}/conflict-scan`,
  );
}
