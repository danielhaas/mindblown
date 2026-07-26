import type {
  Node,
  MindMap,
  Cycle,
  Version,
  ScheduledNode,
  CriticalPathResult,
} from '@mindblown/core';

const BASE_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

// ── Token helpers ────────────────────────────────────────────────

const TOKEN_KEY = 'mindblown_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

// ── Types ────────────────────────────────────────────────────────

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string | null;
  isAdmin?: boolean;
  createdAt?: string;
}

export type RegistrationMode = 'open' | 'invite_only' | 'allowlist';

export interface RegistrationPolicy {
  mode: RegistrationMode;
  allowlist: string[];
}

export function getRegistrationPolicy(): Promise<RegistrationPolicy> {
  return request('/api/system/registration-policy');
}

export function setRegistrationPolicy(policy: RegistrationPolicy): Promise<RegistrationPolicy> {
  return request('/api/system/registration-policy', {
    method: 'PUT',
    body: JSON.stringify(policy),
  });
}

export function createLongLivedToken(): Promise<{ token: string }> {
  return request('/api/auth/long-lived-token', { method: 'POST' });
}

// ── API Keys (HTTP MCP, headless clients) ───────────────────────

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface CreatedApiKey {
  id: string;
  name: string;
  key: string; // plaintext — shown ONCE
  prefix: string;
  createdAt: string;
  expiresAt: string | null;
}

export function listApiKeys(): Promise<{ keys: ApiKey[] }> {
  return request('/api/api-keys');
}

export function createApiKey(name: string, expiresInDays?: number): Promise<CreatedApiKey> {
  return request('/api/api-keys', {
    method: 'POST',
    body: JSON.stringify({ name, expiresInDays }),
  });
}

export function revokeApiKey(id: string): Promise<void> {
  return request(`/api/api-keys/${id}`, { method: 'DELETE' });
}

export interface FeedbackTicketResponse {
  success: boolean;
  issueNumber: number;
  url: string;
}

export function submitFeedbackTicket(input: {
  title: string;
  description: string;
  page: string;
}): Promise<FeedbackTicketResponse> {
  return request('/api/feedback/ticket', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export interface AuthResponse {
  user: AuthUser;
  token: string;
}

export interface Comment {
  id: string;
  nodeId: string;
  userId: string;
  userName?: string;
  text: string;
  createdAt: string;
  updatedAt: string;
}

export interface Permission {
  id: string;
  mapId: string;
  userId: string;
  userName?: string;
  userEmail?: string;
  permission: 'view' | 'edit' | 'admin';
  isOwner?: boolean;
}

export interface PendingInvite {
  id: string;
  mapId: string;
  email: string;
  permission: string;
  invitedBy: string;
  createdAt: string;
  pending: true;
}

export interface PermissionsResponse {
  permissions: Permission[];
  pendingInvites: PendingInvite[];
}

export interface GitHubIssueStatus {
  externalId: string;
  url?: string;
  state?: string;
  title?: string;
  labels?: string[];
  assignees?: string[];
  updatedAt?: string;
  error?: string;
}

export interface GitHubStatusResponse {
  linked: boolean;
  issues: GitHubIssueStatus[];
  status?: string;
}

export interface MapSummary extends MindMap {
  computedProgress: number;
  healthSignal: string;
}

export interface NodeWithComputed extends Node {
  computedEffort: number;
  computedProgress: number;
  healthSignal: string;
}

export interface MapDetail {
  map: MindMap;
  nodes: NodeWithComputed[];
}

// ── Helpers ──────────────────────────────────────────────────────

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
    ...(init?.headers as Record<string, string> ?? {}),
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(
      res.status,
      body?.error?.message ?? res.statusText,
      body?.error?.code,
      body?.error,
    );
  }
  if (res.status === 204) return undefined as unknown as T;
  return res.json();
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    /** Full error object from the server — carries extras like the current
     *  node on REVISION_CONFLICT. */
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// ── Auth ─────────────────────────────────────────────────────────

export function login(email: string, password: string): Promise<AuthResponse> {
  return request<AuthResponse>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export function register(email: string, password: string, name: string): Promise<AuthResponse> {
  return request<AuthResponse>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password, name }),
  });
}

export function getMe(): Promise<AuthUser> {
  return request<AuthUser>('/api/auth/me');
}

// ── Comments ────────────────────────────────────────────────────

export function fetchComments(mapId: string, nodeId: string): Promise<Comment[]> {
  return request<Comment[]>(`/api/maps/${mapId}/nodes/${nodeId}/comments`);
}

