// ── Branded ID types ────────────────────────────────────────────
/** Unique identifier. UUIDv7 for sortability + uniqueness. */
export type NodeId = string;
export type UserId = string;
export type MapId = string;
export type CycleId = string;
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
   * The external item's own open/closed state, as of last sync. Absent
   * on links written before this field existed — treat as unknown, not
   * open, in that case.
   */
  state?: 'open' | 'closed';

  /**
   * True when this "issue" link actually points at a pull request.
   * GitHub shares one number space between issues and PRs, so a node can
   * end up linked to `owner/repo#856` where 856 is a PR. Those links are
   * invisible to `fetchChangedIssues` (it filters PRs out of the list),
   * so they need the direct-resolve path — and the UI should not claim
   * they're issues. Absent = unknown / not yet resolved.
   */
  isPullRequest?: boolean;

  /**
   * Node state captured the moment the external system drove the node
   * to "complete". Used to revert progress/status when the external
   * system reopens the item (e.g. GitHub issue reopened).
   */
  previousPercentComplete?: number | null;
  previousStatus?: string | null;

  /**
   * sha256 (hex) of the issue body the MIRROR path last wrote into
   * `node.description` — stamped at ingest-create and on every applied
   * inbound body edit. The description guard compares the node's
   * current description against THIS (what the mirror wrote), not
   * against what GitHub currently holds: after outbound sync pushes a
   * curated text into the GH body the two are equal, and a
   * GH-side-state comparison would misread the curation as a mirror
   * and let the next body edit wipe it. Absent on legacy links —
   * the guard then falls back to a prior-body equality check and
   * stamps the hash lazily on the first applied edit.
   */
  descriptionMirrorHash?: string;

  /**
   * SHA of the merge commit that landed the work for this issue on the
   * repo's DEFAULT branch, plus the PR it came from. Written by the
   * `pull_request.closed + merged=true` webhook handler and by the
   * closed-issue audit (`auditClosedIssues`).
   *
   * This is the ONLY durable proof MindBlown holds that an issue's work
   * actually shipped. `node.linkedPr` cannot serve that role: the mirror
   * is deliberately CLEARED on a default-branch merge, so five minutes
   * after the merge the node looks exactly like a node that never had a
   * PR. Closing an issue as COMPLETED requires this field (or a live
   * probe against GitHub) — see `issueCloseAction` in `linkedPr.ts`.
   *
   * Absent on links written before the field existed and on issues that
   * never had a merged PR.
   */
  mergeCommitSha?: string | null;
  /** PR number whose merge produced `mergeCommitSha`. */
  mergedPrNumber?: number | null;
}

/**
 * GH PR state mirrored onto a node, populated by `pull_request.*` /
 * `pull_request_review.*` / `check_suite.completed` webhooks.
 *
 * The PR is linked to the node by parsing `Closes #NNNN` (or
 * `Fixes #NNNN`) from the PR body, same convention the existing
 * `pull_request.closed` (merged=true) handler uses.
 */
export interface LinkedPrState {
  number: number;
  repo: string; // e.g. 'octocat/foo'
  url: string;
  head: string; // head branch
  base: string; // base branch (usually main / release/v1)
  author: string | null;
  draft: boolean;
  /** open / closed / merged */
  state: 'open' | 'closed' | 'merged';
  /**
   * Set (to false) when the PR merged to something OTHER than the
   * repo's default branch (release/v1 hotfix flow) — the work is
   * merged, but it has NOT landed on main, so the issue-close gate
   * stays armed. Absent on 'open'/'closed' mirrors and on legacy
   * 'merged' mirrors (treat absent as landed — pre-flag behavior).
   */
  landedOnDefault?: boolean;
  /** GitHub's mergeable flag. `null` while GitHub is still computing it. */
  mergeable: boolean | null;
  /** Files changed in the PR — paths only, used by Kira's risky-paths gate. */
  changedFiles: string[];
  /** All reviews on the PR; Ray's verdict lives here in body. */
  reviews: Array<{
    author: string;
    /** APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED */
    state: string;
    body: string;
    submittedAt: string;
  }>;
  /** Roll-up CI state for the latest commit on the PR head. */
  checks: {
    /** success | failure | pending | null (no checks yet) */
    state: string | null;
    failures: string[];
  };
  /** ISO timestamp of the most recent webhook update. */
  lastSyncedAt: string;
}

