import { create } from 'zustand';
import type { Node, NodeId, ComputedNodeValues, MindMap, Cycle, Version } from '@mindblown/core';
import { computeTree } from '@mindblown/core';
import * as api from './api.js';
import type { MapSummary, AuthUser } from './api.js';
import { connectWs } from './ws.js';
import type { WsClient } from './ws.js';
import { collectScopeMatches, hasActiveScopeFilter } from './scopeFilter.js';
import { readStoredRole, writeStoredRole, reconcileView, defaultViewForRole } from './roles.js';
import type { ViewRole } from './roles.js';

// ── Helpers ────────────────────────────────────────────────────

/** Map fields a `map:updated` broadcast may overwrite locally (mirrors the
 *  server's AUDITED_MAP_FIELDS plus the timestamp). Deliberately NOT the
 *  whole row: the broadcast fires on every PUT (rename, phases, triage
 *  flags too), and those keep their pre-existing no-live-sync behaviour —
 *  merging them would revert optimistic edits such as an in-flight rename. */
const BROADCAST_MAP_SETTINGS = [
  'maxActiveClaims',
  'dispatchGate',
  'dispatchPolicy',
  'profilePolicy',
  'wipLimit',
  'focusFactor',
  'workerCount',
  'updatedAt',
] as const satisfies readonly (keyof MindMap)[];

function recomputeValues(nodes: Record<string, Node>): Map<NodeId, ComputedNodeValues> {
  const arr = Object.values(nodes);
  if (arr.length === 0) return new Map();
  return computeTree(arr);
}

// ── Store types ────────────────────────────────────────────────

export type ActiveView =
  | 'mindmap'
  | 'kanban'
  | 'gantt'
  | 'list'
  | 'calendar'
  | 'hill'
  | 'workload'
  | 'releases'
  | 'requirements'
  | 'guide'
  | 'digest'
  | 'cockpit'
  | 'fleet'
  | 'asks';

export interface VisibleNode {
  node: Node;
  depth: number; // depth relative to focusNode (0 = focusNode itself)
  hasHiddenChildren: boolean;
  hiddenDescendantCount: number;
  isDimmed: boolean; // true for sibling branches shown for context
}

/**
 * Options for getVisibleNodes(). All default to true (full drill-down
 * semantics — what the tree-shaped views want). Aggregate views (Hill
 * Chart, Workload) pass all three as false so ONLY the version/sprint
 * scope walk (incl. tag inheritance + ancestor connect) applies, and
 * drill-down focus, depth limit, and collapse state don't cut their
 * data basis.
 */
export interface VisibleNodesOptions {
  /** Walk from the drill-down focus node and append dimmed context siblings. */
  respectFocus?: boolean;
  /** Truncate the walk at the maxDepth level (0 = unlimited). */
  respectDepth?: boolean;
  /** Don't descend into collapsed nodes. */
  respectCollapsed?: boolean;
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
  maxDepth: number;

  // Cycle / sprint state
  cycles: Cycle[];
  activeCycleFilter: string | null;

  // Version state
  versions: Version[];
  activeVersionFilter: string | null;

  // Requirements register release filter (shareable via URL, hence store
  // state rather than component state). A version id, 'none' for "no
  // release assigned", or null for all releases.
  reqVersionFilter: string | null;
  /** cumulative = "through this release", exact = "only this release". */
  reqVersionMode: 'cumulative' | 'exact';

  // Phase state (PhaseDefs live on currentMap.phases; only the filter is store state)
  activePhaseFilter: string | null;

  // Workload attribution — who last touched each node (loaded on demand)
  nodeActors: Map<string, { userId: string; userName: string }>;
  nodeActorsMapId: string | null;

  // People who can be assigned work on this map (loaded on demand)
  members: api.MapMember[];
  membersMapId: string | null;