export function createComment(mapId: string, nodeId: string, text: string): Promise<Comment> {
  return request<Comment>(`/api/maps/${mapId}/nodes/${nodeId}/comments`, {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
}

export function updateComment(commentId: string, text: string): Promise<Comment> {
  return request<Comment>(`/api/comments/${commentId}`, {
    method: 'PUT',
    body: JSON.stringify({ text }),
  });
}

export function deleteComment(commentId: string): Promise<void> {
  return request<void>(`/api/comments/${commentId}`, {
    method: 'DELETE',
  });
}

// ── Permissions / Sharing ───────────────────────────────────────

export function fetchPermissions(mapId: string): Promise<PermissionsResponse> {
  return request<PermissionsResponse>(`/api/maps/${mapId}/permissions`);
}

export interface MapMember {
  userId: string;
  name: string;
  email: string;
  permission: 'view' | 'edit' | 'admin';
}

/**
 * People who can be assigned work on this map. Unlike fetchPermissions,
 * readable by anyone with view access — the assignee picker needs the
 * candidate list without exposing the sharing surface.
 */
export function fetchMapMembers(mapId: string): Promise<{ members: MapMember[] }> {
  return request<{ members: MapMember[] }>(`/api/maps/${mapId}/members`);
}

export function shareMap(mapId: string, email: string, permission: string): Promise<Permission | PendingInvite> {
  return request<Permission | PendingInvite>(`/api/maps/${mapId}/share`, {
    method: 'POST',
    body: JSON.stringify({ email, permission }),
  });
}

export function revokePermission(mapId: string, userId: string): Promise<void> {
  return request<void>(`/api/maps/${mapId}/permissions/${userId}`, {
    method: 'DELETE',
  });
}

export function revokePendingInvite(mapId: string, email: string): Promise<void> {
  return request<void>(`/api/maps/${mapId}/invites/${encodeURIComponent(email)}`, {
    method: 'DELETE',
  });
}

export function generatePublicLink(mapId: string): Promise<{ publicToken: string }> {
  return request<{ publicToken: string }>(`/api/maps/${mapId}/public-link`, {
    method: 'POST',
  });
}

// ── GitHub App Integration ──────────────────────────────────────

export interface GitHubInstallStatus {
  connected: boolean;
  identity: {
    githubLogin: string;
    avatarUrl: string | null;
    githubUserId: string;
  } | null;
  installations: Array<{
    installationId: string;
    accountLogin: string;
    accountType: string;
  }>;
  appConfigured: boolean;
}

export interface GitHubRepoInfo {
  id: number;
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  htmlUrl: string;
  description: string | null;
}

export function getGitHubInstallUrl(): Promise<{ installUrl: string }> {
  return request('/api/auth/github/install');
}

export function getGitHubInstallStatus(): Promise<GitHubInstallStatus> {
  return request('/api/auth/github/status');
}

export function getGitHubRepositories(installationId?: string): Promise<{
  installationId: string;
  repositories: GitHubRepoInfo[];
}> {
  const qs = installationId ? `?installationId=${encodeURIComponent(installationId)}` : '';
  return request(`/api/integrations/github/repositories${qs}`);
}

export function disconnectGitHub(): Promise<{ disconnected: boolean }> {
  return request('/api/auth/github/disconnect', { method: 'POST' });
}

// ── GitHub Integration (legacy PAT) ────────────────────────────

export function connectGitHub(
  workspaceId: string,
  token: string,
  owner: string,
  repo: string,
  webhookSecret?: string,
): Promise<{ id: string; provider: string; enabled: boolean }> {
  return request(`/api/integrations/github/connect`, {
    method: 'POST',
    body: JSON.stringify({ workspaceId, token, owner, repo, webhookSecret }),
  });
}

export function linkGitHubIssue(
  mapId: string,
  nodeId: string,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<{ node: Node; issue: any }> {
  return request(`/api/maps/${mapId}/nodes/${nodeId}/github/link`, {
    method: 'POST',
    body: JSON.stringify({ owner, repo, issueNumber }),
  });
}

export function createGitHubIssue(
  mapId: string,
  nodeId: string,
): Promise<{ node: Node; issue: any }> {
  return request(`/api/maps/${mapId}/nodes/${nodeId}/github/create`, {
    method: 'POST',
  });
}

export function importGitHubIssues(
  mapId: string,
  createdBy: string,
  parentNodeId?: string,
): Promise<{ imported: number; nodes: Array<{ nodeId: string; issueNumber: number }> }> {
  return request(`/api/maps/${mapId}/github/import`, {
    method: 'POST',
    body: JSON.stringify({ createdBy, parentNodeId }),
  });
}

export function getGitHubStatus(mapId: string, nodeId: string): Promise<GitHubStatusResponse> {
  return request<GitHubStatusResponse>(`/api/maps/${mapId}/nodes/${nodeId}/github/status`);
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
  return request<GitHubSyncOverview>(`/api/maps/${mapId}/github/sync-overview${qs}`);
}

export interface GitHubReconcileResult {
  repo: string;
  fetched: number;
  applied: number;
  skipped: number;
  noTransition: number;
  /** Nodes auto-created in the ingest pass (issues with no linked node yet). */
  ingested: number;
  /**
   * Count of per-issue / per-inbox errors raised during the ingest pass.
   * When >0 the server deliberately does NOT bump `lastSyncedAt` so the next
   * catch-up tick will re-fetch the failed issues. Surfaced in the UI as an
   * inline warning so partial failures are observable to the operator.
   */
  ingestErrored: number;
  /**
   * Count of node-update errors hit during the state-sync loop. Same retry
   * semantics as `ingestErrored` — the next tick will retry the window.
   */
  stateSyncErrored: number;
  durationMs: number;
  since: string | null;
  error?: string;
}

export function reconcileGitHub(mapId: string): Promise<GitHubReconcileResult> {
  return request<GitHubReconcileResult>(`/api/maps/${mapId}/github/reconcile`, {
    method: 'POST',
  });
}

/** Result of a backfill ingest dry-run: candidates the server would import. */
export interface GitHubIngestDryRunResult {
  wouldImport: number;
  candidates: number[];
}

/** Result of a backfill ingest commit: nodes actually imported into the inbox. */
export interface GitHubIngestCommitResult {
  imported: number;
  capped: boolean;
  total: number;
}

/**
 * Backfill any unlinked GitHub issues (open + closed-within-30d) into
 * the map's Inbox. Dry-run first to surface the count, then commit on
 * user confirmation.
 */
export function ingestNewIssues(
  mapId: string,
  opts: { dryRun: true },
): Promise<GitHubIngestDryRunResult>;
export function ingestNewIssues(
  mapId: string,
  opts?: { dryRun?: false },
): Promise<GitHubIngestCommitResult>;
export function ingestNewIssues(
  mapId: string,
  opts: { dryRun?: boolean } = {},
): Promise<GitHubIngestDryRunResult | GitHubIngestCommitResult> {
  const qs = opts.dryRun ? '?dryRun=true' : '';
  return request(`/api/maps/${mapId}/github/ingest-new${qs}`, {
    method: 'POST',
  });
}

// ── Maps ─────────────────────────────────────────────────────────

export function fetchMaps(): Promise<MapSummary[]> {
  return request<MapSummary[]>('/api/maps');
}

export function fetchMap(
  id: string,
  opts?: {
    /**
     * Heavy display-only fields to strip from every node in the payload
     * (server allowlist: 'description', 'externalLinks'). Used by the
     * mobile app; omitted fields are absent from the JSON, so consumers
     * must fetch the full node (fetchNode) before rendering them.
     */
    omit?: Array<'description' | 'externalLinks'>;
  },
): Promise<MapDetail> {
  const q = opts?.omit?.length ? `?omit=${opts.omit.join(',')}` : '';
  return request<MapDetail>(`/api/maps/${id}${q}`);
}

export function fetchNode(mapId: string, nodeId: string): Promise<Node> {
  return request<Node>(`/api/maps/${mapId}/nodes/${nodeId}`);
}

export interface NodeActor {
  nodeId: string;
  userId: string;
  userName: string;
}

/** Who last touched each node — the Workload view's attribution fallback. */
export function fetchNodeActors(mapId: string): Promise<{ actors: NodeActor[] }> {
  return request<{ actors: NodeActor[] }>(`/api/maps/${mapId}/nodes/actors`);
}

export function createMap(name: string): Promise<MindMap> {
  // createdBy will be inferred from the auth token on the server,
  // but we send it as fallback for compatibility
  return request<MindMap>('/api/maps', {
    method: 'POST',
    body: JSON.stringify({
      name,
      workspaceId: 'default',
      createdBy: 'current-user',
    }),
  });
}

export function updateMap(id: string, fields: Record<string, unknown>): Promise<MindMap> {
  return request<MindMap>(`/api/maps/${id}`, {
    method: 'PUT',
    body: JSON.stringify(fields),
  });
}

/**
 * Fetch the requirements register rendered as a Markdown
 * Anforderungsdokument. Raw text — not JSON.
 */
/**
 * Fetch the requirements register as a Word document (docx) — the
 * format business consumers actually open. Returns a Blob for download.
 */
/**
 * Filter mirror of the Requirements view's filter bar — forwarded to the
 * export route so the document matches what's on screen.
 */
export interface RequirementsExportFilter {
  status?: 'open' | 'partial' | 'done';
  priority?: 'must' | 'should' | 'could';
  /** Version id, or 'none' for "no release assigned". */
  release?: string;
  releaseMode?: 'cumulative' | 'exact';
  hideDone?: boolean;
  acceptance?: 'none' | 'mine-open' | 'rejected';
}

function requirementsExportQuery(format: string, filter: RequirementsExportFilter): string {
  const params = new URLSearchParams({ format });
  if (filter.status) params.set('status', filter.status);
  if (filter.priority) params.set('priority', filter.priority);
  if (filter.release) {
    params.set('release', filter.release);
    if (filter.releaseMode === 'exact' && filter.release !== 'none') {
      params.set('releaseMode', 'exact');
    }
  }
  if (filter.hideDone) params.set('hideDone', '1');
  if (filter.acceptance) params.set('acceptance', filter.acceptance);
  return `?${params.toString()}`;
}

export async function exportRequirementsDocx(
  mapId: string,
  filter: RequirementsExportFilter = {},
): Promise<Blob> {
  const token = getToken();
  const query = requirementsExportQuery('docx', filter);
  const res = await fetch(`${BASE_URL}/api/maps/${mapId}/requirements-export${query}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`Export failed: HTTP ${res.status}`);
  return res.blob();
}

export async function exportRequirements(mapId: string): Promise<string> {
  const token = getToken();
  const res = await fetch(`${BASE_URL}/api/maps/${mapId}/requirements-export`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`Export failed: HTTP ${res.status}`);
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
  decision: 'accepted' | 'rejected';
  comment: string | null;
}

export function fetchAcceptances(mapId: string): Promise<{ acceptances: AcceptanceRow[] }> {
  return request<{ acceptances: AcceptanceRow[] }>(`/api/maps/${mapId}/acceptances`);
}

export function acceptRequirement(
  mapId: string,
  nodeId: string,
  verdict?: { decision: 'accepted' | 'rejected'; comment?: string },
): Promise<AcceptanceRow> {
  return request<AcceptanceRow>(`/api/maps/${mapId}/nodes/${nodeId}/acceptance`, {
    method: 'POST',
    body: JSON.stringify(verdict ?? {}),
  });
}

export function revokeAcceptance(mapId: string, nodeId: string): Promise<void> {
  return request<void>(`/api/maps/${mapId}/nodes/${nodeId}/acceptance`, { method: 'DELETE' });
}

// ── Nodes ────────────────────────────────────────────────────────

export function createNode(
  mapId: string,
  parentId: string,
  text: string,
  position?: number,
  coords?: { x: number; y: number },
  /**
   * Extra node fields to set atomically at create time (e.g.
   * requirementId). Preferred over a follow-up updateNode when the
   * caller only has a temp id — the store skips the API for temp ids,
   * so post-create enrichment can silently fail to persist.
   */
  fields?: Partial<Node>,
): Promise<Node> {
  return request<Node>(`/api/maps/${mapId}/nodes`, {
    method: 'POST',
    body: JSON.stringify({
      ...(fields ?? {}),
      parentId,
      text,
      createdBy: 'current-user',
      position,
      x: coords?.x,
      y: coords?.y,
    }),
  });
}

export function updateNode(
  mapId: string,
  nodeId: string,
  fields: Partial<Node>,
  expectedRevision?: number,
): Promise<Node> {
  const body =
    expectedRevision !== undefined ? { ...fields, expectedRevision } : fields;
  return request<Node>(`/api/maps/${mapId}/nodes/${nodeId}`, {
    method: 'PUT',
    body: JSON.stringify(body),
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
  position: number,
): Promise<Node> {
  return request<Node>(`/api/maps/${mapId}/nodes/${nodeId}/move`, {
    method: 'PUT',
    body: JSON.stringify({ newParentId, position }),
  });
}

export function reorderChildren(
  mapId: string,
  parentId: string,
  childrenIds: string[],
): Promise<{ success: true }> {
  return request<{ success: true }>(`/api/maps/${mapId}/nodes/reorder`, {
    method: 'PUT',
    body: JSON.stringify({ parentId, childrenIds }),
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

export function listDeleted(
  mapId: string,
  opts?: { sinceDays?: number; limit?: number },
): Promise<{ deleted: DeletedNodeSummary[] }> {
  const params = new URLSearchParams();
  if (opts?.sinceDays != null) params.set('sinceDays', String(opts.sinceDays));
  if (opts?.limit != null) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return request<{ deleted: DeletedNodeSummary[] }>(
    `/api/maps/${mapId}/trash${qs ? `?${qs}` : ''}`,
  );
}

export function restoreNode(
  mapId: string,
  nodeId: string,
  opts?: { recursive?: boolean },
): Promise<{ restoredIds: string[]; affectedParentIds: string[]; node: Node | null }> {
  return request(`/api/maps/${mapId}/nodes/${nodeId}/restore`, {
    method: 'POST',
    body: JSON.stringify({ recursive: opts?.recursive === true }),
  });
}

// ── Schedule ─────────────────────────────────────────────────────

export interface ScheduleResponse {
  schedule: ScheduledNode[];
  criticalPath: CriticalPathResult;
  projectStartDate: string;
  effortUnit: 'hours' | 'days' | 'points';
  unitsPerDay: number;
  workerCount: number;
  /** Fraction of calendar time reaching planned work (0.05–1.0); default 1. */
  focusFactor: number;
}

export function fetchSchedule(mapId: string): Promise<ScheduleResponse> {
  return request<ScheduleResponse>(`/api/maps/${mapId}/schedule`);
}

// ── Cycles / Sprints ────────────────────────────────────────────

export function fetchCycles(mapId: string): Promise<Cycle[]> {
  return request<Cycle[]>(`/api/cycles?mapId=${encodeURIComponent(mapId)}`);
}

export function createCycle(
  mapId: string,
  name: string,
  startDate: string,
  endDate: string,
): Promise<Cycle> {
  return request<Cycle>('/api/cycles', {
    method: 'POST',
    body: JSON.stringify({ mapId, name, startDate, endDate }),
  });
}

export function getCycle(id: string): Promise<Cycle> {
  return request<Cycle>(`/api/cycles/${id}`);
}

export function updateCycle(id: string, fields: Partial<Cycle>): Promise<Cycle> {
  return request<Cycle>(`/api/cycles/${id}`, {
    method: 'PUT',
    body: JSON.stringify(fields),
  });
}

export function deleteCycle(id: string): Promise<void> {
  return request<void>(`/api/cycles/${id}`, { method: 'DELETE' });
}

export function assignNodeToCycle(cycleId: string, nodeId: string): Promise<void> {
  return request<void>(`/api/cycles/${cycleId}/assign`, {
    method: 'POST',
    body: JSON.stringify({ nodeId }),
  });
}

export function unassignNodeFromCycle(cycleId: string, nodeId: string): Promise<void> {
  return request<void>(`/api/cycles/${cycleId}/assign/${nodeId}`, {
    method: 'DELETE',
  });
}

export function rolloverCycle(fromId: string, toId: string): Promise<void> {
  return request<void>(`/api/cycles/${fromId}/rollover`, {
    method: 'POST',
    body: JSON.stringify({ toId }),
  });
}

// ── Versions ────────────────────────────────────────────────────

export function fetchVersions(mapId: string): Promise<Version[]> {
  return request<Version[]>(`/api/versions?mapId=${encodeURIComponent(mapId)}`);
}

export interface CreateVersionFields {
  name: string;
  description?: string | null;
  status?: Version['status'];
  targetDate?: string | null;
}

export function createVersion(mapId: string, fields: CreateVersionFields): Promise<Version> {
  return request<Version>('/api/versions', {
    method: 'POST',
    body: JSON.stringify({ mapId, ...fields }),
  });
}

export function updateVersion(id: string, fields: Partial<CreateVersionFields>): Promise<Version> {
  return request<Version>(`/api/versions/${id}`, {
    method: 'PUT',
    body: JSON.stringify(fields),
  });
}

export function deleteVersion(id: string): Promise<void> {
  return request<void>(`/api/versions/${id}`, { method: 'DELETE' });
}

// ── Forecast ────────────────────────────────────────────────────

export interface ForecastResult {
  scopeLabel: string;
  leaves: number;
  noEstimateLeaves: number;
  totalEffort: number;
  remainingEffort: number;
  effortUnit: string;
  fudgeFactor: number | null;
  calibrationLeafCount: number;
  /** Why the fudge is withheld (evidence gate); null when applied or no samples. */
  calibrationNote?: string | null;
  projectStartDate: string;
  plannedFinishDate: string | null;
  velocityAdjustedFinishDate: string | null;
  targetDate: string | null;
  targetSource: string | null;
  slipPlannedDays: number | null;
  slipVelocityDays: number | null;
}

export function fetchForecast(
  mapId: string,
  scope: { nodeId?: string; versionId?: string } = {},
): Promise<ForecastResult> {
  const qs = new URLSearchParams();
  if (scope.nodeId) qs.set('nodeId', scope.nodeId);
  if (scope.versionId) qs.set('versionId', scope.versionId);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return request<ForecastResult>(`/api/maps/${mapId}/forecast${suffix}`);
}

// ── Release Forecast (capacity-constrained, sequential) ────────

export interface ReleaseForecastRow {
  versionId: string;
  versionName: string;
  versionStatus: 'planning' | 'active' | 'released' | 'archived';
  sortOrder: number;
  targetDate: string | null;
  leaves: number;
  noEstimateLeaves: number;
  totalEffort: number;
  remainingEffort: number;
  /** Open (progress < 99.5%) leaves in scope — the ticket model's numerator. */
  remainingTickets: number;
  /** Where the projected span begins: the previous release's projected finish. */
  effectiveStartDate: string | null;
  plannedFinishDate: string | null;
  velocityAdjustedFinishDate: string | null;
  /** Diagnostic only — the table renders `confidence` instead of a second date. */
  ticketModelFinishDate: string | null;
  /** Open leaves with no estimate — invisible to the day model. */
  unestimatedOpenLeaves: number;
  /** How much to trust velocityAdjustedFinishDate, and why not more. */
  confidence: {
    level: 'agree' | 'caution' | 'unmeasured';
    divergenceDays: number | null;
    unestimatedOpenLeaves: number;
    note: string;
  };
  slipPlannedDays: number | null;
  slipVelocityDays: number | null;
  slipTicketDays: number | null;
  // 7-day trend — positive = slipped later, negative = pulled in.
  // null until the snapshot job has a row from 7 days ago.
  plannedFinishDeltaDays7d: number | null;
  velocityFinishDeltaDays7d: number | null;
}

export interface ReleaseForecastResponse {
  projectStartDate: string;
  effortUnit: string;
  dailyCapacity: number;
  fudgeFactor: number | null;
  /** Fraction of calendar time reaching planned work (0.05–1.0); default 1. */
  focusFactor: number;
  calibrationLeafCount: number;
  /** Why the fudge is withheld (evidence gate); null when applied or no samples. */
  calibrationNote?: string | null;
  /**
   * Measured net rates. When `netEffortPerDay` is set it DRIVES the velocity
   * line and `focusFactor` is inert — measurement beats knob.
   */
  netEffortPerDay?: number | null;
  netTicketsPerDay?: number | null;
  ratesWindowDays?: number | null;
  releases: ReleaseForecastRow[];
  lastSnapshotAt: string | null;
}

export function fetchReleaseForecast(
  mapId: string,
  opts: { refresh?: boolean } = {},
): Promise<ReleaseForecastResponse> {
  const suffix = opts.refresh ? '?refresh=1' : '';
  return request<ReleaseForecastResponse>(`/api/maps/${mapId}/release-forecast${suffix}`);
}

// ── Calendar subscribe URL ─────────────────────────────────────

export type CalendarIcsView = 'full' | 'milestones' | 'owned';

export interface CalendarSubscribeUrlPair {
  httpsUrl: string;
  webcalUrl: string;
}

export interface CalendarSubscribeUrls {
  views: Record<CalendarIcsView, CalendarSubscribeUrlPair>;
}

export function fetchCalendarSubscribeUrl(mapId: string): Promise<CalendarSubscribeUrls> {
  return request<CalendarSubscribeUrls>(`/api/maps/${mapId}/calendar-url`);
}

// ── AI ─────────────────────────────────────────────────────────

export interface BreakdownSuggestion {
  text: string;
  estimate: number | null;
  /** Optional grouped children — when present, this entry is a category and
   * its estimate field should be ignored (parent auto-computes from leaves). */
  children?: BreakdownSuggestion[];
}

export function aiBreakdown(
  mapId: string,
  nodeId: string,
  count?: number,
  hint?: string,
): Promise<{ suggestions: BreakdownSuggestion[] }> {
  return request('/api/ai/breakdown', {
    method: 'POST',
    body: JSON.stringify({ mapId, nodeId, count, hint }),
  });
}

export function aiBreakdownAccept(
  mapId: string,
  parentId: string,
  tasks: BreakdownSuggestion[],
): Promise<{ created: Node[] }> {
  return request('/api/ai/breakdown/accept', {
    method: 'POST',
    body: JSON.stringify({ mapId, parentId, tasks }),
  });
}

export interface BraindumpNode {
  text: string;
  estimate: number | null;
  children: BraindumpNode[];
}

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

export interface ReadyNodesResponse {
  mapId: string;
  ready: ReadyNode[];
  total: number;
  returned: number;
}

export function fetchReadyNodes(
  mapId: string,
  opts: { limit?: number; scope?: string[] } = {},
): Promise<ReadyNodesResponse> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.scope && opts.scope.length > 0) params.set('scope', opts.scope.join(','));
  const qs = params.toString();
  return request<ReadyNodesResponse>(
    `/api/maps/${encodeURIComponent(mapId)}/nodes/ready${qs ? `?${qs}` : ''}`,
  );
}

export function aiBraindump(
  mapId: string,
  parentId: string,
  prose: string,
  maxDepth?: number,
): Promise<{ tree: BraindumpNode[] }> {
  return request('/api/ai/braindump', {
    method: 'POST',
    body: JSON.stringify({ mapId, parentId, prose, maxDepth }),
  });
}

export function aiBraindumpAccept(
  mapId: string,
  parentId: string,
  tree: BraindumpNode[],
): Promise<{ createdCount: number }> {
  return request('/api/ai/braindump/accept', {
    method: 'POST',
    body: JSON.stringify({ mapId, parentId, tree }),
  });
}

export interface GroupProposal {
  kind: 'group';
  memberIds: string[];
  suggestedLabel: string;
  reason: string;
}

export function aiRefineStructure(
  mapId: string,
  nodeId: string,
): Promise<{ proposals: GroupProposal[]; summary: string }> {
  return request('/api/ai/refine_structure', {
    method: 'POST',
    body: JSON.stringify({ mapId, nodeId }),
  });
}

export function aiRefineStructureApply(
  mapId: string,
  parentId: string,
  proposals: Array<Pick<GroupProposal, 'kind' | 'memberIds' | 'suggestedLabel'>>,
): Promise<{ createdCount: number; movedCount: number }> {
  return request('/api/ai/refine_structure/apply', {
    method: 'POST',
    body: JSON.stringify({ mapId, parentId, proposals }),
  });
}

export interface EstimateResult {
  /** Raw planning units — velocity corrections happen at forecast time. */
  estimate: number;
  rawEstimate: number;
  confidence: 'low' | 'medium' | 'high';
  notes?: string;
  samplesUsed: number;
  /** Evidence-gated; null = calibration below threshold, forecasts use 1.0. */
  fudgeFactor: number | null;
  calibrationNote: string | null;
  effortUnit: string;
}

export function aiEstimate(
  mapId: string,
  opts: { text?: string; nodeId?: string; hint?: string },
): Promise<EstimateResult> {
  return request('/api/ai/estimate', {
    method: 'POST',
    body: JSON.stringify({ mapId, ...opts }),
  });
}

export interface SemanticMatch {
  nodeId: string;
  text: string;
  score: number;
}

export function aiSearch(
  mapId: string,
  q: string,
  limit = 10,
): Promise<{ matches: SemanticMatch[] }> {
  const params = new URLSearchParams({ mapId, q, limit: String(limit) });
  return request(`/api/ai/search?${params.toString()}`);
}

export function aiBackfillEmbeddings(mapId: string): Promise<{ embedded: number; skipped: number; total: number }> {
  return request('/api/ai/embeddings/backfill', {
    method: 'POST',
    body: JSON.stringify({ mapId }),
  });
}

export type AiProviderPreference = 'auto' | 'ollama' | 'anthropic';
export type AiProviderName = 'ollama' | 'anthropic';

export interface AiProviderSettings {
  preference: AiProviderPreference;
}

export interface AiConfigResponse {
  enabled: boolean;
  model: string;
  active: { name: AiProviderName; model: string } | null;
  preference: AiProviderPreference;
  preferenceHonored: boolean;
  available: { ollama: boolean; anthropic: boolean };
  models: { ollama: string | null; anthropic: string | null };
}

export function aiConfig(): Promise<AiConfigResponse> {
  return request('/api/ai/config');
}

export function getAiProvider(): Promise<AiProviderSettings> {
  return request('/api/system/ai-provider');
}

export function setAiProvider(settings: AiProviderSettings): Promise<AiProviderSettings> {
  return request('/api/system/ai-provider', {
    method: 'PUT',
    body: JSON.stringify(settings),
  });
}

export interface ChatSSEEvent {
  type: 'delta' | 'tool_call' | 'tool_result' | 'step_limit' | 'done' | 'error';
  content?: string;
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  message?: string;
  code?: string;
  maxSteps?: number;
}

/**
 * Stream a chat conversation with the AI. Returns an async iterator of SSE events.
 * The AI can call tools (create/move/delete nodes) and we get notified of each step.
 *
 * If the underlying stream closes before a `done` or `error` event arrives
 * (e.g. server crash, proxy timeout, killed connection), the generator throws
 * an Error tagged `code: 'AI_DISCONNECTED'` so the UI can surface it instead
 * of silently leaving the user staring at a half-written reply.
 */
export async function* aiChat(
  mapId: string,
  messages: Array<{
    role: string;
    content: string;
    toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown>; result?: unknown }>;
  }>,
  options?: { selectedNodeId?: string | null; signal?: AbortSignal },
): AsyncGenerator<ChatSSEEvent> {
  const token = getToken();
  const res = await fetch(`${BASE_URL}/api/ai/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      mapId,
      messages,
      selectedNodeId: options?.selectedNodeId ?? null,
    }),
    signal: options?.signal,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body?.error?.message ?? res.statusText, body?.error?.code);
  }

  const reader = res.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = '';
  let sawTerminal = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    let currentEvent = '';
    for (const line of lines) {
      if (line.startsWith('event: ')) {
        currentEvent = line.slice(7).trim();
      } else if (line.startsWith('data: ') && currentEvent) {
        try {
          const data = JSON.parse(line.slice(6));
          if (currentEvent === 'done' || currentEvent === 'error') sawTerminal = true;
          yield { type: currentEvent as ChatSSEEvent['type'], ...data };
        } catch { /* skip malformed */ }
        currentEvent = '';
      }
    }
  }

  if (!sawTerminal && !options?.signal?.aborted) {
    const err = new Error('Connection to the AI was lost mid-response.');
    (err as Error & { code?: string }).code = 'AI_DISCONNECTED';
    throw err;
  }
}