// ── Attachment ──────────────────────────────────────────────────

/**
 * A file or a link somebody hung on a node.
 *
 * Kept apart from `ExternalLink` on purpose. That type is integration
 * state — sync flags, the remote's open/closed status, whether a GitHub
 * number turned out to be a PR — and the sync jobs both read and write
 * it. A URL a person pasted has none of that and must not be walked over
 * by a sync pass, so it lives here.
 *
 * `kind` is the only structural difference between the two cases: a file
 * is something we host and therefore know the size and type of, a link
 * points somewhere we know nothing about. Everything else is shared, so
 * the UI renders one list rather than two.
 */
export interface Attachment {
  id: string;
  kind: 'file' | 'link';
  /** Absolute URL. For files, the one `POST /api/media` minted. */
  url: string;
  /** What the list shows. Defaults to the filename or the host. */
  title: string;
  /** Files only — what the server accepted it as. */
  mimeType?: string | null;
  /** Files only. */
  sizeBytes?: number | null;
  addedAt: string;
  addedBy?: UserId | null;
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
  blockedReason: string | null; // null = not manually blocked; string = blocker description
  assigneeIds: UserId[]; // zero or more assignees
  priority: Priority | null;
  dueDate: string | null; // ISO 8601 date
  startDate: string | null; // ISO 8601 date
  tags: string[]; // freeform labels
  customFields: Record<string, CustomFieldValue>;

  // ── Dependencies ──────────────────────────────────────────
  dependencies: Dependency[]; // "this node depends on ..."

  // ── Version / Sprint ──────────────────────────────────────
  versionId: VersionId | null; // which version this node targets
  cycleId: CycleId | null; // which sprint this node is worked in

  // ── Integrations ──────────────────────────────────────────
  externalLinks: ExternalLink[];

  // ── Attachments ───────────────────────────────────────────
  /** Files and links a person hung on this node. See `Attachment`. */
  attachments: Attachment[];

  // ── Sibling ordering (Gantt slice 1) ─────────────────────────
  /**
   * Fractional ranking for sibling reordering (Linear-style).
   * Resolved sibling order = priorityRank ASC NULLS LAST → priority enum
   * (P0 < P1 < P2 < P3) → createdAt ASC.
   * null = no explicit rank (sorts after ranked siblings).
   */
  priorityRank: number | null;

  /**
   * ISO 8601 timestamp of when this node was marked done. Set when status
   * transitions into a 'done' workflow category OR percentComplete hits 100;
   * cleared when either un-dones. Used by the Gantt scheduler to position
   * done bars at their actual close date in the past.
   * null = either not done, or done before the column existed (no history).
   */
  completedAt: string | null;

  // ── Orchestration substrate (#111) ────────────────────────────

  /**
   * The session ID that has claimed this node for active work.
   * null = unclaimed / available for dispatch.
   * Set by `claim_node`, cleared by `release_node` or `set_status('done')`.
   */
  claimedBySession: string | null;

  /**
   * ISO 8601 timestamp when the current claim was set.
   * null when `claimedBySession` is null.
   * Used by the stale-claim sweeper to auto-release claims older than N hours.
   */
  claimedAt: string | null;

  /**
   * Free-form scope tags declaring what work this node touches.
   * Examples: `apps/workflows`, `model:Mandate`, `migration:workflows`,
   * `frontend:contacts`. Used by `conflict_scan` to surface in-flight
   * nodes that might conflict with a candidate being dispatched.
   * Empty array = no scopes declared (no conflict-detection).
   */
  scopes: string[];

  /**
   * GH PR state mirrored onto this node, populated by the
   * `pull_request.*` / `pull_request_review.*` / `check_suite.completed`
   * webhook handlers in the MindBlown server. Lets Kira / other
   * dispatch automation read PR state without polling the GH API.
   * `null` when no PR currently references this node's linked issue.
   * Optional so existing fixtures / synthetic nodes don't have to
   * include it explicitly.
   */
  linkedPr?: LinkedPrState | null;