  // UI state
  activeView: ActiveView;
  loading: boolean;
  error: string | null;
  wsConnected: boolean;
  /** Bumped on every `fleet:updated` socket message — the Fleet card refetches on change. */
  fleetRev: number;
  /** Bumped on every `asks:updated` socket message — the Fragen tab refetches on change. */
  asksRev: number;

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
  /**
   * Write map settings (the Leidang dispatch knobs and friends) with an
   * optimistic local update; reverts on failure and returns false. Every
   * write moves the fleet within ~2 min, so callers apply explicitly, never
   * on-change.
   */
  updateMapSettings: (fields: Partial<Pick<MindMap, 'maxActiveClaims' | 'dispatchGate' | 'dispatchPolicy'>>) => Promise<boolean>;
  /**
   * Append a new phase (PhaseDef) to the current map's phases list and
   * persist via PUT /api/maps/:id. Returns the new phase's id (so callers
   * can immediately assign it to a node via updateNode phaseId), or null
   * when there is no current map / the name is blank. When a phase with
   * the same name already exists, returns that phase's id instead of
   * creating a duplicate.
   */
  createPhase: (name: string) => Promise<string | null>;

  // Actions — view
  setActiveView: (view: ActiveView) => void;
  /** Role lens (roles.ts): filters tabs/panels; never a permission. */
  viewRole: ViewRole;
  setViewRole: (role: ViewRole) => void;

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
  setReqVersionFilter: (versionId: string | null) => void;
  setReqVersionMode: (mode: 'cumulative' | 'exact') => void;

  // Actions — phase
  setActivePhaseFilter: (phaseId: string | null) => void;

  // Actions — workload attribution
  loadNodeActors: () => Promise<void>;

  // Actions — map members (assignee picker)
  loadMembers: () => Promise<void>;

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
  /**
   * Release a parked ticket back into the pull queue (server-side rule:
   * blockedReason null, `blocked` tag off, status → todo unless done).
   * Not optimistic — the server decides the status; the returned node is
   * applied. Resolves false on failure (error is set).
   */
  unblockNode: (id: string) => Promise<boolean>;
  /**
   * Replace a node with what the server just returned, without writing
   * back. For sub-resource endpoints (attachments, dependencies) that have
   * already persisted the change and answered with the whole node —
   * `updateNode` would POST it a second time, and with a stale revision.
   */
  applyServerNode: (node: Node) => void;
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
  setMaxDepth: (depth: number) => void;

  // Presence / follow mode actions
  setFollowingUser: (userId: string | null) => void;
  getVisibleNodes: (options?: VisibleNodesOptions) => VisibleNode[];
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
  maxDepth: 1,
  cycles: [],
  activeCycleFilter: null,
  versions: [],
  activeVersionFilter: null,
  reqVersionFilter: null,
  reqVersionMode: 'cumulative' as const,
  activePhaseFilter: null,
  nodeActors: new Map(),
  nodeActorsMapId: null,
  members: [],
  membersMapId: null,
  activeView: defaultViewForRole(readStoredRole()),
  loading: false,
  error: null,
  wsConnected: false,
  fleetRev: 0,
  asksRev: 0,
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
      maxDepth: 1,
      versions: [],
      activeVersionFilter: null,
      reqVersionFilter: null,
      reqVersionMode: 'cumulative',
      activePhaseFilter: null,
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

  updateMapSettings: async (fields) => {
    const state = get();
    const mapId = state.currentMapId;
    const before = state.currentMap;
    if (!mapId || !before) return false;

    set({ currentMap: { ...before, ...fields } });
    try {
      const saved = await api.updateMap(mapId, fields);
      // The server clamps (cap → int ≥ 0) — mirror what it kept, not what
      // was sent. Guard against a map switch during the round trip.
      const now = get();
      if (now.currentMapId === mapId && now.currentMap) {
        set({ currentMap: { ...now.currentMap, ...saved } });
      }
      return true;
    } catch (e: any) {
      const now = get();
      if (now.currentMapId === mapId) {
        set({ currentMap: before, error: e?.message ?? 'Failed to save map settings' });
      }
      return false;
    }
  },

