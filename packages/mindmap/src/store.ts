import { create } from 'zustand';
import type { Node, NodeId, ComputedNodeValues, MindMap, Cycle, Version } from '@mindblown/core';
import { computeTree } from '@mindblown/core';
import * as api from './api.js';
import type { MapSummary, AuthUser } from './api.js';
import { connectWs } from './ws.js';
import type { WsClient } from './ws.js';

// ── Helpers ────────────────────────────────────────────────────

function recomputeValues(nodes: Record<string, Node>): Map<NodeId, ComputedNodeValues> {
  const arr = Object.values(nodes);
  if (arr.length === 0) return new Map();
  return computeTree(arr);
}

// ── Store types ────────────────────────────────────────────────

export type ActiveView = 'mindmap' | 'kanban' | 'gantt' | 'list' | 'calendar' | 'hill' | 'workload' | 'releases' | 'requirements';

export interface VisibleNode {
  node: Node;
  depth: number; // depth relative to focusNode (0 = focusNode itself)
  hasHiddenChildren: boolean;
  hiddenDescendantCount: number;
  isDimmed: boolean; // true for sibling branches shown for context
}

/**
 * Live presence info for another user on this map.
 * Broadcast over WebSocket; viewport is encoded as a logical SVG center
 * (cx, cy) + zoom so it survives different window sizes.
 */
export interface RemotePresence {
  userId: string;
  name: string;
  cx: number;
  cy: number;
  zoom: number;
  focusNodeId: string | null;
  lastSeen: number;
}

export interface MindmapState {
  // Auth state
  user: AuthUser | null;
  token: string | null;

  // Map list
  maps: MapSummary[];
  currentMapId: string | null;
  currentMap: MindMap | null;

  // Node state
  nodes: Record<string, Node>;
  rootNodeId: string | null;
  selectedNodeIds: string[];
  selectedNodeId: string | null; // getter — first of selectedNodeIds
  editingNodeId: string | null;
  computed: Map<NodeId, ComputedNodeValues>;

  // Layout
  layoutType: 'tree-lr' | 'tree-tb' | 'radial' | 'org-chart';

  // Drill-down navigation
  focusNodeId: string | null;
  focusHistory: (string | null)[];
  maxDepth: number;

  // Cycle / sprint state
  cycles: Cycle[];
  activeCycleFilter: string | null;

  // Version state
  versions: Version[];
  activeVersionFilter: string | null;

  // UI state
  activeView: ActiveView;
  loading: boolean;
  error: string | null;
  wsConnected: boolean;

  // Presence / follow mode
  presence: Record<string, RemotePresence>;
  followingUserId: string | null;

  // Actions — auth
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<void>;
  logout: () => void;
  checkAuth: () => Promise<void>;

  // Actions — map level
  loadMaps: () => Promise<void>;
  loadMap: (id: string) => Promise<void>;
  createMap: (name: string) => Promise<void>;
  closeMap: () => void;
  updateMapName: (name: string) => void;

  // Actions — view
  setActiveView: (view: ActiveView) => void;

  // Actions — cycle / sprint
  loadCycles: () => Promise<void>;
  createCycle: (name: string, startDate: string, endDate: string) => Promise<void>;
  updateCycle: (id: string, fields: Partial<Cycle>) => Promise<void>;
  deleteCycle: (id: string) => Promise<void>;
  assignNodeToCycle: (nodeId: string, cycleId: string) => Promise<void>;
  unassignNodeFromCycle: (nodeId: string, cycleId: string) => Promise<void>;
  setActiveCycleFilter: (cycleId: string | null) => void;

  // Actions — version
  loadVersions: () => Promise<void>;
  createVersion: (fields: api.CreateVersionFields) => Promise<Version | null>;
  updateVersion: (id: string, fields: Partial<api.CreateVersionFields>) => Promise<void>;
  deleteVersion: (id: string) => Promise<void>;
  setActiveVersionFilter: (versionId: string | null) => void;

  // Actions — layout
  setLayoutType: (layout: 'tree-lr' | 'tree-tb' | 'radial' | 'org-chart') => void;

  // Actions — node level
  selectNode: (id: string | null) => void;
  toggleSelectNode: (id: string) => void;
  selectAllNodes: () => void;
  clearSelection: () => void;
  startEditing: (id: string | null) => void;
  addNode: (parentId: string, text?: string, asSibling?: boolean, position?: { x: number; y: number }, fields?: Partial<Node>) => string;
  updateNode: (id: string, updates: Partial<Node>) => void;
  deleteNode: (id: string) => void;
  moveNode: (nodeId: string, newParentId: string, index: number) => void;
  reorderChildren: (parentId: string, childrenIds: string[]) => void;
  toggleCollapse: (id: string) => void;

  // Soft-delete / Trash (#107)
  listDeletedNodes: (sinceDays?: number) => Promise<api.DeletedNodeSummary[]>;
  restoreNode: (nodeId: string, opts?: { recursive?: boolean }) => Promise<void>;
  expandAll: () => void;
  collapseAll: () => void;
  recompute: () => void;