// ── Triage decisions (#92, #93, #94) ─────────────────────────────
//
// Mirrors the server-side `triage_decisions` table. Operator drives
// review via three actions: confirm (mark reviewed), override (pick
// a different placement), and reclassify (re-run the LLM).

export type TriageDecisionKind = 'place' | 'skip' | 'uncertain';

export interface TriageDecision {
  id: string;
  mapId: string;
  externalId: string; // "owner/repo#NNN"
  issueTitle: string;
  issueState: 'open' | 'closed';
  decision: TriageDecisionKind;
  reason: string;
  confidence: number; // 0-100
  placedNodeId: string | null;
  /**
   * The LLM's most recent suggested parent (for `place` decisions).
   * Distinct from `placedNodeId` — the suggestion is the LLM's pick;
   * `placedNodeId` is set only when a node was actually created. On
   * low-confidence places, the suggestion is what the Override modal
   * pre-selects.
   *
   * Operator overrides do NOT update this field — it always reflects
   * the latest LLM suggestion, so the audit history can show "Claude
   * suggested X, operator chose Y".
   */
  suggestedParentNodeId: string | null;
  decidedAt: string;
  decidedBy: 'auto' | 'operator';
  reviewed: boolean;
  reviewedAt: string | null;
  reviewedBy: string | null;
}

