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
}