  // Drill-down actions
  setFocusNode: (nodeId: string | null) => void;
  popFocusHistory: () => void;
  setMaxDepth: (depth: number) => void;

  // Presence / follow mode actions
  setFollowingUser: (userId: string | null) => void;
  getVisibleNodes: () => VisibleNode[];
  getFocusBreadcrumb: () => Array<{ id: string; text: string }>;

  // Helpers
  getLeafNodes: () => Node[];
  getNodeBreadcrumb: (nodeId: NodeId) => string;
}

// ── WebSocket connection ───────────────────────────────────────

let wsClient: WsClient | null = null;

export function getWsClient(): WsClient | null {
  return wsClient;
}

// ── Store implementation ───────────────────────────────────────

export const useMindmapStore = create<MindmapState>((set, get) => ({
  user: null,
  token: api.getToken(),
  maps: [],
  currentMapId: null,
  currentMap: null,
  nodes: {},
  rootNodeId: null,
  selectedNodeIds: [],
  selectedNodeId: null,
  editingNodeId: null,
  computed: new Map(),
  layoutType: 'tree-lr' as const,
  focusNodeId: null,
  focusHistory: [],
  maxDepth: 1,
  cycles: [],
  activeCycleFilter: null,
  versions: [],
  activeVersionFilter: null,
  activeView: 'mindmap',
  loading: false,
  error: null,
  wsConnected: false,
  presence: {},
  followingUserId: null,

  // ── Auth actions ──────────────────────────────────────────────

  login: async (email: string, password: string) => {
    set({ loading: true, error: null });
    try {
      const res = await api.login(email, password);
      api.setToken(res.token);
      set({ user: res.user, token: res.token, loading: false });
    } catch (e: any) {
      set({ loading: false, error: e.message ?? 'Login failed' });
      throw e;
    }
  },

  register: async (email: string, password: string, name: string) => {
    set({ loading: true, error: null });
    try {
      const res = await api.register(email, password, name);
      api.setToken(res.token);
      set({ user: res.user, token: res.token, loading: false });
    } catch (e: any) {
      set({ loading: false, error: e.message ?? 'Registration failed' });
      throw e;
    }
  },

  logout: () => {
    api.clearToken();
    if (wsClient) {
      wsClient.close();
      wsClient = null;
    }
    set({
      user: null,
      token: null,
      maps: [],
      currentMapId: null,
      currentMap: null,
      nodes: {},
      rootNodeId: null,
      selectedNodeIds: [],
      selectedNodeId: null,
      editingNodeId: null,
      computed: new Map(),
      wsConnected: false,
      error: null,
      presence: {},
      followingUserId: null,
    });
  },

  checkAuth: async () => {
    const token = api.getToken();
    if (!token) {
      set({ user: null, token: null });
      return;
    }
    try {
      const user = await api.getMe();
      set({ user, token });
    } catch {
      api.clearToken();
      set({ user: null, token: null });
    }
  },

  // ── Map actions ──────────────────────────────────────────────

  loadMaps: async () => {
    set({ loading: true, error: null });
    try {
      const maps = await api.fetchMaps();
      set({ maps, loading: false });
    } catch (e: any) {
      set({ loading: false, error: e.message ?? 'Failed to load maps' });
    }
  },

  loadMap: async (id: string) => {
    set({ loading: true, error: null });

    // Disconnect previous WebSocket
    if (wsClient) {
      wsClient.close();
      wsClient = null;
    }

    try {
      const data = await api.fetchMap(id);
      const nodesMap: Record<string, Node> = {};
      for (const n of data.nodes) {
        nodesMap[n.id] = n;
      }

      set({
        currentMapId: id,
        currentMap: data.map,
        nodes: nodesMap,
        rootNodeId: data.map.rootNodeId,
        selectedNodeIds: [],
        selectedNodeId: null,
        editingNodeId: null,
        computed: recomputeValues(nodesMap),
        focusNodeId: null,
        focusHistory: [],
        maxDepth: 1,
        loading: false,
        error: null,
        presence: {},
        followingUserId: null,
      });

      // Connect WebSocket
      wsClient = connectWs(
        id,
        (msg: any) => handleWsMessage(msg, set, get),
        (connected) => set({ wsConnected: connected }),
      );
    } catch (e: any) {
      set({ loading: false, error: e.message ?? 'Failed to load map' });
    }
  },

  createMap: async (name: string) => {
    set({ loading: true, error: null });
    try {
      const map = await api.createMap(name);
      // Reload maps list
      const maps = await api.fetchMaps();
      set({ maps, loading: false });
      // Open the new map
      get().loadMap(map.id);
    } catch (e: any) {
      set({ loading: false, error: e.message ?? 'Failed to create map' });
    }
  },

  closeMap: () => {
    if (wsClient) {
      wsClient.close();
      wsClient = null;
    }
    set({
      currentMapId: null,
      currentMap: null,
      nodes: {},
      rootNodeId: null,
      selectedNodeIds: [],
      selectedNodeId: null,
      editingNodeId: null,
      computed: new Map(),
      focusNodeId: null,
      focusHistory: [],
      maxDepth: 1,
      versions: [],
      activeVersionFilter: null,
      wsConnected: false,
      presence: {},
      followingUserId: null,
    });
  },

  updateMapName: (name: string) => {
    const state = get();
    if (!state.currentMapId || !state.currentMap) return;

    // Optimistic update
    set({ currentMap: { ...state.currentMap, name } });

    api.updateMap(state.currentMapId, { name }).catch(() => {
      // Revert on error
      set({ currentMap: state.currentMap });
    });
  },

  // ── Cycle / sprint actions ────────────────────────────────────

  loadCycles: async () => {
    const state = get();
    const mapId = state.currentMapId;
    if (!mapId) {
      set({ cycles: [] });
      return;
    }
    try {
      const cycles = await api.fetchCycles(mapId);
      set({ cycles });
    } catch (e: any) {
      set({ error: e.message ?? 'Failed to load cycles' });
    }
  },

  createCycle: async (name, startDate, endDate) => {
    const state = get();
    const mapId = state.currentMapId;
    if (!mapId) return;
    try {
      const cycle = await api.createCycle(mapId, name, startDate, endDate);
      set({ cycles: [...state.cycles, cycle] });
    } catch (e: any) {
      set({ error: e.message ?? 'Failed to create cycle' });
    }
  },

  updateCycle: async (id, fields) => {
    const state = get();
    const prev = state.cycles;
    // Optimistic update
    set({
      cycles: state.cycles.map((c) => (c.id === id ? { ...c, ...fields } : c)),
    });
    try {
      const updated = await api.updateCycle(id, fields);
      set({
        cycles: get().cycles.map((c) => (c.id === id ? updated : c)),
      });
    } catch (e: any) {
      set({ cycles: prev, error: e.message ?? 'Failed to update cycle' });
    }
  },

  deleteCycle: async (id) => {
    const state = get();
    const prev = state.cycles;
    set({ cycles: state.cycles.filter((c) => c.id !== id) });
    if (state.activeCycleFilter === id) {
      set({ activeCycleFilter: null });
    }
    try {
      await api.deleteCycle(id);
    } catch (e: any) {
      set({ cycles: prev, error: e.message ?? 'Failed to delete cycle' });
    }
  },

  assignNodeToCycle: async (nodeId, cycleId) => {
    const state = get();
    const node = state.nodes[nodeId];
    if (!node) return;
    const prevCycleId = node.cycleId;

    // Optimistic update
    const updatedNodes = {
      ...state.nodes,
      [nodeId]: { ...node, cycleId, updatedAt: new Date().toISOString() },
    };
    set({ nodes: updatedNodes });

    try {
      await api.assignNodeToCycle(cycleId, nodeId);
    } catch (e: any) {
      // Revert
      const revertNodes = {
        ...get().nodes,
        [nodeId]: { ...get().nodes[nodeId], cycleId: prevCycleId },
      };
      set({ nodes: revertNodes, error: e.message ?? 'Failed to assign node to cycle' });
    }
  },

  unassignNodeFromCycle: async (nodeId, cycleId) => {
    const state = get();
    const node = state.nodes[nodeId];
    if (!node) return;

    // Optimistic update
    const updatedNodes = {
      ...state.nodes,
      [nodeId]: { ...node, cycleId: null, updatedAt: new Date().toISOString() },
    };
    set({ nodes: updatedNodes });

    try {
      await api.unassignNodeFromCycle(cycleId, nodeId);
    } catch (e: any) {
      // Revert
      const revertNodes = {
        ...get().nodes,
        [nodeId]: { ...get().nodes[nodeId], cycleId },
      };
      set({ nodes: revertNodes, error: e.message ?? 'Failed to unassign node from cycle' });
    }
  },

  setActiveCycleFilter: (cycleId) => set({ activeCycleFilter: cycleId }),

  // ── Version actions ──────────────────────────────────────────

  loadVersions: async () => {
    const state = get();
    const mapId = state.currentMapId;
    if (!mapId) {
      set({ versions: [] });
      return;
    }
    try {
      const versions = await api.fetchVersions(mapId);
      set({ versions });
    } catch (e: any) {
      set({ error: e.message ?? 'Failed to load versions' });
    }
  },

  createVersion: async (fields) => {
    const state = get();
    const mapId = state.currentMapId;
    if (!mapId) return null;
    try {
      const created = await api.createVersion(mapId, fields);
      set({ versions: [...state.versions, created] });
      return created;
    } catch (e: any) {
      set({ error: e.message ?? 'Failed to create version' });
      return null;
    }
  },

  updateVersion: async (id, fields) => {
    const state = get();
    const prev = state.versions;
    set({
      versions: state.versions.map((v) => (v.id === id ? { ...v, ...fields } as Version : v)),
    });
    try {
      const updated = await api.updateVersion(id, fields);
      set({
        versions: get().versions.map((v) => (v.id === id ? updated : v)),
      });
    } catch (e: any) {
      set({ versions: prev, error: e.message ?? 'Failed to update version' });
    }
  },

  deleteVersion: async (id) => {
    const state = get();
    const prev = state.versions;
    set({ versions: state.versions.filter((v) => v.id !== id) });
    if (state.activeVersionFilter === id) {
      set({ activeVersionFilter: null });
    }
    try {
      await api.deleteVersion(id);
    } catch (e: any) {
      set({ versions: prev, error: e.message ?? 'Failed to delete version' });
    }
  },

  setActiveVersionFilter: (versionId) => set({ activeVersionFilter: versionId }),

  // ── View actions ─────────────────────────────────────────────

  setActiveView: (view) => set({ activeView: view }),

  // ── Drill-down actions ──────────────────────────────────────

  setFocusNode: (nodeId) => {
    const state = get();
    // Validate node exists (or null for root)
    if (nodeId !== null && !state.nodes[nodeId]) return;
    if (nodeId === state.focusNodeId) return;
    const history = state.focusHistory.concat(state.focusNodeId);
    // Cap history to avoid unbounded growth
    const trimmed = history.length > 50 ? history.slice(-50) : history;
    set({ focusNodeId: nodeId, focusHistory: trimmed });
  },

  popFocusHistory: () => {
    const { focusHistory, nodes } = get();
    if (focusHistory.length === 0) return;
    const next = focusHistory[focusHistory.length - 1];
    const newHistory = focusHistory.slice(0, -1);
    // If the historical node no longer exists, skip it
    if (next !== null && !nodes[next]) {
      set({ focusHistory: newHistory });
      get().popFocusHistory();
      return;
    }
    set({ focusNodeId: next, focusHistory: newHistory });
  },

  setMaxDepth: (depth) => set({ maxDepth: depth }),

  setFollowingUser: (userId) => set({ followingUserId: userId }),

  getVisibleNodes: () => {
    const { nodes, rootNodeId, focusNodeId, maxDepth, activeVersionFilter, activeCycleFilter } = get();
    if (!rootNodeId) return [];

    const effectiveRootId = focusNodeId ?? rootNodeId;
    const effectiveRoot = nodes[effectiveRootId];
    if (!effectiveRoot) return [];

    // Build the visible set for the active version + sprint filters.
    //
    // Semantic: a node is "in scope" if its effective version/cycle matches
    // every active filter, where "effective" means the node's own tag OR
    // the nearest tagged ancestor. This lets users tag an epic/branch with
    // a sprint and see the entire subtree under it, while still supporting
    // leaf-level tags for fine-grained work items.
    //
    // We also include ancestors of in-scope nodes so the mindmap stays a
    // connected tree even when scope nodes are deep.
    let filterMatchIds: Set<string> | null = null;
    if (activeVersionFilter || activeCycleFilter) {
      const directMatches = new Set<string>();

      // DFS from the real root, propagating inherited tags downward.
      // We walk from rootNodeId (not effectiveRootId) so inheritance picks
      // up tags on nodes above the current drill-down focus.
      function inheritDfs(
        nodeId: string,
        inheritedVersion: string | null,
        inheritedCycle: string | null,
      ) {
        const node = nodes[nodeId];
        if (!node) return;
        const effVersion = node.versionId ?? inheritedVersion;
        const effCycle = node.cycleId ?? inheritedCycle;
        const matchesVersion = !activeVersionFilter || effVersion === activeVersionFilter;
        const matchesCycle = !activeCycleFilter || effCycle === activeCycleFilter;
        if (matchesVersion && matchesCycle) {
          directMatches.add(nodeId);
        }
        for (const childId of node.childrenIds) {
          inheritDfs(childId, effVersion, effCycle);
        }
      }
      inheritDfs(rootNodeId, null, null);

      // Expand with ancestors of every in-scope node so the tree stays
      // connected back to the root.
      filterMatchIds = new Set<string>();
      for (const id of directMatches) {
        let cur: Node | undefined = nodes[id];
        while (cur && !filterMatchIds.has(cur.id)) {
          filterMatchIds.add(cur.id);
          cur = cur.parentId ? nodes[cur.parentId] : undefined;
        }
      }
    }

    const result: VisibleNode[] = [];

    // Count all descendants of a node
    function countDescendants(nodeId: string): number {
      const node = nodes[nodeId];
      if (!node) return 0;
      let count = 0;
      for (const childId of node.childrenIds) {
        if (filterMatchIds && !filterMatchIds.has(childId)) continue;
        count += 1 + countDescendants(childId);
      }
      return count;
    }

    // BFS/DFS from the focus node with depth tracking
    function walk(nodeId: string, depth: number) {
      const node = nodes[nodeId];
      if (!node) return;

      // Skip nodes not in the active filter set
      if (filterMatchIds && !filterMatchIds.has(nodeId)) return;

      const visibleChildren = filterMatchIds
        ? node.childrenIds.filter((id) => filterMatchIds!.has(id))
        : node.childrenIds;
      const atMaxDepth = maxDepth > 0 && depth >= maxDepth;
      const hasChildren = visibleChildren.length > 0;
      const hasHiddenChildren = atMaxDepth && hasChildren;
      const hiddenDescendantCount = hasHiddenChildren ? countDescendants(nodeId) : 0;

      result.push({
        node,
        depth,
        hasHiddenChildren,
        hiddenDescendantCount,
        isDimmed: false,
      });

      // Don't recurse past maxDepth (0 = unlimited)
      if (!atMaxDepth && !node.collapsed) {
        for (const childId of visibleChildren) {
          walk(childId, depth + 1);
        }
      }
    }

    walk(effectiveRootId, 0);

    // If we have a focus node (not the actual root), add dimmed siblings for context
    if (focusNodeId && focusNodeId !== rootNodeId) {
      const focusNode = nodes[focusNodeId];
      if (focusNode?.parentId) {
        const parent = nodes[focusNode.parentId];
        if (parent) {
          for (const siblingId of parent.childrenIds) {
            if (siblingId === focusNodeId) continue;
            const sibling = nodes[siblingId];
            if (!sibling) continue;
            result.push({
              node: sibling,
              depth: 0, // same level as focus node
              hasHiddenChildren: sibling.childrenIds.length > 0,
              hiddenDescendantCount: countDescendants(siblingId),
              isDimmed: true,
            });
          }
        }
      }
    }

    return result;
  },

  getFocusBreadcrumb: () => {
    const { nodes, rootNodeId, focusNodeId } = get();
    if (!rootNodeId) return [];

    const crumbs: Array<{ id: string; text: string }> = [];
    let currentId = focusNodeId;

    // Walk up from focusNode to root
    while (currentId) {
      const node = nodes[currentId];
      if (!node) break;
      crumbs.unshift({ id: node.id, text: node.text });
      if (node.id === rootNodeId) break;
      currentId = node.parentId;
    }

    // If we didn't reach the root, prepend it
    if (crumbs.length === 0 || crumbs[0].id !== rootNodeId) {
      const root = nodes[rootNodeId];
      if (root) {
        crumbs.unshift({ id: root.id, text: root.text });
      }
    }

    return crumbs;
  },

  // ── Helpers ─────────────────────────────────────────────────

  getLeafNodes: () => {
    const { nodes } = get();
    return Object.values(nodes).filter((n) => n.childrenIds.length === 0);
  },

  getNodeBreadcrumb: (nodeId: NodeId) => {
    const { nodes } = get();
    const parts: string[] = [];
    let current = nodes[nodeId];
    // Walk up parents (skip the node itself and the root)
    while (current?.parentId) {
      const parent = nodes[current.parentId];
      if (!parent) break;
      if (parent.parentId !== null) {
        // Skip root node from breadcrumb
        parts.unshift(parent.text);
      }
      current = parent;
    }
    return parts.join(' > ');
  },

  // ── Node actions ─────────────────────────────────────────────

  // ── Layout actions ────────────────────────────────────────────

  setLayoutType: (layout) => set({ layoutType: layout }),

  // ── Selection actions ───────────────────────────────────────

  selectNode: (id) => set({
    selectedNodeIds: id ? [id] : [],
    selectedNodeId: id,
    editingNodeId: null,
  }),

  toggleSelectNode: (id) => {
    const state = get();
    const ids = state.selectedNodeIds.includes(id)
      ? state.selectedNodeIds.filter((i) => i !== id)
      : [...state.selectedNodeIds, id];
    set({ selectedNodeIds: ids, selectedNodeId: ids[0] ?? null, editingNodeId: null });
  },

  selectAllNodes: () => {
    const state = get();
    const allIds = Object.keys(state.nodes);
    set({ selectedNodeIds: allIds, selectedNodeId: allIds[0] ?? null });
  },

  clearSelection: () => set({ selectedNodeIds: [], selectedNodeId: null, editingNodeId: null }),

  startEditing: (id) => set({ editingNodeId: id }),

  addNode: (parentId, text = 'New node', asSibling = false, position, fields) => {
    const state = get();
    const mapId = state.currentMapId;
    let targetParentId = parentId;
    let insertIndex = -1;

    if (asSibling) {
      const parentNode = state.nodes[parentId];
      if (parentNode?.parentId) {
        const grandparent = state.nodes[parentNode.parentId];
        if (grandparent) {
          targetParentId = grandparent.id;
          insertIndex = grandparent.childrenIds.indexOf(parentId) + 1;
        }
      } else {
        targetParentId = parentId;
      }
    }

    // Generate a temporary ID for optimistic update
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const newNode: Node = {
      id: tempId,
      mapId: mapId ?? '',
      parentId: targetParentId,
      childrenIds: [],
      text,
      description: null,
      x: position?.x ?? null,
      y: position?.y ?? null,
      collapsed: false,
      effortEstimate: null,
      actualEffort: null,
      percentComplete: null,
      status: null,
      blockedReason: null,
      assigneeIds: [],
      priority: null,
      dueDate: null,
      startDate: null,
      tags: [],
      customFields: {},
      dependencies: [],
      versionId: null,
      cycleId: null,
      externalLinks: [],
      autoProgress: 'off',
      priorityRank: null,
    completedAt: null,
      requirementId: null,
      requirementPriority: null,
      // Orchestration substrate (#111)
      claimedBySession: null,
      claimedAt: null,
      scopes: [],
      createdAt: now,
      updatedAt: now,
      createdBy: state.user?.id ?? 'user-001',
      revision: 1,
      deletedAt: null,
      ...(fields ?? {}),
    };

    // Optimistic local update
    const updatedNodes = { ...state.nodes };
    const parent = { ...updatedNodes[targetParentId] };
    const newChildren = [...parent.childrenIds];
    if (insertIndex >= 0 && insertIndex < newChildren.length) {
      newChildren.splice(insertIndex, 0, tempId);
    } else {
      newChildren.push(tempId);
      insertIndex = newChildren.length - 1;
    }
    parent.childrenIds = newChildren;
    updatedNodes[targetParentId] = parent;
    updatedNodes[tempId] = newNode;

    set({
      nodes: updatedNodes,
      selectedNodeIds: [tempId],
      selectedNodeId: tempId,
      editingNodeId: tempId,
      computed: recomputeValues(updatedNodes),
    });

    // Sync to API
    if (mapId) {
      api.createNode(mapId, targetParentId, text, insertIndex >= 0 ? insertIndex : undefined, position, fields)
        .then((serverNode) => {
          // Replace temp node with server node
          const current = get();
          const nodes = { ...current.nodes };

          // Remove temp node
          delete nodes[tempId];
          nodes[serverNode.id] = serverNode;

          // Update parent's childrenIds to swap temp -> real id, deduplicating
          const p = nodes[targetParentId];
          if (p) {
            const swapped = p.childrenIds.map((cid) => (cid === tempId ? serverNode.id : cid));
            nodes[targetParentId] = {
              ...p,
              childrenIds: [...new Set(swapped)],
            };
          }

          const newState: Partial<MindmapState> = {
            nodes,
            computed: recomputeValues(nodes),
          };

          // Update selection if still pointing to temp
          if (current.selectedNodeId === tempId) {
            newState.selectedNodeIds = current.selectedNodeIds.map((i) => i === tempId ? serverNode.id : i);
            newState.selectedNodeId = serverNode.id;
          }
          if (current.editingNodeId === tempId) {
            newState.editingNodeId = serverNode.id;
          }

          set(newState);
        })
        .catch(() => {
          // Revert optimistic update
          const current = get();
          const nodes = { ...current.nodes };
          delete nodes[tempId];
          const p = nodes[targetParentId];
          if (p) {
            nodes[targetParentId] = {
              ...p,
              childrenIds: p.childrenIds.filter((cid) => cid !== tempId),
            };
          }
          set({
            nodes,
            selectedNodeIds: [targetParentId],
            selectedNodeId: targetParentId,
            editingNodeId: null,
            computed: recomputeValues(nodes),
            error: 'Failed to create node',
          });
        });
    }

    return tempId;
  },

  updateNode: (id, updates) => {
    const state = get();
    const node = state.nodes[id];
    if (!node) return;

    const prevNode = node;
    const updatedNode = { ...node, ...updates, updatedAt: new Date().toISOString() };
    const updatedNodes = { ...state.nodes, [id]: updatedNode };

    // Optimistic update
    set({
      nodes: updatedNodes,
      computed: recomputeValues(updatedNodes),
    });

    // Sync to API (skip for temp nodes)
    if (state.currentMapId && !id.startsWith('temp-')) {
      api
        .updateNode(state.currentMapId, id, updates, prevNode.revision)
        .catch((err: unknown) => {
          const current = get();
          // 409 → someone else wrote first. Server returned their current
          // state in error.details.current; replace ours with that and tell
          // the user we discarded their edit so they can retry.
          if (err instanceof api.ApiError && err.code === 'REVISION_CONFLICT') {
            const serverNode = (err.details?.current as Node | undefined) ?? null;
            if (serverNode) {
              const nodes = { ...current.nodes, [id]: serverNode };
              set({
                nodes,
                computed: recomputeValues(nodes),
                error: 'Someone else changed this node — your edit was discarded.',
              });
              return;
            }
          }
          // Other failures — revert to the pre-edit local state.
          const nodes = { ...current.nodes, [id]: prevNode };
          set({ nodes, computed: recomputeValues(nodes), error: 'Failed to update node' });
        });
    }
  },

  deleteNode: (id) => {
    const state = get();
    if (id === state.rootNodeId) return;

    const node = state.nodes[id];
    if (!node || !node.parentId) return;

    // Collect all descendants for snapshot (revert)
    const snapshot = { ...state.nodes };

    // Collect descendants
    const toDelete = new Set<string>();
    const queue = [id];
    while (queue.length > 0) {
      const current = queue.shift()!;
      toDelete.add(current);
      const n = state.nodes[current];
      if (n) queue.push(...n.childrenIds);
    }

    const updatedNodes = { ...state.nodes };
    const parent = { ...updatedNodes[node.parentId] };
    parent.childrenIds = parent.childrenIds.filter((cid) => cid !== id);
    updatedNodes[node.parentId] = parent;

    for (const did of toDelete) {
      delete updatedNodes[did];
    }

    // Find next selection
    let nextSelection: string | null = node.parentId;
    const siblingIdx = state.nodes[node.parentId]?.childrenIds.indexOf(id) ?? -1;
    const siblings = parent.childrenIds;
    if (siblings.length > 0) {
      nextSelection = siblings[Math.min(siblingIdx, siblings.length - 1)];
    }

    // Optimistic update
    set({
      nodes: updatedNodes,
      selectedNodeIds: nextSelection ? [nextSelection] : [],
      selectedNodeId: nextSelection,
      editingNodeId: null,
      computed: recomputeValues(updatedNodes),
    });

    // Sync to API (skip for temp nodes)
    if (state.currentMapId && !id.startsWith('temp-')) {
      api.deleteNode(state.currentMapId, id).catch(() => {
        set({
          nodes: snapshot,
          computed: recomputeValues(snapshot),
          error: 'Failed to delete node',
        });
      });
    }
  },

  // ── Soft-delete / Trash (#107) ──────────────────────────────
  listDeletedNodes: async (sinceDays) => {
    const state = get();
    if (!state.currentMapId) return [];
    const res = await api.listDeleted(state.currentMapId, { sinceDays });
    return res.deleted;
  },

  restoreNode: async (nodeId, opts) => {
    const state = get();
    if (!state.currentMapId) return;
    await api.restoreNode(state.currentMapId, nodeId, opts);
    // The route broadcasts node:restored, which triggers a loadMap on this
    // tab. We also load eagerly so the caller (Trash modal) sees the result
    // without waiting for the round-trip WS echo.
    await get().loadMap(state.currentMapId);
  },

  moveNode: (nodeId, newParentId, index) => {
    const state = get();
    const node = state.nodes[nodeId];
    if (!node || !node.parentId) return;

    const snapshot = { ...state.nodes };

    // Optimistic update
    const updatedNodes = { ...state.nodes };

    // Remove from old parent
    const oldParent = { ...updatedNodes[node.parentId] };
    oldParent.childrenIds = oldParent.childrenIds.filter((cid) => cid !== nodeId);
    updatedNodes[node.parentId] = oldParent;

    // Add to new parent
    const newParent = { ...updatedNodes[newParentId] };
    const newChildren = [...newParent.childrenIds];
    newChildren.splice(index, 0, nodeId);
    newParent.childrenIds = newChildren;
    updatedNodes[newParentId] = newParent;

    // Update node's parentId
    updatedNodes[nodeId] = { ...node, parentId: newParentId };

    set({
      nodes: updatedNodes,
      computed: recomputeValues(updatedNodes),
    });

    if (state.currentMapId && !nodeId.startsWith('temp-')) {
      api.moveNode(state.currentMapId, nodeId, newParentId, index).catch(() => {
        set({
          nodes: snapshot,
          computed: recomputeValues(snapshot),
          error: 'Failed to move node',
        });
      });
    }
  },

  reorderChildren: (parentId, childrenIds) => {
    const state = get();
    const parent = state.nodes[parentId];
    if (!parent) return;

    const snapshot = { ...state.nodes };
    const updatedNodes = { ...state.nodes };
    updatedNodes[parentId] = { ...parent, childrenIds: [...childrenIds] };

    set({
      nodes: updatedNodes,
      computed: recomputeValues(updatedNodes),
    });

    if (state.currentMapId && !parentId.startsWith('temp-')) {
      api.reorderChildren(state.currentMapId, parentId, childrenIds).catch(() => {
        set({
          nodes: snapshot,
          computed: recomputeValues(snapshot),
          error: 'Failed to reorder children',
        });
      });
    }
  },

  toggleCollapse: (id) => {
    const state = get();
    const node = state.nodes[id];
    if (!node || node.childrenIds.length === 0) return;

    const updatedNode = { ...node, collapsed: !node.collapsed };
    set({
      nodes: { ...state.nodes, [id]: updatedNode },
    });
  },

  expandAll: () => {
    const state = get();
    const updatedNodes = { ...state.nodes };
    for (const [id, node] of Object.entries(updatedNodes)) {
      if (node.collapsed && node.childrenIds.length > 0) {
        updatedNodes[id] = { ...node, collapsed: false };
      }
    }
    set({ nodes: updatedNodes });
  },

  collapseAll: () => {
    const state = get();
    const updatedNodes = { ...state.nodes };
    for (const [id, node] of Object.entries(updatedNodes)) {
      if (!node.collapsed && node.childrenIds.length > 0 && id !== state.rootNodeId) {
        updatedNodes[id] = { ...node, collapsed: true };
      }
    }
    set({ nodes: updatedNodes });
  },

  recompute: () => {
    const state = get();
    set({ computed: recomputeValues(state.nodes) });
  },
}));

