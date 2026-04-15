# MindBlown AI Agent Primer

Audience: an LLM loading cold via the MindBlown MCP server.
Goal: get oriented fast and stop making the common mistakes.
Version: v0.7.0 (2026-04-15).

For deeper reference see:

- [CLAUDE.md](../CLAUDE.md) -- project conventions, principles, agent roster
- [docs/mcp-guide.md](mcp-guide.md) -- full tool catalog, setup, example dialogs
- [docs/architecture/data-model.md](architecture/data-model.md) -- entity reference
- [packages/core/src/types.ts](../packages/core/src/types.ts) -- canonical types
- [packages/core/src/compute.ts](../packages/core/src/compute.ts) -- rollup + health code

## 1. What MindBlown is

A mindmap-based project management tool. The mindmap IS the plan. Every
node IS a task -- no "convert to task" step. A node starts as a text label
and gets enriched gradually: estimate, progress, status, dates, assignees,
dependencies, version/milestone/sprint tags. Leaf nodes hold the raw inputs
(estimate, percent complete). Parent nodes auto-compute effort, progress,
and health by rolling up from their descendants. Views (Gantt, Kanban,
List, Calendar, Workload) are derived from the same node tree.

## 2. Core entities

| Entity | What it is | Created via |
|---|---|---|
| Map | A project. Has exactly one root node, a tree under it, an effort unit, and a status workflow. | `create_map` |
| Node | The universal unit. Idea, epic, task, bug, checkpoint -- all nodes. Lives at one position in one tree. | `create_node` |
| Version | Release container (V1, V2). Separate entity, NOT a tree node. | `create_version` |
| Milestone | Key deliverable within a version. First-class entity, not a node flag. | `create_milestone` |
| Cycle (Sprint) | Time-boxed iteration. Optional. Can belong to a version. | `create_cycle` |
| Dependency | Edge between two nodes. Types: FS, SS, FF, SF. Has a lag. Feeds the critical path scheduler. | `add_dependency` |

### Leaf vs parent nodes -- the rollup distinction

This is the most important concept. A leaf is a node with zero children;
a parent is any node with one or more children.

- Leaves own `effortEstimate`, `percentComplete`, `actualEffort`, `startDate`,
  `dueDate`. These are the raw inputs.
- Parents compute `computedEffort`, `computedProgress`, `healthSignal`
  on read. They do not persist these fields.
- Converting a leaf to a parent (by adding a child) causes its estimate to
  stop being used as input -- the rollup replaces it. This is by design.

### Versions, milestones, sprints are orthogonal to the tree

The tree is organized by functional area (Auth, Billing, Compliance).
Release planning is metadata on nodes:

- `node.versionId` -- ships in this release
- `node.milestoneId` -- contributes to this milestone
- `node.cycleId` -- being worked on in this sprint

A node at any tree position can be tagged with any combination.
Never reorganize the tree by version. Never `create_node` named "V1".

## 3. Invariants you must respect

1. **Estimates and progress only on leaves.** `set_estimate` and
   `set_progress` refuse to operate on a parent node and return an error
   explaining this. Parents get their numbers from the rollup.

2. **Weighted rollup formula.** Parent progress =
   `sum(child.computedEffort * child.computedProgress) / sum(child.computedEffort)`.
   If total effort is 0, progress is 0. A parent with unestimated leaves
   reports 0% done even if you set statuses on them.

3. **Health is worst-child-wins.** Propagation short-circuits: one `behind`
   leaf turns every ancestor `behind`. One `at_risk` leaf turns ancestors
   `at_risk` unless something worse is also present. A green parent still
   needs to be inspected by leaf -- see `risk_scan`, `ai_standup`, or the
   `mindblown://maps/{mapId}/health` resource.

4. **Leaf health rule.** Computed from `percentComplete` vs elapsed time
   between `startDate` (falls back to `createdAt`) and `dueDate`. If
   `elapsedRatio - progressRatio > threshold` (default 0.2), status is
   `at_risk`. Past `dueDate` with progress < 100 is `behind`. No `dueDate`
   means `on_track` (no deadline, cannot be late).

5. **Milestone nodes contribute zero effort.** `node.isMilestone = true`
   makes `computeEffort` return 0 even if an estimate is set.

6. **`update_node` field semantics.** Omitted fields are not changed. To
   clear a field explicitly, pass `null` (e.g. clear an assignee with
   `{ assigneeIds: [] }`, clear a date with `{ dueDate: null }`).

7. **`delete_node` deletes the whole subtree.** Not just the node. There
   is no soft-delete and no undo via MCP.

8. **`search_nodes` is a substring match** on `text` + `description`.
   `semantic_search` is embedding-based ranking and handles concept
   queries. Pick based on intent.

9. **`get_schedule` uses critical path + velocity.** The scheduler runs on
   dependency edges, leaf effort, and lag. Velocity comes from
   `completion_forecast`, which reads the planned-vs-actual fudge factor
   from `get_estimation_accuracy`.

10. **GitHub integration is authoritative.** If a task exists as a GitHub
    issue, use `import_github_issues` or `link_github_issue`. Do NOT
    `create_node` -- the unlinked copy will not sync. GitHub milestones
    auto-convert to MindBlown versions + milestones on import.

## 4. Typical tool sequences