  createPhase: async (name: string) => {
    const state = get();
    const mapId = state.currentMapId;
    const map = state.currentMap;
    if (!mapId || !map) return null;

    const trimmed = name.trim();
    if (!trimmed) return null;

    const current = map.phases ?? [];
    // Reuse an existing phase with the same name instead of duplicating.
    const existing = current.find((p) => p.name === trimmed);
    if (existing) return existing.id;

    const newPhase = {
      id: crypto.randomUUID(),
      name: trimmed,
      position: current.length > 0 ? Math.max(...current.map((p) => p.position)) + 1 : 0,
    };
    const phases = [...current, newPhase];

    // Optimistic update so the dropdown shows the phase immediately.
    set({ currentMap: { ...map, phases } });

    try {
      await api.updateMap(mapId, { phases });
      return newPhase.id;
    } catch (e: any) {
      // Revert on error
      set({ currentMap: { ...get().currentMap!, phases: current }, error: e.message ?? 'Failed to create phase' });
      return null;
    }
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

  /**
   * Fetch the per-node "who last touched this" map for the current map.
   *
   * Only the Workload view needs it, and it costs a query over the whole
   * change log, so it is loaded on demand when that view mounts rather
   * than as part of loadMap. Cached per map id; a failure leaves the map
   * empty, which just degrades attribution back to assignees/claims.
   */
  loadNodeActors: async () => {
    const state = get();
    const mapId = state.currentMapId;
    if (!mapId) {
      set({ nodeActors: new Map(), nodeActorsMapId: null });
      return;
    }
    if (state.nodeActorsMapId === mapId) return;
    try {
      const { actors } = await api.fetchNodeActors(mapId);
      set({
        nodeActors: new Map(actors.map((a) => [a.nodeId, { userId: a.userId, userName: a.userName }])),
        nodeActorsMapId: mapId,
      });
    } catch {
      set({ nodeActors: new Map(), nodeActorsMapId: mapId });
    }
  },

  /**
   * Fetch the assignable people for the current map. Cached per map id;
   * on failure the list stays empty, which degrades the assignee picker
   * to "show whatever ids the node already carries" rather than blocking
   * the panel.
   */
  loadMembers: async () => {
    const state = get();
    const mapId = state.currentMapId;
    if (!mapId) {
      set({ members: [], membersMapId: null });
      return;
    }
    if (state.membersMapId === mapId) return;
    try {
      const { members } = await api.fetchMapMembers(mapId);
      set({ members, membersMapId: mapId });
    } catch {
      set({ members: [], membersMapId: mapId });
    }
  },

  createVersion: async (fields) => {
    const state = get();
    const mapId = state.currentMapId;
    if (!mapId) return null;
    try {
      // The order lint (#331) is computed client-side in ReleasesView from
      // the version list; strip it so Version objects stay clean.
      const { warnings: _warnings, ...created } = await api.createVersion(mapId, fields);
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
      const { warnings: _warnings, ...updated } = await api.updateVersion(id, fields);
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
    if (state.reqVersionFilter === id) {
      set({ reqVersionFilter: null });
    }
    try {
      await api.deleteVersion(id);
    } catch (e: any) {
      set({ versions: prev, error: e.message ?? 'Failed to delete version' });
    }
  },

  setActiveVersionFilter: (versionId) => set({ activeVersionFilter: versionId }),

  setReqVersionFilter: (versionId) => set({ reqVersionFilter: versionId }),

  setReqVersionMode: (mode) => set({ reqVersionMode: mode }),

  // ── Phase actions ────────────────────────────────────────────

  setActivePhaseFilter: (phaseId) => set({ activePhaseFilter: phaseId }),

  // ── View actions ─────────────────────────────────────────────

  setActiveView: (view) => set({ activeView: view }),
  viewRole: readStoredRole(),
  setViewRole: (role) => {
    writeStoredRole(role);
    set((state) => ({ viewRole: role, activeView: reconcileView(role, state.activeView) }));
  },

  // ── Drill-down actions ──────────────────────────────────────

  setFocusNode: (nodeId) => {
    const state = get();
    // Validate node exists (or null for root)
    if (nodeId !== null && !state.nodes[nodeId]) return;
    if (nodeId === state.focusNodeId) return;
    // The drill-down trail lives in browser history — focus changes push a
    // URL entry (see useUrlState), so Back walks it natively.
    set({ focusNodeId: nodeId });
  },

  setMaxDepth: (depth) => set({ maxDepth: depth }),

  setFollowingUser: (userId) => set({ followingUserId: userId }),

  getVisibleNodes: (options) => {
    const { respectFocus = true, respectDepth = true, respectCollapsed = true } = options ?? {};
    const { nodes, rootNodeId, focusNodeId, maxDepth, activeVersionFilter, activeCycleFilter, activePhaseFilter } = get();
    if (!rootNodeId) return [];

    const effectiveRootId = (respectFocus ? focusNodeId : null) ?? rootNodeId;
    const effectiveRoot = nodes[effectiveRootId];
    if (!effectiveRoot) return [];

    // Build the visible set for the active version + sprint + phase
    // filters — see `collectScopeMatches` in scopeFilter.ts for the tag
    // inheritance / AND semantics (shared with KanbanView and GanttView).
    //
    // We walk from rootNodeId (not effectiveRootId) so inheritance picks
    // up tags on nodes above the current drill-down focus, and we expand
    // with ancestors of in-scope nodes so the mindmap stays a connected
    // tree even when scope nodes are deep.
    const scopeFilters = {
      versionId: activeVersionFilter,
      cycleId: activeCycleFilter,
      phaseId: activePhaseFilter,
    };
    let filterMatchIds: Set<string> | null = null;
    if (hasActiveScopeFilter(scopeFilters)) {
      const directMatches = collectScopeMatches(nodes, rootNodeId, scopeFilters);

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
      const atMaxDepth = respectDepth && maxDepth > 0 && depth >= maxDepth;
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
      if (!atMaxDepth && (!respectCollapsed || !node.collapsed)) {
        for (const childId of visibleChildren) {
          walk(childId, depth + 1);
        }
      }
    }

    walk(effectiveRootId, 0);

    // If we have a focus node (not the actual root), add dimmed siblings for context
    if (respectFocus && focusNodeId && focusNodeId !== rootNodeId) {
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
    // Der zuletzt angefasste Knoten ist der Anker, nicht der zuerst
    // selektierte. `selectedNodeId` steuert das Property-Panel und die
    // Tastaturnavigation: mit ids[0] zeigte das Panel nach Shift-Klick auf
    // drei Knoten den ersten an, also den, den man am wenigsten gerade im
    // Sinn hat. Beim Abwählen rückt der letzte verbliebene nach.
    set({
      selectedNodeIds: ids,
      selectedNodeId: ids[ids.length - 1] ?? null,
      editingNodeId: null,
    });
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
      attachments: [],
      autoProgress: 'off',
      priorityRank: null,
    completedAt: null,
      requirementId: null,
      requirementPriority: null,
      requirementText: null,
      phaseId: null,
      verificationText: null,
      verificationUrl: null,
      verificationVideoUrl: null,
      verificationVideoPosterUrl: null,
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

  applyServerNode: (node) => {
    const state = get();
    if (!state.nodes[node.id]) return;
    const nodes = { ...state.nodes, [node.id]: node };
    set({ nodes, computed: recomputeValues(nodes) });
  },

  unblockNode: async (id) => {
    const state = get();
    const mapId = state.currentMapId;
    if (!mapId || !state.nodes[id]) {
      set({ error: 'That ticket is no longer on this map.' });
      return false;
    }
    try {
      const { node } = await api.unblockNode(mapId, id);
      const current = get();
      if (current.currentMapId !== mapId) return true;
      const nodes = { ...current.nodes, [id]: node };
      set({ nodes, computed: recomputeValues(nodes) });
      return true;
    } catch (e: any) {
      set({ error: e?.message ?? 'Failed to release the ticket' });
      return false;
    }
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

    // Map settings changed by someone else (a PM in another tab, the
    // Leidang orchestrator's cap/policy write). Only the fleet-facing
    // settings are merged: an optimistic rename in flight (updateMapName is
    // fire-and-forget) must not be reverted by an unrelated cap broadcast.
    case 'map:updated': {
      const serverMap = msg.map as MindMap;
      if (!state.currentMap || state.currentMap.id !== serverMap.id) return;
      const patch: Partial<MindMap> = {};
      for (const key of BROADCAST_MAP_SETTINGS) {
        if (key in serverMap) (patch as Record<string, unknown>)[key] = serverMap[key];
      }
      set({ currentMap: { ...state.currentMap, ...patch } });
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

    // A satellite rollup or an orchestrator tick landed — the payload is not
    // on the socket (rollups are large); the Fleet card refetches.
    case 'fleet:updated': {
      set({ fleetRev: state.fleetRev + 1 });
      break;
    }

    // The orchestrator pushed a new asks set, or someone answered one.
    case 'asks:updated': {
      set({ asksRev: state.asksRev + 1 });
      break;
    }
  }
}
