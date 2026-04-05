import { create } from 'zustand';
import type { Node, NodeId, ComputedNodeValues, MindMap, Cycle } from '@mindblown/core';
import { computeTree } from '@mindblown/core';
import * as api from './api.js';
import type { MapSummary } from './api.js';
import { connectWs } from './ws.js';
import type { WsClient } from './ws.js';

// ── Helpers ────────────────────────────────────────────────────

function recomputeValues(nodes: Record<string, Node>): Map<NodeId, ComputedNodeValues> {
  const arr = Object.values(nodes);
  if (arr.length === 0) return new Map();
  return computeTree(arr);
}

// ── Store types ────────────────────────────────────────────────

export type ActiveView = 'mindmap' | 'kanban' | 'gantt' | 'list';

export interface MindmapState {
  // Map list
  maps: MapSummary[];
  currentMapId: string | null;
  currentMap: MindMap | null;

  // Node state
  nodes: Record<string, Node>;
  rootNodeId: string | null;
  selectedNodeId: string | null;
  editingNodeId: string | null;
  computed: Map<NodeId, ComputedNodeValues>;

  // Cycle / sprint state
  cycles: Cycle[];
  activeCycleFilter: string | null;

  // UI state
  activeView: ActiveView;
  loading: boolean;
  error: string | null;
  wsConnected: boolean;

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

  // Actions — node level
  selectNode: (id: string | null) => void;
  startEditing: (id: string | null) => void;
  addNode: (parentId: string, text?: string, asSibling?: boolean) => string;
  updateNode: (id: string, updates: Partial<Node>) => void;
  deleteNode: (id: string) => void;
  moveNode: (nodeId: string, newParentId: string, index: number) => void;
  toggleCollapse: (id: string) => void;
  recompute: () => void;

  // Helpers
  getLeafNodes: () => Node[];
  getNodeBreadcrumb: (nodeId: NodeId) => string;
}

// ── WebSocket connection ───────────────────────────────────────

let wsClient: WsClient | null = null;

// ── Store implementation ───────────────────────────────────────

export const useMindmapStore = create<MindmapState>((set, get) => ({
  maps: [],
  currentMapId: null,
  currentMap: null,
  nodes: {},
  rootNodeId: null,
  selectedNodeId: null,
  editingNodeId: null,
  computed: new Map(),
  cycles: [],
  activeCycleFilter: null,
  activeView: 'mindmap',
  loading: false,
  error: null,
  wsConnected: false,

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
        selectedNodeId: null,
        editingNodeId: null,
        computed: recomputeValues(nodesMap),
        loading: false,
        error: null,
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
      selectedNodeId: null,
      editingNodeId: null,
      computed: new Map(),
      wsConnected: false,
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
    const workspaceId = state.currentMap?.workspaceId ?? 'default';
    try {
      const cycles = await api.fetchCycles(workspaceId);
      set({ cycles });
    } catch (e: any) {
      set({ error: e.message ?? 'Failed to load cycles' });
    }
  },

  createCycle: async (name, startDate, endDate) => {
    const state = get();
    const workspaceId = state.currentMap?.workspaceId ?? 'default';
    try {
      const cycle = await api.createCycle(workspaceId, name, startDate, endDate);
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

  // ── View actions ─────────────────────────────────────────────

  setActiveView: (view) => set({ activeView: view }),

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

  selectNode: (id) => set({ selectedNodeId: id, editingNodeId: null }),

  startEditing: (id) => set({ editingNodeId: id }),

  addNode: (parentId, text = 'New node', asSibling = false) => {
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
      x: null,
      y: null,
      collapsed: false,
      effortEstimate: null,
      percentComplete: null,
      status: null,
      assigneeIds: [],
      priority: null,
      dueDate: null,
      startDate: null,
      tags: [],
      customFields: {},
      dependencies: [],
      isMilestone: false,
      cycleId: null,
      externalLinks: [],
      createdAt: now,
      updatedAt: now,
      createdBy: 'user-001',
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
      selectedNodeId: tempId,
      editingNodeId: tempId,
      computed: recomputeValues(updatedNodes),
    });

    // Sync to API
    if (mapId) {
      api.createNode(mapId, targetParentId, text, insertIndex >= 0 ? insertIndex : undefined)
        .then((serverNode) => {
          // Replace temp node with server node
          const current = get();
          const nodes = { ...current.nodes };

          // Remove temp node
          delete nodes[tempId];
          nodes[serverNode.id] = serverNode;

          // Update parent's childrenIds to swap temp -> real id
          const p = nodes[targetParentId];
          if (p) {
            nodes[targetParentId] = {
              ...p,
              childrenIds: p.childrenIds.map((cid) => (cid === tempId ? serverNode.id : cid)),
            };
          }

          const newState: Partial<MindmapState> = {
            nodes,
            computed: recomputeValues(nodes),
          };

          // Update selection if still pointing to temp
          if (current.selectedNodeId === tempId) {
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
      api.updateNode(state.currentMapId, id, updates).catch(() => {
        // Revert
        const current = get();
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

  toggleCollapse: (id) => {
    const state = get();
    const node = state.nodes[id];
    if (!node || node.childrenIds.length === 0) return;

    const updatedNode = { ...node, collapsed: !node.collapsed };
    set({
      nodes: { ...state.nodes, [id]: updatedNode },
    });
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
  const state = get();

  switch (msg.type) {
    case 'node:created': {
      const serverNode = msg.node as Node;
      // Don't duplicate if we already have it (from our own optimistic update)
      if (state.nodes[serverNode.id]) return;

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
      if (state.selectedNodeId && deletedIds.includes(state.selectedNodeId)) {
        newState.selectedNodeId = null;
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