// ── WebSocket message handler ──────────────────────────────────

function handleWsMessage(
  msg: any,
  set: (partial: Partial<MindmapState> | ((state: MindmapState) => Partial<MindmapState>)) => void,
  get: () => MindmapState,
) {
  // Dispatch cursor events to window for CursorPresence component
  if (msg.type === 'cursor') {
    window.dispatchEvent(new CustomEvent('ws:cursor', { detail: msg }));
    return;
  }

  // Dispatch comment events to window for CommentsPanel component
  if (msg.type?.startsWith('comment:')) {
    window.dispatchEvent(new CustomEvent('ws:comment', { detail: msg }));
    return;
  }

  // Phase 3 follow-up (#102 item 7): dispatch triage events to window
  // for the TriagePanel component. Triage mutations on the server
  // (confirm/override/reclassify single + bulk) broadcast
  // `triage:updated`; the panel listens and refreshes its data without
  // a poll. Mirrors the `ws:comment` pattern above.
  if (msg.type === 'triage:updated') {
    window.dispatchEvent(new CustomEvent('ws:triage', { detail: msg }));
    return;
  }

  // Viewport / focus presence (follow mode)
  if (msg.type === 'presence:viewport' && msg.userId) {
    const cur = get().presence;
    set({
      presence: {
        ...cur,
        [msg.userId]: {
          userId: msg.userId,
          name: msg.name ?? 'User',
          cx: msg.cx,
          cy: msg.cy,
          zoom: msg.zoom,
          focusNodeId: msg.focusNodeId ?? null,
          lastSeen: Date.now(),
        },
      },
    });
    return;
  }

  // Track user join/leave for the presence list
  if (msg.type === 'user:leave' && msg.userId) {
    const cur = get();
    if (!(msg.userId in cur.presence) && cur.followingUserId !== msg.userId) return;
    const presence = { ...cur.presence };
    delete presence[msg.userId];
    set({
      presence,
      followingUserId: cur.followingUserId === msg.userId ? null : cur.followingUserId,
    });
    return;
  }

  if (msg.type === 'user:join') {
    // Just a hint that someone joined; we'll start tracking them once
    // they emit their first presence:viewport. Nothing to do here yet.
    return;
  }

  const state = get();

  switch (msg.type) {
    case 'node:created': {
      const serverNode = msg.node as Node;
      // Don't duplicate if we already have it (from our own optimistic update)
      if (state.nodes[serverNode.id]) return;

      // Skip if we have a pending temp node for this parent (our API callback will handle it)
      if (serverNode.parentId) {
        const parent = state.nodes[serverNode.parentId];
        if (parent?.childrenIds.some((cid) => cid.startsWith('temp-'))) return;
      }

      const nodes = { ...state.nodes };
      nodes[serverNode.id] = serverNode;

      // Add to parent's children if not already there
      if (serverNode.parentId && nodes[serverNode.parentId]) {
        const parent = { ...nodes[serverNode.parentId] };
        if (!parent.childrenIds.includes(serverNode.id)) {
          parent.childrenIds = [...parent.childrenIds, serverNode.id];
          nodes[serverNode.parentId] = parent;
        }
      }

      set({ nodes, computed: recomputeValues(nodes) });
      break;
    }

    case 'node:updated': {
      const serverNode = msg.node as Node;
      if (!state.nodes[serverNode.id]) return;

      const nodes = { ...state.nodes, [serverNode.id]: serverNode };
      set({ nodes, computed: recomputeValues(nodes) });
      break;
    }

    case 'node:deleted': {
      const deletedIds = msg.deletedIds as string[];
      const nodes = { ...state.nodes };

      // Remove from parent
      const nodeToDelete = state.nodes[msg.nodeId];
      if (nodeToDelete?.parentId && nodes[nodeToDelete.parentId]) {
        const parent = { ...nodes[nodeToDelete.parentId] };
        parent.childrenIds = parent.childrenIds.filter((cid) => !deletedIds.includes(cid));
        nodes[nodeToDelete.parentId] = parent;
      }

      for (const did of deletedIds) {
        delete nodes[did];
      }

      const newState: Partial<MindmapState> = { nodes, computed: recomputeValues(nodes) };

      // Clear selection if it was deleted
      const remainingSelected = state.selectedNodeIds.filter((id) => !deletedIds.includes(id));
      if (remainingSelected.length !== state.selectedNodeIds.length) {
        newState.selectedNodeIds = remainingSelected;
        newState.selectedNodeId = remainingSelected[0] ?? null;
        newState.editingNodeId = null;
      }

      set(newState);
      break;
    }

    case 'node:moved': {
      // Reload map to get fresh state (moves are complex)
      get().loadMap(state.currentMapId!);
      break;
    }

    case 'node:restored': {
      // A restore re-introduces nodes that aren't in our local state and
      // re-splices the root into its parent's children_order. Easiest +
      // correct reaction is a full reload — restore is rare and the round
      // trip is small relative to the alternative of replaying the splice.
      if (state.currentMapId) {
        get().loadMap(state.currentMapId);
      }
      break;
    }

    case 'node:reordered': {
      const { parentId, childrenIds } = msg as { parentId: string; childrenIds: string[] };
      if (!state.nodes[parentId]) return;

      const nodes = { ...state.nodes };
      nodes[parentId] = { ...nodes[parentId], childrenIds };
      set({ nodes, computed: recomputeValues(nodes) });
      break;
    }
  }
}