  // ── Requirements register ─────────────────────────────────
  /**
   * Stable business requirement ID (e.g. "MAN-01"). Non-null marks this
   * node as a requirement: it appears in the Requirements view and the
   * `requirements_overview` MCP register. Unique per map (application-
   * level check in the DB layer). The requirement's status is never
   * stored — it derives from progress rollup (100 → done, >0 → partial,
   * else open).
   */
  requirementId: string | null;

  /** MoSCoW-style requirement priority (Muss/Soll/Kann). */
  requirementPriority: 'must' | 'should' | 'could' | null;

  /**
   * Business phrasing of the requirement for the register and doc export.
   * Kept separate from `text` (which may be a ticket-style title synced to
   * GitHub) and deliberately NOT in the GitHub outbound SYNC_FIELDS.
   * null = fall back to `text`.
   */
  requirementText: string | null;

  // ── Phase ─────────────────────────────────────────────────
  /**
   * Reference to a `PhaseDef.id` from the map's `phases` list (same
   * idiom as `status` → `Map.statusWorkflow`, and same shape as
   * versionId/cycleId). Lightweight by design — a phase is a label
   * with an order, NOT a heavy entity (the April-removed Milestones):
   * no rollup, no health, no scheduling. null = no phase assigned.
   */
  phaseId: string | null;
  /**
   * How to verify this requirement (Prüfanleitung): markdown with numbered
   * steps, expected result and test data, written for a non-technical
   * reviewer. Rendered on the review surface next to the accept/reject
   * actions. Like `requirementText`, NOT in the GitHub SYNC_FIELDS.
   */
  verificationText: string | null;

  /**
   * Deep link to where this requirement is verified (e.g. a staging URL).
   * Rendered as an "open" button on the review surface.
   */
  verificationUrl: string | null;

  /**
   * Link to a short demo video showing the requirement in action (e.g. a
   * screen recording). Rendered as a "watch video" button on the review
   * surface next to `verificationUrl`. Optional companion to the written
   * Prüfanleitung — a non-technical reviewer who can't follow the steps
   * can watch instead. Like the other two, NOT in the GitHub SYNC_FIELDS.
   */
  verificationVideoUrl: string | null;

  /**
   * Still image shown in the player before the clip is started — the
   * `poster` attribute of the `<video>` on the review surface.
   *
   * Not cosmetic, and not something `preload="metadata"` already covers:
   * the browser paints frame 0, and frame 0 of a screen recording is the
   * blank page the recorder was still waiting on. Measured against the two
   * clips that exist: MAN-01 is blank white for ~1 s, PEN-01 for ~3 s. A
   * `#t=N` media fragment would paint a later frame, but it also *moves
   * the playhead*, so pressing play would skip the start of the very
   * instructions the clip exists to give.
   *
   * Meaningless without `verificationVideoUrl` — a poster with no video is
   * not rendered anywhere, and `verificationOf` does not count it as
   * documentation on its own. Like the other verification fields, NOT in
   * the GitHub SYNC_FIELDS.
   */
  verificationVideoPosterUrl: string | null;

  // ── Auto-progress (parent-epic rollup) ────────────────────
  /**
   * When set to `'children'`, the server auto-computes percentComplete on this
   * node by counting closed/open GitHub child issues whose titles reference
   * this node's linked issue (e.g. `[#NNNN-followup] ...`). See
   * `packages/server/src/sync/parentEpicRollup.ts` for the supported patterns.
   * `'off'` (default) leaves manual progress authoritative.
   */
  autoProgress: 'off' | 'children';

  // ── Metadata ──────────────────────────────────────────────
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  createdBy: UserId;
  // Bumps on every successful update. Clients send their last-seen value
  // as expectedRevision so concurrent edits don't silently clobber.
  revision: number;

  // ── Soft delete ───────────────────────────────────────────
  // Non-null = node is in the trash. Set by deleteNode, cleared by
  // restoreNode. GC hard-deletes rows after the retention window.
  // Reads must filter `WHERE deletedAt IS NULL` unless they're an
  // audit/snapshot path.
  deletedAt: string | null;
}