| User intent | Sequence |
|---|---|
| "What is the status of project Foo?" | `list_maps` (find id) -> `get_map` -> optionally read `mindblown://maps/{mapId}/health` resource, or call `ai_standup` / `status_digest` |
| "How at-risk are we?" | `risk_scan` -> `get_schedule` -> `completion_forecast` |
| "How much work is left?" | `remaining_work` (scope with `nodeId`, `versionId`, or `milestoneId`) |
| "When will it be done?" | `completion_forecast` (scope same as above) |
| "Break this task down" | `ai_breakdown` with `apply=false` to preview, or `apply=true` to one-shot |
| "I have a brain dump, make it a plan" | `ai_braindump` (apply flag same as above) |
| "Estimate this leaf" | `ai_estimate` (calibrated -- uses historical planned-vs-actual samples) |
| "Find tasks about X" | `semantic_search` for concept queries, `search_nodes` for substring |
| "Plan a sprint" | `list_cycles` -> `create_cycle` -> `search_nodes` / `get_map` to pick nodes -> `bulk_assign_to_sprint` |
| "Set up release V2" | `create_version` -> `create_milestone` (pass the new versionId) -> `update_node` or `bulk_assign_to_version` on relevant leaves |
| "What shipped this week?" | `status_digest` or `change_history` (filter by time window) |
| "Did we overrun the estimate?" | `get_estimation_accuracy` (overall fudge factor + per-node detail) |
| "Am I above WIP limit?" | `get_wip_status` |
| "What if we cut X?" | `scope_simulate` with a patch list -- in-memory, no persistence |
| "Write a standup" | `ai_standup` |
| "Send me an alert digest" | `alert_digest` -- returns markdown, nothing to send if no alerts |
| "Burn-up trend" | `burnup` (flow through a time window from change_events) |
| "Import from GitHub" | `connect_github_repo` -> `import_github_issues` |
| "Promote this node to a GitHub issue" | `create_github_issue_from_node` |

## 5. AI tools (new in v0.7.0) -- when to reach for them

- **`ai_breakdown`** -- LLM suggests child tasks for a target node. Good
  for "this epic is too big, decompose it". Has `apply` flag: `false` returns
  suggestions only, `true` creates them as children in one shot. Prefer
  preview-first when the user is still thinking.

- **`ai_braindump`** -- Turns freeform prose (meeting notes, spec draft)
  into a nested tree and attaches it under an existing parent. Strips
  numbering, writes imperative labels, groups related ideas. Same `apply`
  flag as ai_breakdown.

- **`ai_estimate`** -- Produces a calibrated effort estimate. Pulls up to
  30 recently completed leaves with both estimate and actual, applies the
  velocity fudge factor from historical accuracy, and returns a number in
  the same calibrated space as `get_schedule`. Accepts either `text`
  (freeform) or `nodeId` (uses that node's title + description + ancestor
  path). Prefer this over asking the LLM directly -- the calibration
  matters.

- **`semantic_search`** -- Cosine similarity ranking over pre-computed
  jsonb embeddings of node title + description. Returns nodes ordered by
  relevance. Use for "find tasks related to billing edge cases" where
  `search_nodes` would miss. Nodes without an embedding are silently
  skipped.

- **`ai_standup`** -- Three-section narrative over recent activity:
  Done / In progress / Blockers. Aggregates recently changed leaves,
  currently in-progress leaves, and behind/blocked leaves within a
  look-back window, then has the LLM write the narrative. Uses `computeTree`
  for health signals.

## 6. Pitfalls and failure modes

- Creating a "V1" node in the tree instead of calling `create_version`.
  The tree node will not function as a version anywhere.
- Calling `set_estimate` or `set_progress` on a parent node. The tool
  returns an error; the action is a no-op.
- `delete_node` on a parent wipes the entire subtree. Confirm intent
  before calling.
- Using `search_nodes` for a conceptual query ("authentication edge cases")
  and getting nothing because the literal substring is not present. Use
  `semantic_search`.
- Reporting status from a green parent without inspecting leaves. A parent
  can be `on_track` and still have one child that was just created with
  no dueDate. For real status, use `risk_scan` or the health resource.
- Calling `ai_breakdown` / `ai_braindump` with `apply=true` when the user
  wanted to review suggestions first. Preview by default when unclear.
- Adding an estimate to a leaf then adding a child to it -- the estimate
  is now dead input, replaced by the rollup.
- Creating a fresh node for a task that already exists as a linked
  GitHub issue. Use `link_github_issue` or `import_github_issues`.
- Forgetting `update_node` omitted fields are not changed. To wipe an
  assignee, pass `assigneeIds: []`; do not omit the field.
- Assuming `change_history` / `burnup` covers all time. They only include
  events since the change_events feature shipped.
- Scoping `get_schedule` by `versionId` without noticing the
  `crossVersionDependencies` result -- those are edges the scheduler had
  to ignore.

## 7. Resources (MCP read-side)

Alongside tools the server exposes resources under the `mindblown://` scheme:

- `mindblown://maps/{mapId}` -- full map tree with computed fields
- `mindblown://maps/{mapId}/health` -- health rollup report
- `mindblown://maps/{mapId}/schedule` -- computed schedule + critical path
- `mindblown://maps/{mapId}/sprints` -- sprint overview
- `mindblown://nodes/{nodeId}` -- single-node detail

For conversational "tell me about this map" queries, reading a resource
is often lighter than calling `get_map` + formatting yourself.