export interface ListTriageDecisionsFilters {
  reviewed?: boolean;
  decision?: TriageDecisionKind;
  limit?: number;
  /** Phase 2 (#95): inclusive lower bound on confidence (0–100). */
  minConfidence?: number;
  /** Phase 2 (#95): inclusive upper bound on confidence (0–100). */
  maxConfidence?: number;
  /** Phase 2 (#95): exact-match on the GH state captured at decision time. */
  issueState?: 'open' | 'closed';
  /** Phase 2 (#95): only rows decided at or after this ISO timestamp. */
  since?: string;
}

export interface ListTriageDecisionsResponse {
  mapId: string;
  total: number;
  decisions: TriageDecision[];
}

export function listTriageDecisions(
  mapId: string,
  filters: ListTriageDecisionsFilters = {},
): Promise<ListTriageDecisionsResponse> {
  const qs = new URLSearchParams();
  if (filters.reviewed !== undefined) qs.set('reviewed', String(filters.reviewed));
  if (filters.decision) qs.set('decision', filters.decision);
  if (filters.limit) qs.set('limit', String(filters.limit));
  if (filters.minConfidence !== undefined) qs.set('minConfidence', String(filters.minConfidence));
  if (filters.maxConfidence !== undefined) qs.set('maxConfidence', String(filters.maxConfidence));
  if (filters.issueState) qs.set('issueState', filters.issueState);
  if (filters.since) qs.set('since', filters.since);
  const q = qs.toString();
  return request<ListTriageDecisionsResponse>(
    `/api/maps/${mapId}/triage-decisions${q ? `?${q}` : ''}`,
  );
}