// ── Computed values (returned alongside nodes, never stored) ────

export interface ComputedNodeValues {
  computedEffort: number;
  computedProgress: number;
  healthSignal: HealthSignal;
  isBlocked: boolean;
  blockedBy: BlockedBy;
}

/** Detail behind isBlocked — which signals fired. */
export interface BlockedBy {
  manual: boolean; // true if blockedReason is set on this node
  predecessorIds: NodeId[]; // FS predecessors with progress < 100
  blockedDescendantCount: number; // leaves under this parent that are blocked
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

/**
 * A project phase (e.g. "M1 – Grundgerüst"). Lives on the map (same
 * pattern as StatusDef in `statusWorkflow`); nodes reference it via
 * `Node.phaseId`. Stable `id` so phases can be renamed without touching
 * nodes; `position` is the canonical phase order.
 */
export interface PhaseDef {
  id: string; // stable — rename without touching nodes
  name: string; // e.g. 'M1 – Grundgerüst'
  position: number; // canonical sort order
  color?: string; // optional hex, unused in v1 UI
  targetDate?: string | null; // optional ISO date; deliberately in the model, unused in v1
}

/** A status in the workflow. */
export interface StatusDef {
  id: string;
  name: string; // e.g. 'Todo', 'In Progress', 'Done'
  category: 'todo' | 'in_progress' | 'done'; // for view grouping and auto-progress
  color: string; // hex
  position: number; // sort order
}

/**
 * Pull-queue profile routing thresholds (#262). Presence of this object
 * on a map ACTIVATES profile-based eligibility in `get_next_ticket`;
 * `profilePolicy: null` (the default) keeps the queue profile-blind.
 *
 * Class rules built from signals that already exist (no difficulty tag):
 * - heavy-class ticket: P0 OR effort ≥ `heavyMinHours` — reserved for
 *   `profile: "heavy"` pullers (first refusal).
 * - light-eligible ticket: effort ≤ `lightMaxHours` AND priority P2/P3.
 * - unestimated tickets are eligible to EVERY profile (never starve).
 * - unknown/absent puller profile = standard (fail open).
 *
 * Thresholds are hours; node estimates are normalized from the map's
 * effortUnit via `hoursPerDay` before comparison. On `points` maps the
 * effort triggers are inert (points aren't time) — only the P0 heavy
 * trigger applies.
 */
export interface ProfilePolicy {
  /** Heavy-class floor in hours. Omitted = one day (`hoursPerDay`). */
  heavyMinHours?: number;
  /** Light-eligible ceiling in hours. Omitted = 2. */
  lightMaxHours?: number;
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

  // ── Phases ────────────────────────────────────────────────
  /**
   * Project phases of this map (statusWorkflow idiom): definitions live
   * here, nodes reference them via `phaseId`. `position` is the
   * canonical order. Rename/reorder by replacing the array via map
   * update — node phaseIds stay valid because ids are stable.
   *
   * Updates are replace-mode, last-writer-wins: there is no
   * optimistic-concurrency guard on map-level fields, so two concurrent
   * full-array writes silently drop each other's additions (same
   * trade-off as statusWorkflow/customFieldDefs).
   */
  phases: PhaseDef[];

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

  /**
   * Number of parallel work tracks the scheduler projects onto.
   * View-only knob — the underlying plan (priorities + estimates + deps)
   * doesn't change. 1 = strict serial single-worker view. Default 1.
   */
  workerCount: number;

  /**
   * Fraction of calendar time that actually reaches planned-ticket work
   * (0.05–1.0). Captures the drag of meetings, support, firefighting and
   * unplanned work — a team spending half its time on planned tickets has a
   * focus factor of 0.5, so the same estimated effort takes twice as long in
   * calendar terms. Applied to the *velocity-adjusted* forecast line only
   * (planned finish stays the idealised scheduler baseline), orthogonal to
   * the estimation fudge factor. Default 1.0 = no capacity leakage.
   */
  focusFactor: number;

