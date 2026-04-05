import type { Node, MindMap, Cycle } from '@mindblown/core';

const BASE_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

// ── Types ────────────────────────────────────────────────────────

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
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
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

// ── Maps ─────────────────────────────────────────────────────────

export function fetchMaps(): Promise<MapSummary[]> {
  return request<MapSummary[]>('/api/maps');
}

export function fetchMap(id: string): Promise<MapDetail> {
  return request<MapDetail>(`/api/maps/${id}`);
}

export function createMap(name: string): Promise<MindMap> {
  return request<MindMap>('/api/maps', {
    method: 'POST',
    body: JSON.stringify({
      name,
      workspaceId: 'default',
      createdBy: 'user-001',
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
    body: JSON.stringify({ parentId, text, createdBy: 'user-001', position }),
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