export interface OverrideTriageBody {
  decision: TriageDecisionKind;
  parentNodeId?: string;
  reason?: string;
}

export interface OverrideTriageResponse {
  decisionId: string;
  status: 'placed' | 'moved' | 'already_placed' | 'skip' | 'uncertain';
  nodeId: string | null;
}

export function overrideTriageDecision(
  mapId: string,
  decisionId: string,
  body: OverrideTriageBody,
): Promise<OverrideTriageResponse> {
  return request<OverrideTriageResponse>(
    `/api/maps/${mapId}/triage-decisions/${decisionId}/override`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
  );
}

export interface ReclassifyTriageResponse {
  decisionId: string;
  decision: TriageDecisionKind;
  confidence: number;
  reason: string;
  parentNodeId: string | null;
  /**
   * The (potentially-just-nulled) placedNodeId after reclassify. When
   * a previously-placed row reclassifies to skip/uncertain, the server
   * nulls this; surfacing it here saves the client a refetch.
   * (#100 Round 2 nit from Ray.)
   */
  placedNodeId: string | null;
  /**
   * The LLM's newly-suggested parent. Always reflects what was just
   * written to the row's `suggestedParentNodeId` column — null on
   * skip/uncertain, the suggested epic UUID on place.
   */
  suggestedParentNodeId: string | null;
}

