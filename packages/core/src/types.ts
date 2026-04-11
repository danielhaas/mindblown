// ── Branded ID types ────────────────────────────────────────────
/** Unique identifier. UUIDv7 for sortability + uniqueness. */
export type NodeId = string;
export type UserId = string;
export type MapId = string;
export type CycleId = string;
export type MilestoneId = string;
export type VersionId = string;

// ── Enums / Unions ──────────────────────────────────────────────

/** The four standard dependency types. */
export type DependencyType = 'FS' | 'SS' | 'FF' | 'SF';

/** Health signal, computed automatically. */
export type HealthSignal = 'on_track' | 'at_risk' | 'behind';

/** Priority levels. */
export type Priority = 'P0' | 'P1' | 'P2' | 'P3';

/** Effort unit, configured per map. */
export type EffortUnit = 'hours' | 'days' | 'points';

/** Layout algorithm setting. */
export type LayoutMode = 'radial' | 'tree_lr' | 'tree_td' | 'org_chart' | 'freeform';

/**
 * A custom field value. The shape depends on the field definition
 * on the Map (see MapSchema.customFieldDefs).
 */
export type CustomFieldValue =
  | string
  | number
  | boolean
  | string[] // multi-select
  | null;

// ── Dependency ──────────────────────────────────────────────────

/**
 * A dependency edge. Stored on the dependent (downstream) node.
 * "This node depends on `targetNodeId`."
 */
export interface Dependency {
  targetNodeId: NodeId;
  type: DependencyType;
  /** Lag in the map's effort unit. Positive = delay, negative = overlap. */
  lag: number;
}

// ── External Link ───────────────────────────────────────────────

/**
 * An external link to an integration object (GitHub Issue, Jira ticket, etc.).
 */
export interface ExternalLink {
  provider: string; // 'github' | 'jira' | 'linear' | 'gitlab' | ...
  externalId: string; // e.g. 'octocat/repo#42'
  url: string; // direct link
  syncEnabled: boolean; // whether bidirectional sync is active
  lastSyncedAt: string | null; // ISO 8601

  /**
   * Node state captured the moment the external system drove the node
   * to "complete". Used to revert progress/status when the external
   * system reopens the item (e.g. GitHub issue reopened).
   */
  previousPercentComplete?: number | null;
  previousStatus?: string | null;
}

// ── Node ────────────────────────────────────────────────────────

/**
 * The core Node. Every field except id, mapId, and text is optional.
 * This is the canonical shape — the database stores this, the API
 * sends this, and every view reads from this.
 */
export interface Node {
  // ── Identity ──────────────────────────────────────────────
  id: NodeId;
  mapId: MapId;

  // ── Tree structure ────────────────────────────────────────
  parentId: NodeId | null; // null = root node
  childrenIds: NodeId[]; // ordered array — position = sort order

  // ── Content ───────────────────────────────────────────────
  text: string; // title / label shown on the node
  description: string | null; // rich text (stored as HTML or ProseMirror JSON)

  // ── Spatial position (mindmap) ────────────────────────────
  x: number | null; // null = use auto-layout
  y: number | null;
  collapsed: boolean; // whether children are hidden in mindmap view

  // ── Task properties (all optional — gradual enrichment) ───
  effortEstimate: number | null; // leaf-only input; null = unestimated
  actualEffort: number | null; // leaf-only input; null = unrecorded. Same unit as effortEstimate. Used to compute estimation accuracy.
  percentComplete: number | null; // leaf-only input; 0–100; null = unset
  status: string | null; // references a status from Map.statusWorkflow
  assigneeIds: UserId[]; // zero or more assignees
  priority: Priority | null;
  dueDate: string | null; // ISO 8601 date
  startDate: string | null; // ISO 8601 date
  tags: string[]; // freeform labels
  customFields: Record<string, CustomFieldValue>;

  // ── Dependencies ──────────────────────────────────────────
  dependencies: Dependency[]; // "this node depends on ..."

  // ── Milestone ─────────────────────────────────────────────
  isMilestone: boolean; // zero-effort checkpoint

  // ── Version / Milestone / Sprint ──────────────────────────
  versionId: VersionId | null; // which version this node targets
  milestoneId: MilestoneId | null; // which milestone this node contributes to
  cycleId: CycleId | null; // which sprint this node is worked in

  // ── Integrations ──────────────────────────────────────────
  externalLinks: ExternalLink[];

  // ── Metadata ──────────────────────────────────────────────
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  createdBy: UserId;
}

// ── Computed values (returned alongside nodes, never stored) ────

export interface ComputedNodeValues {
  computedEffort: number;
  computedProgress: number;
  healthSignal: HealthSignal;
}

// ── Map schema types ────────────────────────────────────────────

/** Custom field definition — lives on the map, values live on nodes. */
export interface CustomFieldDef {
  id: string;
  name: string;
  type:
    | 'text'
    | 'number'
    | 'date'
    | 'select'
    | 'multi_select'
    | 'person'
    | 'checkbox'
    | 'url';
  options?: string[]; // for select / multi_select
  required: boolean;
}

/** A status in the workflow. */
export interface StatusDef {
  id: string;
  name: string; // e.g. 'Todo', 'In Progress', 'Done'
  category: 'todo' | 'in_progress' | 'done'; // for view grouping and auto-progress
  color: string; // hex
  position: number; // sort order
}

