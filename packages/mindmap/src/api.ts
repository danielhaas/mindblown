import type { Node, MindMap, Cycle, Version } from '@mindblown/core';

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
  createdAt?: string;
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
    throw new ApiError(res.status, body?.error?.message ?? res.statusText, body?.error?.code);
  }
  if (res.status === 204) return undefined as unknown as T;
  return res.json();
}

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

export function fetchPermissions(mapId: string): Promise<Permission[]> {
  return request<Permission[]>(`/api/maps/${mapId}/permissions`);
}

export function shareMap(mapId: string, email: string, permission: string): Promise<Permission> {
  return request<Permission>(`/api/maps/${mapId}/share`, {
    method: 'POST',
    body: JSON.stringify({ email, permission }),
  });
}

export function revokePermission(mapId: string, userId: string): Promise<void> {
  return request<void>(`/api/maps/${mapId}/permissions/${userId}`, {
    method: 'DELETE',
  });
}

export function generatePublicLink(mapId: string): Promise<{ publicToken: string }> {
  return request<{ publicToken: string }>(`/api/maps/${mapId}/public-link`, {
    method: 'POST',
  });
}

// ── GitHub Integration ──────────────────────────────────────────

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

// ── Maps ─────────────────────────────────────────────────────────

export function fetchMaps(): Promise<MapSummary[]> {
  return request<MapSummary[]>('/api/maps');
}

export function fetchMap(id: string): Promise<MapDetail> {
  return request<MapDetail>(`/api/maps/${id}`);
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

// ── Nodes ────────────────────────────────────────────────────────

export function createNode(
  mapId: string,
  parentId: string,
  text: string,
  position?: number,
): Promise<Node> {
  return request<Node>(`/api/maps/${mapId}/nodes`, {
    method: 'POST',
    body: JSON.stringify({ parentId, text, createdBy: 'current-user', position }),
  });
}

export function updateNode(
  mapId: string,
  nodeId: string,
  fields: Partial<Node>,
): Promise<Node> {
  return request<Node>(`/api/maps/${mapId}/nodes/${nodeId}`, {
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
  position: number,
): Promise<Node> {
  return request<Node>(`/api/maps/${mapId}/nodes/${nodeId}/move`, {
    method: 'PUT',
    body: JSON.stringify({ newParentId, position }),
  });
}

// ── Schedule ─────────────────────────────────────────────────────

export function fetchSchedule(mapId: string): Promise<unknown> {
  return request(`/api/maps/${mapId}/schedule`);
}

// ── Cycles / Sprints ────────────────────────────────────────────

export function fetchCycles(workspaceId: string): Promise<Cycle[]> {
  return request<Cycle[]>(`/api/cycles?workspaceId=${encodeURIComponent(workspaceId)}`);
}

export function createCycle(
  workspaceId: string,
  name: string,
  startDate: string,
  endDate: string,
): Promise<Cycle> {
  return request<Cycle>('/api/cycles', {
    method: 'POST',
    body: JSON.stringify({ workspaceId, name, startDate, endDate }),
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

export function fetchVersions(workspaceId: string): Promise<Version[]> {
  return request<Version[]>(`/api/versions?workspaceId=${encodeURIComponent(workspaceId)}`);
}