export function reclassifyTriageDecision(
  mapId: string,
  decisionId: string,
): Promise<ReclassifyTriageResponse> {
  return request<ReclassifyTriageResponse>(
    `/api/maps/${mapId}/triage-decisions/${decisionId}/reclassify`,
    { method: 'POST' },
  );
}

export interface ConfirmTriageResponse {
  decisionId: string;
  status: 'confirmed';
  nodeId: string | null;
}

/**
 * Confirm a triage decision (mark reviewed). Hits the dedicated
 * `/confirm` route — does NOT send a `parentNodeId`. The original
 * implementation routed through `overrideTriageDecision` with
 * `parentNodeId: decision.placedNodeId`, which fell through the
 * override's already-placed branch and self-loop'd the node
 * (`moveNode(placedNodeId, placedNodeId)`). Ray flagged this on the
 * #100 review — splitting into a dedicated route makes the misuse
 * impossible at the API boundary.
 */
export function confirmTriageDecision(
  mapId: string,
  decision: TriageDecision,
): Promise<ConfirmTriageResponse> {
  return request<ConfirmTriageResponse>(
    `/api/maps/${mapId}/triage-decisions/${decision.id}/confirm`,
    { method: 'POST' },
  );
}

// ── Bulk variants (#95 Phase 2) ──────────────────────────────────
//
// Each variant accepts `{ decisionIds: string[] }` and returns
// `{ mapId, results: BulkTriageItem[] }` where each item is either
// `{ id, status, ... }` (success) or `{ id, error: { code, message } }`
// (per-item failure). HTTP is always 200 unless the whole batch is
// rejected (bad auth, malformed body) — a single bad row in an
// otherwise-valid batch is reported per-item, not as a batch-level error.