/** A baseline snapshot for plan-vs-actual comparison. */
export interface Baseline {
  id: string;
  name: string; // e.g. 'Sprint 3 plan', 'Q2 kickoff'
  createdAt: string;
  /** Snapshot of every node's key planning fields at the time of baseline. */
  nodes: Record<
    NodeId,
    {
      effortEstimate: number | null;
      percentComplete: number | null;
      startDate: string | null;
      dueDate: string | null;
      status: string | null;
    }
  >;
}

/**
 * The Map — a project, a plan, a collection of nodes.
 */
export interface MindMap {
  id: MapId;
  workspaceId: string;

  // ── Content ───────────────────────────────────────────────
  name: string;
  description: string | null;
  rootNodeId: NodeId; // every map has exactly one root

  // ── Configuration ─────────────────────────────────────────
  effortUnit: EffortUnit; // hours | days | points
  statusWorkflow: StatusDef[]; // ordered list of statuses
  customFieldDefs: CustomFieldDef[];
  defaultLayout: LayoutMode;
  healthThreshold: number; // 0–1, default 0.2 (at_risk if 20% behind pace)

  // ── Baselines ─────────────────────────────────────────────
  baselines: Baseline[];

  // ── WIP limits (kanban) ───────────────────────────────────
  /**
   * Soft cap on the number of nodes that may sit in an "in_progress"
   * category status at once. Enforced as a warning by set_status.
   * null = no limit.
   */
  wipLimit: number | null;

  // ── Gantt / scheduling ────────────────────────────────────
  /**
   * Calendar anchor for the Gantt view. Day 0 of the computed
   * schedule maps to this date. null = fall back to today.
   * ISO 8601 date (YYYY-MM-DD).
   */
  projectStartDate: string | null;
  /**
   * Conversion factor when effortUnit is 'hours': number of working
   * hours per calendar day. Used to map effort-unit offsets to
   * calendar days in the Gantt. Ignored for 'days'. Default 8.
   */
  hoursPerDay: number;

  // ── Metadata ──────────────────────────────────────────────
  createdAt: string;
  updatedAt: string;
  createdBy: UserId;
  archivedAt: string | null;

  // ── GitHub integration ──────────────────────────────────
  githubInstallationId?: string | null;
  githubRepoOwner?: string | null;
  githubRepoName?: string | null;
}

// ── User / Workspace / Team ─────────────────────────────────────

export interface User {
  id: UserId;
  email: string;
  name: string;
  avatarUrl: string | null;
  createdAt: string;
}

export interface Workspace {
  id: string;
  name: string;
  slug: string; // URL-friendly identifier
  ownerId: UserId;
  createdAt: string;
}

export interface WorkspaceMember {
  workspaceId: string;
  userId: UserId;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  joinedAt: string;
}

export interface MapPermission {
  mapId: MapId;
  userId: UserId;
  permission: 'view' | 'edit' | 'admin';
}

// ── Version ─────────────────────────────────────────────────────

export interface Version {
  id: VersionId;
  workspaceId: string;
  name: string; // e.g. 'V1', 'V2', '1.0'
  description: string | null;
  status: 'planning' | 'active' | 'released' | 'archived';
  targetDate: string | null; // ISO 8601 date
  sortOrder: number; // display ordering
  createdAt: string;
}

// ── Milestone ───────────────────────────────────────────────────

export interface Milestone {
  id: MilestoneId;
  versionId: VersionId | null; // which version this milestone belongs to
  workspaceId: string;
  name: string; // e.g. 'Kernsystem MVP', 'Billing Module'
  description: string | null;
  status: 'open' | 'closed';
  targetDate: string | null; // ISO 8601 date
  sortOrder: number;
  createdAt: string;
}

// ── Cycle / Sprint ──────────────────────────────────────────────

export interface Cycle {
  id: CycleId;
  workspaceId: string;
  versionId: VersionId | null; // which version this sprint belongs to
  name: string; // e.g. 'Sprint 14', 'April cycle'
  startDate: string; // ISO 8601
  endDate: string;
  status: 'planned' | 'active' | 'completed';
  createdAt: string;
}

// ── Integration ─────────────────────────────────────────────────

export interface Integration {
  id: string;
  workspaceId: string;
  provider: string; // 'github' | 'jira' | 'linear' | 'gitlab'
  config: Record<string, unknown>; // provider-specific
  enabled: boolean;
  createdAt: string;
}

export interface SyncLogEntry {
  id: string;
  integrationId: string;
  nodeId: NodeId;
  direction: 'inbound' | 'outbound';
  fieldsSynced: string[]; // e.g. ['status', 'assigneeIds']
  timestamp: string;
  status: 'success' | 'conflict' | 'error';
  errorMessage: string | null;
}

export interface FieldMapping {
  integrationId: string;
  mindblownField: string; // e.g. 'status', 'priority', 'assigneeIds'
  externalField: string; // e.g. 'state', 'priority', 'assignees'
  valueMapping?: Record<string, string>;
}

// ── Scheduling result types ─────────────────────────────────────

export interface ScheduledNode {
  nodeId: NodeId;
  computedStart: number; // days from project start (epoch-like offset)
  computedEnd: number;
  duration: number;
}

export interface CriticalPathResult {
  /** Ordered chain of node IDs on the critical path. */
  path: NodeId[];
  /** Total project duration. */
  totalDuration: number;
  /** Float per node (0 = on critical path). */
  float: Record<NodeId, number>;
}

// ── Convenience: a lookup map ───────────────────────────────────

export type NodeMap = Map<NodeId, Node>;