  // ── Pull queue (Leidang) ──────────────────────────────────
  /**
   * Fleet-wide cap on concurrently claimed nodes for the pull queue
   * (`get_next_ticket`). Counted across ALL sessions — the constraint it
   * models (CI capacity) is shared, not per-worker. 0 = hold: the queue
   * grants nothing and the fleet drains naturally. Default 0 so a map
   * must opt in before workers can pull from it.
   */
  maxActiveClaims: number;
  /**
   * AND-filter fencing what `get_next_ticket` may hand out. Tiny
   * deliberate vocabulary: `version:<versionId>` (effective version via
   * the explicit-assignment-wins ancestor walk) and `type:bug` (node
   * tagged "bug"). Empty = no fence. A ticket outside the gate is
   * invisible to the pull queue, not deprioritized.
   */
  dispatchGate: string[];
  /**
   * Ordered sort keys ranking the gated ready set: `bugs` (bug-tagged
   * first), `priority` (priorityRank then P0–P3), `size` (effort
   * estimate ascending, nulls last), `age` (oldest first). Empty =
   * default `["bugs", "priority", "age"]`. No weights, no expressions —
   * an ordered list is the whole policy language.
   */
  dispatchPolicy: string[];
  /**
   * Profile routing table for `get_next_ticket(sessionId, profile)`.
   * null (default) = profile-blind queue — the parameter stays inert
   * exactly as before #262. See {@link ProfilePolicy} for the rules.
   * Routing only FILTERS eligibility; dispatchPolicy ranking is
   * untouched.
   */
  profilePolicy: ProfilePolicy | null;

  // ── Metadata ──────────────────────────────────────────────
  createdAt: string;
  updatedAt: string;
  createdBy: UserId;
  archivedAt: string | null;

  // ── GitHub integration ──────────────────────────────────
  githubInstallationId?: string | null;
  githubRepoOwner?: string | null;
  githubRepoName?: string | null;
  /**
   * When true, new GitHub issues on the bound repo are auto-imported as
   * nodes under the map's GitHub Inbox (lazy-created child of root).
   * Default is `false` so existing maps don't flood retroactively on
   * the next catchup sweep — the frontend defaults this to checked on
   * first GitHub connect, so new connections opt in naturally.
   * See packages/server/src/sync/githubIngest.ts for the ingest pipeline.
   */
  autoImportNewIssues?: boolean;
  /**
   * ID of the "GitHub Inbox" node — a child of root that holds
   * auto-ingested issue nodes. Lazily created on first ingest and
   * persisted here so it survives node deletions (the deletion case
   * is handled by treating a dangling ID as "recreate on next ingest").
   */
  githubInboxNodeId?: string | null;
  /**
   * Per-map opt-in for the AI triage pipeline. When true, new GitHub
   * issues bound to this map go through the LLM triage classifier
   * before any node is created; high-confidence place decisions
   * auto-create the node, low-confidence ones wait in the Triage panel.
   * Default false → ingest behaves like vanilla auto-import.
   * Server source: `maps.triage_enabled`.
   */
  triageEnabled?: boolean;
  /**
   * Per-map opt-in for GitHub label write-back. When true, finalized
   * triage decisions write `triage:placed` / `triage:skipped` labels
   * back to the source GitHub issue. Best-effort: a label write failure
   * never blocks the triage flow. Requires `triageEnabled` to do anything.
   * Server source: `maps.triage_label_writeback`.
   */
  triageLabelWriteback?: boolean;
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
  mapId: MapId;
  name: string; // e.g. 'V1', 'V2', '1.0'
  description: string | null;
  status: 'planning' | 'active' | 'released' | 'archived';
  targetDate: string | null; // ISO 8601 date
  sortOrder: number; // display ordering
  /** Ship-date ground truth — set on the transition into 'released',
   *  cleared if the release is reopened. Anchors the forecast scorecard. */
  releasedAt: string | null;
  createdAt: string;
  /** Last write through updateVersion. Null for rows that predate the
   *  column (#331) — the change_events trail starts at the same point. */
  updatedAt?: string | null;
}

// ── Cycle / Sprint ──────────────────────────────────────────────

export interface Cycle {
  id: CycleId;
  mapId: MapId;
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