export interface BulkTriageItemOk {
  id: string;
  status: string;
  nodeId?: string | null;
  decision?: TriageDecisionKind;
  confidence?: number;
  reason?: string;
  placedNodeId?: string | null;
  /**
   * Populated by bulk-reclassify per-item results — mirrors the
   * single-reclassify response shape so the UI can pre-select the
   * new LLM suggestion in the Override modal without a refetch.
   */
  suggestedParentNodeId?: string | null;
}

export interface BulkTriageItemErr {
  id: string;
  error: { code: string; message: string };
}

export type BulkTriageItem = BulkTriageItemOk | BulkTriageItemErr;

/**
 * Phase 3 follow-up (#102 item 8): `results` preserves the order of the
 * submitted `decisionIds` array AFTER dedupe — the server strips repeated
 * ids (UI double-tap) before iterating, so a request with
 * `decisionIds=['a', 'b', 'a']` yields a 2-item `results` array `[a, b]`,
 * not 3 items. Callers that need to correlate `results[i]` to a specific
 * input id should match on `results[i].id` rather than relying on
 * positional alignment with the raw submitted array.
 *
 * `mapId` echoes the path parameter so a client that received the response
 * via a fan-out (multiple maps) can route results.
 */
export interface BulkTriageResponse {
  mapId: string;
  results: BulkTriageItem[];
}

export function bulkConfirmTriageDecisions(
  mapId: string,
  decisionIds: string[],
): Promise<BulkTriageResponse> {
  return request<BulkTriageResponse>(
    `/api/maps/${mapId}/triage-decisions/bulk-confirm`,
    {
      method: 'POST',
      body: JSON.stringify({ decisionIds }),
    },
  );
}

export function bulkOverrideTriageDecisions(
  mapId: string,
  decisionIds: string[],
  parentNodeId: string,
): Promise<BulkTriageResponse> {
  return request<BulkTriageResponse>(
    `/api/maps/${mapId}/triage-decisions/bulk-override`,
    {
      method: 'POST',
      body: JSON.stringify({ decisionIds, parentNodeId }),
    },
  );
}

export function bulkReclassifyTriageDecisions(
  mapId: string,
  decisionIds: string[],
): Promise<BulkTriageResponse> {
  return request<BulkTriageResponse>(
    `/api/maps/${mapId}/triage-decisions/bulk-reclassify`,
    {
      method: 'POST',
      body: JSON.stringify({ decisionIds }),
    },
  );
}

// ── Not-in-MindBlown unified view (#140) ─────────────────────────
//
// Surfaces every GitHub ticket that isn't currently a node in this map,
// split into four buckets:
//   - 'skipped'         — decision=skip AND reviewed=true
//   - 'pending-skipped' — decision=skip AND reviewed=false
//   - 'uncertain'       — decision=uncertain
//   - 'orphan'          — no triage row + no node carrying the externalId
//
// The orphan bucket needs a live GitHub fetch via importGitHubIssues; if
// GitHub isn't configured (or the API call fails) we still return the
// decision-row buckets and signal the orphan-bucket state via
// `orphansAvailable` + `orphansError`.

export type NotInMindBlownBucket =
  | 'skipped'
  | 'pending-skipped'
  | 'uncertain'
  | 'orphan';

export interface NotInMindBlownItem {
  kind: NotInMindBlownBucket;

  // Decision-row buckets (skipped/pending-skipped/uncertain) carry these.
  // Orphans have neither.
  triageDecisionId?: string;
  decision?: 'skip' | 'uncertain';
  reason?: string;
  confidence?: number;
  decidedAt?: string;

  // Common fields — always set.
  externalId: string; // "owner/repo#NNN"
  issueTitle: string;
  issueState: 'open' | 'closed';
  issueUrl: string;
}

export interface ListNotInMindBlownFilters {
  /** Narrow to one bucket (or pass 'all' / omit to get everything). */
  bucket?: NotInMindBlownBucket | 'all' | 'orphans';
  /** Default 50, hard cap 200. */
  limit?: number;
  /** ISO timestamp — applies only to decision-row buckets. */
  since?: string;
}

