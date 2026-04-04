import { create } from 'zustand';
import type { Node, NodeId, ComputedNodeValues } from '@mindblown/core';
import { computeTree } from '@mindblown/core';

// ── Helpers ────────────────────────────────────────────────────

let idCounter = 0;
function generateId(): string {
  idCounter += 1;
  return `node-${idCounter.toString().padStart(4, '0')}`;
}

function makeNode(
  overrides: Partial<Node> & { id: string; mapId: string; text: string },
): Node {
  const now = new Date().toISOString();
  return {
    parentId: null,
    childrenIds: [],
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
    ...overrides,
  };
}

// ── Demo data ──────────────────────────────────────────────────

function createDemoNodes(): { nodes: Record<string, Node>; rootId: string } {
  const MAP_ID = 'map-001';

  const root = makeNode({ id: 'n-root', mapId: MAP_ID, text: 'Website Redesign' });

  // Design branch
  const design = makeNode({ id: 'n-design', mapId: MAP_ID, text: 'Design', parentId: 'n-root' });
  const wireframes = makeNode({
    id: 'n-wireframes', mapId: MAP_ID, text: 'Wireframes',
    parentId: 'n-design', effortEstimate: 3, percentComplete: 100, priority: 'P2',
  });
  const visualDesign = makeNode({
    id: 'n-visual', mapId: MAP_ID, text: 'Visual Design',
    parentId: 'n-design', effortEstimate: 5, percentComplete: 80, priority: 'P1',
    assigneeIds: ['user-002'],
  });
  const designSystem = makeNode({
    id: 'n-designsys', mapId: MAP_ID, text: 'Design System',
    parentId: 'n-design', effortEstimate: 4, percentComplete: 25, priority: 'P1',
    assigneeIds: ['user-003'],
  });
  design.childrenIds = ['n-wireframes', 'n-visual', 'n-designsys'];

  // Frontend branch
  const frontend = makeNode({ id: 'n-frontend', mapId: MAP_ID, text: 'Frontend', parentId: 'n-root' });
  const componentLib = makeNode({
    id: 'n-complib', mapId: MAP_ID, text: 'Component Library',
    parentId: 'n-frontend', effortEstimate: 8, percentComplete: 15, priority: 'P0',
    assigneeIds: ['user-004'],
  });
  const pageTemplates = makeNode({
    id: 'n-pages', mapId: MAP_ID, text: 'Page Templates',
    parentId: 'n-frontend', effortEstimate: 7, percentComplete: 5, priority: 'P1',
  });
  frontend.childrenIds = ['n-complib', 'n-pages'];

  // Backend branch
  const backend = makeNode({ id: 'n-backend', mapId: MAP_ID, text: 'Backend', parentId: 'n-root' });
  const apiEndpoints = makeNode({
    id: 'n-api', mapId: MAP_ID, text: 'API Endpoints',
    parentId: 'n-backend', effortEstimate: 7, percentComplete: 0, priority: 'P0',
  });
  const dbMigration = makeNode({
    id: 'n-db', mapId: MAP_ID, text: 'Database Migration',
    parentId: 'n-backend', effortEstimate: 5, percentComplete: 0, priority: 'P1',
  });
  backend.childrenIds = ['n-api', 'n-db'];

  // Content branch
  const content = makeNode({ id: 'n-content', mapId: MAP_ID, text: 'Content', parentId: 'n-root' });
  const copywriting = makeNode({
    id: 'n-copy', mapId: MAP_ID, text: 'Copywriting',
    parentId: 'n-content', effortEstimate: 5, percentComplete: 40, priority: 'P2',
    assigneeIds: ['user-005'],
  });
  const photography = makeNode({
    id: 'n-photo', mapId: MAP_ID, text: 'Photography',
    parentId: 'n-content', effortEstimate: 3, percentComplete: 10, priority: 'P3',
  });
  content.childrenIds = ['n-copy', 'n-photo'];

  root.childrenIds = ['n-design', 'n-frontend', 'n-backend', 'n-content'];

  const nodes: Record<string, Node> = {};
  const allNodes = [
    root, design, wireframes, visualDesign, designSystem,
    frontend, componentLib, pageTemplates,
    backend, apiEndpoints, dbMigration,
    content, copywriting, photography,
  ];
  for (const n of allNodes) {
    nodes[n.id] = n;
  }

  return { nodes, rootId: 'n-root' };
}