export interface ListNotInMindBlownResponse {
  mapId: string;
  bucket: string;
  total: number;
  returned: number;
  /** False when GitHub isn't configured or the import call failed. */
  orphansAvailable: boolean;
  /** Set when orphansAvailable is false, explains why. */
  orphansError: string | null;
  items: NotInMindBlownItem[];
  /**
   * Pre-pagination per-bucket counts. Reflects the true backlog size
   * even when `items` is short (default limit=50, hard cap 200). The
   * "Not in MindBlown" view uses these to label the trigger banner +
   * size the drift-audit slider correctly — without them the slider
   * caps at min(orphanCount, items.length) which is wrong whenever
   * the orphan tail is bigger than the page.
   *
   * Optional for compatibility with pre-2026-06-08 servers; UI falls
   * back to counting `items` when the field is absent.
   */
  counts?: {
    orphan: number;
    skipped: number;
    'pending-skipped': number;
    uncertain: number;
  };
}

export interface OrphanImportBody {
  externalId: string;
  issueTitle: string;
  issueState?: 'open' | 'closed';
  parentNodeId: string;
  reason?: string;
}

export interface OrphanImportResponse {
  decisionId: string | null;
  nodeId: string | null;
  status: 'imported';
}

export function importOrphanIssue(
  mapId: string,
  body: OrphanImportBody,
): Promise<OrphanImportResponse> {
  return request<OrphanImportResponse>(
    `/api/maps/${mapId}/triage-decisions/orphan-import`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
  );
}

export interface OrphanSkipBody {
  externalId: string;
  issueTitle: string;
  issueState?: 'open' | 'closed';
  reason?: string;
}

export interface OrphanSkipResponse {
  decisionId: string | null;
  status: 'skipped';
}

export function skipOrphanIssue(
  mapId: string,
  body: OrphanSkipBody,
): Promise<OrphanSkipResponse> {
  return request<OrphanSkipResponse>(
    `/api/maps/${mapId}/triage-decisions/orphan-skip`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
  );
}

/**
 * Manual per-map drift audit. Pushes a single batch of orphans through
 * auto-backfill (= per-issue triage + placement), instead of waiting for
 * the daily scheduled sweep to chew through them ~50/day.
 *
 * - `max` is the upper bound on issues processed in this one call.
 *   Pass undefined to process every drifted issue in one shot.
 * - Returns counters the caller renders in a toast / inline summary.
 */
export interface DriftAuditRunResponse {
  mapId: string;
  mapName: string;
  drift: { onlyInGitHub: number; exampleIssues: number[] };
  autoBackfill: {
    totalImported: number;
    totalManualPending: number;
    outcomes: Array<
      | { mapId: string; mapName: string; kind: 'healed'; imported: number }
      | { mapId: string; mapName: string; kind: 'over-cap'; pending: number }
      | { mapId: string; mapName: string; kind: 'failed'; pending: number; reason: string }
    >;
  };
  counts: {
    driftedIssues: number;
    /**
     * Total orphans actually run through Claude this batch. Sum of
     * placed + skipped + uncertain. Reflects the operator's slider
     * cap, NOT the full orphan count (which is driftedIssues).
     */
    triaged: number;
    /** Decision='place' → node was auto-created. */
    placed: number;
    /** Decision='skip' → triage row, no node. Finished, not pending. */
    skipped: number;
    /** Decision='uncertain' → goes to Pending review tab. */
    uncertain: number;
    /** Per-issue ingest failures (network, LLM timeout, etc.). */
    errored: number;
    /**
     * Orphans NOT processed this run because they were above the
     * operator's slider cap. These remain orphans and need another
     * audit run to clear.
     */
    queuedForNextRun: number;
    elapsedMs: number;
    /** @deprecated Use `placed` instead. Kept for the old banner. */
    imported?: number;
    /** @deprecated Use `queuedForNextRun` instead. */
    manualPending?: number;
  };
}

export function runDriftAuditForMap(
  mapId: string,
  opts: { max?: number } = {},
): Promise<DriftAuditRunResponse> {
  const qs = new URLSearchParams();
  if (opts.max != null) qs.set('max', String(opts.max));
  const q = qs.toString();
  return request<DriftAuditRunResponse>(
    `/api/maps/${mapId}/triage-decisions/drift-audit/run${q ? `?${q}` : ''}`,
    { method: 'POST' },
  );
}

export function listNotInMindBlown(
  mapId: string,
  filters: ListNotInMindBlownFilters = {},
): Promise<ListNotInMindBlownResponse> {
  const qs = new URLSearchParams();
  if (filters.bucket) {
    // Server accepts 'orphan' as a bucket value but the user-facing
    // filter is plural ('orphans'); honor either spelling on the way
    // out. The server validation matches both.
    qs.set('bucket', filters.bucket === 'orphan' ? 'orphans' : filters.bucket);
  }
  if (filters.limit) qs.set('limit', String(filters.limit));
  if (filters.since) qs.set('since', filters.since);
  const q = qs.toString();
  return request<ListNotInMindBlownResponse>(
    `/api/maps/${mapId}/triage-decisions/not-in-mindblown${q ? `?${q}` : ''}`,
  );
}

// ── Plan lint (plan-health panel, docs/plan-linter.md) ────────────

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

export function fetchLint(mapId: string): Promise<LintReport> {
  return request<LintReport>(`/api/maps/${mapId}/lint`);
}

/** nodeId null mutes the rule for the whole map. */
export function dismissLintFinding(
  mapId: string,
  ruleId: string,
  nodeId: string | null,
): Promise<unknown> {
  return request(`/api/maps/${mapId}/lint/dismissals`, {
    method: 'POST',
    body: JSON.stringify({ ruleId, nodeId }),
  });
}

export function undismissLintFinding(
  mapId: string,
  ruleId: string,
  nodeId: string | null,
): Promise<unknown> {
  const params = new URLSearchParams({ ruleId });
  if (nodeId) params.set('nodeId', nodeId);
  return request(`/api/maps/${mapId}/lint/dismissals?${params}`, { method: 'DELETE' });
}