// ── Store types ────────────────────────────────────────────────

export interface MindmapState {
  nodes: Record<string, Node>;
  rootNodeId: string;
  selectedNodeId: string | null;
  editingNodeId: string | null;
  computed: Map<NodeId, ComputedNodeValues>;

  // Actions
  selectNode: (id: string | null) => void;
  startEditing: (id: string | null) => void;
  addNode: (parentId: string, text?: string, asSibling?: boolean) => string;
  updateNode: (id: string, updates: Partial<Node>) => void;
  deleteNode: (id: string) => void;
  toggleCollapse: (id: string) => void;
  recompute: () => void;
}

// ── Store implementation ───────────────────────────────────────

const { nodes: initialNodes, rootId } = createDemoNodes();

function recomputeValues(nodes: Record<string, Node>): Map<NodeId, ComputedNodeValues> {
  return computeTree(Object.values(nodes));
}

export const useMindmapStore = create<MindmapState>((set, get) => ({
  nodes: initialNodes,
  rootNodeId: rootId,
  selectedNodeId: null,
  editingNodeId: null,
  computed: recomputeValues(initialNodes),

  selectNode: (id) => set({ selectedNodeId: id, editingNodeId: null }),

  startEditing: (id) => set({ editingNodeId: id }),

  addNode: (parentId, text = 'New node', asSibling = false) => {
    const state = get();
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
        // Root node can't have siblings — add as child instead
        targetParentId = parentId;
      }
    }

    const newId = generateId();
    const newNode = makeNode({
      id: newId,
      mapId: 'map-001',
      text,
      parentId: targetParentId,
    });

    const updatedNodes = { ...state.nodes };
    const parent = { ...updatedNodes[targetParentId] };
    const newChildren = [...parent.childrenIds];

    if (insertIndex >= 0 && insertIndex < newChildren.length) {
      newChildren.splice(insertIndex, 0, newId);
    } else {
      newChildren.push(newId);
    }
    parent.childrenIds = newChildren;
    updatedNodes[targetParentId] = parent;
    updatedNodes[newId] = newNode;

    set({
      nodes: updatedNodes,
      selectedNodeId: newId,
      editingNodeId: newId,
      computed: recomputeValues(updatedNodes),
    });

    return newId;
  },

  updateNode: (id, updates) => {
    const state = get();
    const node = state.nodes[id];
    if (!node) return;

    const updatedNode = { ...node, ...updates, updatedAt: new Date().toISOString() };
    const updatedNodes = { ...state.nodes, [id]: updatedNode };

    set({
      nodes: updatedNodes,
      computed: recomputeValues(updatedNodes),
    });
  },

  deleteNode: (id) => {
    const state = get();
    if (id === state.rootNodeId) return; // Can't delete root

    const node = state.nodes[id];
    if (!node || !node.parentId) return;

    // Collect all descendants
    const toDelete = new Set<string>();
    const queue = [id];
    while (queue.length > 0) {
      const current = queue.shift()!;
      toDelete.add(current);
      const n = state.nodes[current];
      if (n) queue.push(...n.childrenIds);
    }

    const updatedNodes = { ...state.nodes };

    // Remove from parent
    const parent = { ...updatedNodes[node.parentId] };
    parent.childrenIds = parent.childrenIds.filter((cid) => cid !== id);
    updatedNodes[node.parentId] = parent;

    // Delete all descendants
    for (const did of toDelete) {
      delete updatedNodes[did];
    }

    // Find a sensible next selection: next sibling, previous sibling, or parent
    let nextSelection: string | null = node.parentId;
    const siblingIdx = state.nodes[node.parentId]?.childrenIds.indexOf(id) ?? -1;
    const siblings = parent.childrenIds;
    if (siblings.length > 0) {
      nextSelection = siblings[Math.min(siblingIdx, siblings.length - 1)];
    }

    set({
      nodes: updatedNodes,
      selectedNodeId: nextSelection,
      editingNodeId: null,
      computed: recomputeValues(updatedNodes),
    });
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
