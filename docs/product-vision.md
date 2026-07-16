# MindBlown — Product Vision

*A mindmap-based project management tool where ideas become plans.*

**The tool that makes you a good project manager without you noticing.**

---

## The Problem

Project planning happens in two phases that current tools treat as separate worlds:

1. **Thinking** — brainstorming, exploring structure, connecting ideas. This is visual, spatial, and messy. Mindmaps are the natural tool.
2. **Doing** — tracking tasks, assigning work, managing timelines. This is structured, sequential, and disciplined. Project management tools are the natural tool.

The transition between these phases is where every existing tool breaks down. You either:
- Brainstorm in a mindmap, then manually recreate everything in a PM tool (MindMeister + MeisterTask)
- Work in a PM tool that has a mindmap "view" that's too basic to think in (ClickUp, Wrike)
- Use a tool that tries to do both but compromises on one side (Ayoa: cluttered. Taskade: fake mindmap. XMind: no collaboration.)

Meanwhile, the best PM tools (Jira, Asana, Linear, Monday.com) have powerful execution engines but offer no visual thinking surface. You plan in your head, in a whiteboard, or in a separate tool — then transcribe into the PM tool. The creative planning phase is invisible to the execution system.

**MindBlown eliminates the gap.** A node starts as an idea. When you're ready, it becomes a task. Same node, same place, richer data. No export, no conversion, no second tool.

---

## Core Principles

### 1. The node is everything

A single data model. Every node in MindBlown is the same object whether you're looking at it in a mindmap, on a kanban board, in a Gantt chart, or in a list. There is no "convert to task" step. A node is born as an idea and grows into a task by accumulating properties.

This is what Taskade gets right architecturally, and what Notion proves with its database model — every database entry is a page, every page is an entry. We apply the same philosophy: every node is a potential task, every task is always a node.

### 2. Mindmap-first, not mindmap-only

The mindmap is the primary planning surface — where projects are born, structured, and understood at a glance. But the same data renders as kanban, Gantt, list, or table when you need those perspectives. The mindmap isn't a "view" bolted onto a PM tool. The PM features are capabilities that grow out of the map.

Like ClickUp's radical view polymorphism (15+ views, same data), but with the mindmap as the *origin* view, not an afterthought.

### 3. Gradual enrichment

Not every node needs to be a task. A brainstorming map might have 50 nodes and zero tasks — that's fine. When you're ready, you add a due date to a node. Now it's a task. Add an assignee. Now it's delegated. Add dependencies. Now it's part of a schedule. The transition is continuous, not a mode switch.

This is the critical gap in every competitor:
- Ayoa keeps mindmap and tasks as parallel structures
- MindMeister requires manual one-by-one conversion (notes don't carry over, completion doesn't sync back)
- ClickUp's Blank Mode has no connection to tasks until you explicitly convert
- Jira has no thinking phase at all — you start by creating a ticket

MindBlown should make enrichment feel like adding a sticky note to an idea on a whiteboard — natural, fast, non-disruptive.

### 4. Freeform spatial positioning

You can drag nodes wherever you want. The spatial arrangement carries meaning — proximity implies relatedness, clusters form naturally, important things go in the center. This is what makes a mindmap a mindmap, not an outline with lines drawn between items.

Taskade sacrifices this (auto-layout only). ClickUp's Blank Mode is a right-aligned tree. Even Ayoa constrains you to its organic branch structure. XMind gets closest — study their interaction model.

### 5. Speed is a feature

Linear proved that perceived speed is the single biggest driver of user love. Their local-first sync engine (data in IndexedDB, optimistic updates, background sync) makes every interaction feel instant. Jira's biggest complaint is slowness. Monday.com degrades at 500+ items.

MindBlown must feel fast at every interaction:
- Optimistic local updates — never wait for the server
- Instant view switching (< 200ms)
- Keyboard-first interaction for power users
- No spinners for common operations

### 6. Open source

No competitor in this space is open source (with real PM features). Plane proves that open-source PM tools can compete on UX. Freeplane proves mindmap extensibility is possible. Wisemapping proves web-based OSS mindmaps work. MindBlown combines all three.

This matters for:
- Self-hosting and data sovereignty
- Extensibility and customization
- Community-driven development
- Trust and transparency

### 7. The method is built in

Most projects are not run by trained project managers. They're run by developers, founders, designers, researchers — people who know *what* they want to build but were never taught how to plan and track it. The research on why such projects fail is remarkably consistent: no decomposition into small units, missing or never-calibrated estimates, vague done-criteria, and plans that are written once and never revisited.

MindBlown's answer is that **the defaults are the methodology**. Following the tool's grain — map the work, estimate the leaves, update progress, re-plan when the forecast slips — *is* textbook project management (work breakdown structure, bottom-up estimation, earned-value tracking, continuous re-planning), without the user ever needing to learn those terms.

Where defaults aren't enough, MindBlown **coaches — it never takes over**. Guidance means explainable checks and moment-of-action nudges, each teaching the principle it enforces in one sentence. It does not mean an AI that runs the project for you. (See "Guided Project Management" below.)

---

## The Planning Loop

This is the core workflow that MindBlown enables — the reason the tool exists.

### Step 1: Map out the work

You open a blank map and start brainstorming. "Website Redesign" in the center. Branches for "Design", "Frontend", "Backend", "Content", "Launch". Sub-branches for each. You're thinking visually, rearranging, grouping. Nothing about tasks yet — just structure.

At this point, MindBlown is a pure mindmap tool. No clutter, no forms, no fields.

### Step 2: Estimate at the leaves

When the structure feels right, you start estimating. You go to the leaf nodes — the actual work items — and add two things:

- **Effort estimate** — how long will this take? (hours, days, or story points)
- **% complete** — how far along is it? (0% if not started)

That's it. Two numbers per leaf.

**The magic: everything above auto-computes.** The parent node's estimate is the sum of its children's estimates. Its progress is the weighted average of its children's progress (weighted by effort — a 5-day task at 50% counts more than a 1-day task at 50%). This rolls up all the way to the root.

You glance at the root node and see: "Website Redesign — 47 days of work — 23% complete." That number came from the leaves. You never manually calculated anything.

```
Website Redesign [47d, 23%]
├── Design [12d, 75%]
│   ├── Wireframes [3d, 100%]        ← leaf: done
│   ├── Visual Design [5d, 80%]      ← leaf: almost done
│   └── Design System [4d, 25%]      ← leaf: early
├── Frontend [15d, 10%]
│   ├── Component Library [8d, 15%]  ← leaf: started
│   └── Page Templates [7d, 5%]     ← leaf: barely started
├── Backend [12d, 0%]
│   ├── API Endpoints [7d, 0%]      ← leaf: not started
│   └── Database Migration [5d, 0%] ← leaf: not started
└── Content [8d, 30%]
    ├── Copywriting [5d, 40%]       ← leaf: in progress
    └── Photography [3d, 10%]       ← leaf: early
```

This is what Mindomo does partially with "Roll up Subtasks" — but we make it the **central mechanic**, not a checkbox in settings.

### Step 3: Add dates and see the schedule

When you add start dates and assignees to the leaves, MindBlown computes the schedule:

- Given effort estimates, dependencies, and how many people are working in parallel → **projected end date**
- The Gantt view auto-generates from this data
- Dependency chains determine the critical path

You didn't fill out a Gantt chart. You brainstormed a mindmap, estimated the leaves, and the schedule emerged.

### Step 4: Track against the plan

As work progresses, people update their % complete on the leaves. MindBlown tells you:

**On the map itself:**
- Nodes color-shift based on health: on track (default), at risk (amber), behind (red)
- Progress rings on each node showing completion
- The branch color reflects the worst-performing child (one stuck task makes the whole branch amber)

**On the dashboard:**
- "At current pace, you'll finish on April 28" (projected from progress velocity)
- "You're 3 days behind the original plan" (baseline comparison)
- "Backend has 0% progress and starts in 2 days — at risk" (early warning)

**Hill Chart (optional):**
- Each major branch is a dot on the hill
- Left side (uphill) = "still figuring it out"
- Right side (downhill) = "executing"
- A dot that doesn't move = "stuck — needs attention"

### Step 5: Adjust and re-plan

When reality diverges from the plan (it always does), you go back to the mindmap. Add a branch. Remove one. Re-estimate a leaf. Split a too-large leaf into children. The schedule recalculates instantly.

The mindmap is the living plan. Not a document that gets stale. Not a Gantt chart that's painful to restructure. A visual, spatial, intuitive representation of the work that *computes its own status*.

### Why this matters

No existing tool does this loop well:
- **Jira/Asana/Linear**: No visual planning surface. You fill out ticket fields; the structure is flat lists grouped by sprint or status. No spatial thinking.
- **XMind/MindMeister**: Beautiful maps, but estimates and progress are just metadata — nothing computes, nothing rolls up, no schedule emerges.
- **MindManager**: Gets closest with Gantt derivation, but it's a $350/yr desktop app with no real-time collaboration.
- **Mindomo**: Has rollup and Gantt, but no health tracking, no projections, no "are we on track?"

MindBlown is the tool where you **think in a mindmap** and get a **project plan for free**.

---

## Guided Project Management

*The planning loop is the mechanism. This is the benefit: MindBlown makes you a good project manager without you noticing.*

### The gap we're filling

No tool today teaches project management in-product. The market splits into two failure poles:

- **Autopilot AI** — "the AI does the PM for you" (Height 2.0's autonomous PM: auto-triage, backlog grooming, health monitoring). Height shut down in 2025 despite heavy funding. Removing the human from planning removes the reason to engage with the plan.
- **Methodology for experts** — Linear's Method and Basecamp's Shape Up bake real opinions into the product, but both are written for already-competent, self-organized product teams. They assume you know why cycles, small batches, and appetite matter.

The open lane: **coach the untrained user**, at the moment they're about to make a known mistake, in language that teaches the principle. monday.com's Risk Insights comes closest (risk flags with explanations) but is enterprise-tier, portfolio-level, and diagnostic-only — it flags risk, it doesn't help you fix the plan.

### The failure modes we guard against

Decades of research (PMI Pulse, Standish CHAOS, planning-fallacy literature) reduce untrained-PM failure to a short chain:

1. **No decomposition** — work isn't broken into small units. Small projects with short iterations succeed dramatically more often; chunk size is the single strongest success lever.
2. **No estimates, or uncalibrated optimism** — the planning fallacy holds even when people *know* their history. The fix is reference-class forecasting: correct new estimates by observed past accuracy.
3. **Vague done-criteria** — inaccurate requirements are a primary cited cause in ~40% of failed projects.
4. **Publish-and-forget plans** — the plan is written once and never amended when reality diverges.

Every one of these has a computable signal in MindBlown's data model. That's the design insight: **guidance is mostly surfacing what the engine already knows.**

### The plan linter

Professional scheduling has had automated plan-quality checks for years (the DCMA 14-point assessment); nothing consumer-grade does. MindBlown ships a **plan linter**: a set of deterministic, explainable checks on plan hygiene — unestimated leaves, oversized chunks, stalled progress, overdue-but-never-replanned tasks, estimates contradicted by the user's own history. Each finding carries a one-sentence *why* and a one-click fix path.

See [docs/plan-linter.md](plan-linter.md) for the v1 specification.

### How guidance works: five layers

From most passive to most active — and in roughly this ship order:

1. **The rails.** The data model itself prevents the classic mistakes: estimates live only on leaves, parents compute themselves. The wrong math is impossible, not warned about. (Already built — and worth protecting: manual parent overrides would break the pedagogy, not just the math.)
2. **Empty states that teach.** Every derived view explains what feeds it when it has nothing to show. An empty Gantt doesn't render a blank grid; it says "I build myself from estimates and a start date — you have 12 unestimated leaves, start there." Guidance that only exists at the moment it's wanted, with zero annoyance cost.
3. **The compass.** The map's own data reveals which phase of the planning loop a project is in (brainstorming → estimating → scheduling → executing → re-planning → done). The tool offers exactly **one next action** for that phase, dismissible, never a checklist. During brainstorming it stays silent — asking for estimates mid-braindump is the wizard mistake.
4. **The re-plan moment.** The one place the tool actively interrupts: the forecast just slipped past the target. Not a red "you're behind" banner — a structured decision: descope (here are the lowest-priority unstarted leaves), split and defer, or move the target, each option simulated so the user sees the consequence before committing. This is the moment an untrained person becomes a project manager.
5. **Graduation.** Nudges taper once the habit is observed — a user who estimates new leaves unprompted stops being asked. The tool succeeds when it goes quiet. (This is what separates a coach from Clippy, and it gives guidance an honest success metric: time until silence.)

All five layers speak **as the plan, about the plan** ("Backend starts in 2 days at 0% with nobody assigned") — never as the tool about methodology ("Tip: estimation matters!"). The user should feel the project talking to them, not a tutorial. That's the "without you noticing" in the tagline, mechanically.

### Guidance design rules

1. **Moment of action, not upfront wizards.** Prompt for an estimate when a node becomes a leaf; prompt a re-plan when the forecast slips. Never a multi-step project-setup wizard — onboarding research is unambiguous that wizards fatigue and get abandoned.
2. **Every nudge teaches its own why, in one sentence.** "Break this down — smaller pieces get estimated far more accurately" beats a bare warning. Users absorb PM practice by osmosis; that's the point.
3. **Quiet by default, dismissible forever.** Guidance lives in a pull-based plan-health surface plus a very small set of pushed nudges. Dismissed findings stay dismissed. The failure mode to avoid is Clippy / notification flood.
4. **Deterministic first, AI optional.** The linter is rule-based on computed data. AI features (suggest a breakdown, draft estimates) can accelerate the *fix*, but the guidance mechanism itself never depends on a model.
5. **If it needs a manual, it's wrong.** The target user is, by definition, someone who won't read one. The user-facing vocabulary stays tiny — node, estimate, % done, due date; everything else (rollup, critical path, health, calibration) is *output*, never something the user must understand to operate the tool. PM concepts are hidden behind their consequences: nobody needs to learn what "critical path" means when the tool says "this task is the one holding up your finish date." The acceptance test is literal: hand MindBlown to someone with zero instructions; they reach a useful map in 30 seconds and a finish date without help.

### Coach, not autopilot

The user stays the project manager. MindBlown's job is to make them a better one each week they use it — until the nudges stop firing because the habits stuck.

---

## What We Build

### Phase 1: The Mindmap Editor

A fast, fluid, beautiful mindmap editor that feels as good as XMind but runs in the browser.

**Node operations:**
- Create, edit, delete nodes with keyboard shortcuts
- Drag nodes to any position (freeform) or snap to auto-layout (structured)
- Collapse/expand subtrees
- Multi-select and bulk operations
- Rich text in nodes (bold, italic, links)
- Color, icons, and visual markers
- Resize nodes
- Undo/redo

**Map operations:**
- Zoom and pan (smooth, performant)
- Focus mode: zoom into a subtree and hide everything else
- Multiple layout algorithms: radial, tree (left-to-right, top-down), org chart
- Connection lines between non-adjacent nodes (cross-links)
- Auto-layout with manual override (position a node freely, and it stays there)

**Keyboard-first design (learned from Linear):**
- Single-key actions: `Tab` create child, `Enter` create sibling, `Delete` remove, `Space` expand/collapse
- `Cmd/Ctrl+K` command palette — jump to any node, run any action
- Every action reachable via button, keyboard shortcut, context menu, or command palette
- Contextual hints: hovering shows the shortcut, training muscle memory passively

**Quick add (learned from Todoist):**
- `Q` opens quick-add from anywhere — type a node name, optional properties inline
- Natural language parsing: "Design homepage due Friday p1 @sarah" creates a node with parsed properties
- Zero-friction path from thought to tracked work

**Performance target:** Smooth interaction with 500+ nodes. Mindmaps becoming unwieldy at 50-100 nodes is the #1 complaint across Ayoa, ClickUp, and XMind.

### Phase 2: Estimation, Progress, and Task Properties

The two most important properties in MindBlown — the ones that power the entire planning loop:

**1. Effort estimate (leaf nodes)**
- Set on leaf nodes: how long will this work take?
- Units: hours, days, or story points (configurable per map)
- Parent nodes auto-sum their children's estimates — you never estimate a parent manually
- Changing the tree structure (adding/removing/moving leaves) instantly recalculates all ancestors

**2. % Complete (leaf nodes)**
- Set on leaf nodes: how far along is this work?
- 0–100%, updated by the person doing the work
- Parent nodes compute weighted progress: `sum(child.estimate * child.progress) / sum(child.estimate)`
- A 5-day task at 50% contributes more to parent progress than a 1-day task at 50%
- Rolls up all the way to the root — one glance tells you where the whole project stands

**Auto-computed health signals (on every node):**
- **On track** (default) — progress is proportional to elapsed time
- **At risk** (amber) — progress is falling behind, or a child is at risk
- **Behind** (red) — significantly behind schedule, or a child is behind
- Health propagates upward: one stuck leaf makes its entire branch amber/red

**Additional task properties (gradual enrichment):**
- **Status:** Todo / In Progress / Done (customizable workflow states)
- **Assignee:** One or more people
- **Due date:** With start date optional for duration-based planning
- **Priority:** P0–P3 (or customizable levels)
- **Tags/Labels:** Color-coded, for categorization and cross-cutting filtering
- **Description/Notes:** Rich text attached to the node — every node is also a page (like Notion)
- **Custom fields:** Text, number, date, select, multi-select, person, checkbox, URL (learned from Asana/Monday.com — but governed: don't let fields sprawl like Jira)

**Filtering and focus:**
- Filter map to show only nodes matching criteria (assignee, status, priority, due date)
- Dim non-matching nodes instead of hiding them (preserve spatial context)
- Quick filters: "My tasks", "Overdue", "Due this week"
- Saved custom filters (like Linear's custom views)
- Compound AND/OR filter logic (like Notion's database filters)

**Conditional styling:**
- Automatic visual changes based on properties (overdue = red border, done = faded, high priority = bold)
- Borrowed from Freeplane's conditional styling model, but with a modern UI

**Computed properties (learned from Notion):**
- Formula fields that reference other properties: progress bars, overdue flags, days-until-deadline
- Rollups that aggregate child node data: total effort, completion percentage, date ranges
- Keep it simpler than Notion's formula language — cover 80% of use cases with a visual builder

### Phase 3: Alternative Views

Same data, different lenses. Switching views is instant — no data transformation, no sync.

**Kanban board:**
- Columns = statuses (or any grouping property — priority, assignee, tag)
- Cards = nodes with task properties
- Drag between columns to change status
- Show parent context on cards (which branch of the mindmap does this task belong to?)
- WIP limits per column (learned from Jira's Kanban — surfaces bottlenecks)
- Swimlanes for a second grouping dimension (learned from Monday.com)

**List/Table view:**
- Spreadsheet-like, sortable, filterable, groupable
- Custom columns for any property
- Inline editing of all fields
- Bulk operations (assign 10 tasks at once)
- Sub-grouping support (like Notion's grouped views)

**Gantt/Timeline:**
- Auto-generated from nodes with dates
- Drag to reschedule
- Dependency arrows between tasks
- Duration bars showing start → end
- Today line
- Zoom: day / week / month / quarter
- **Baselining** (learned from Asana): snapshot the original plan, show variance against actual progress
- **Auto-rescheduling** on dependency changes (learned from Mindomo and MindManager)

**Calendar view:**
- Tasks on a calendar by due date (day/week/month)
- Drag to reschedule

All views maintain the hierarchical context from the mindmap. A task on the kanban board shows its parent branch. A bar on the Gantt shows which subtree it belongs to. This is what no PM tool does well — they lose the "why" (the strategic context) when showing the "what" (the task).

### Phase 4: Dependencies and Scheduling

**Dependency types** (all four, like MindManager, XMind, and Asana):
- Finish-to-Start (most common)
- Start-to-Start
- Finish-to-Finish
- Start-to-Finish

**Dependencies that enforce behavior** (learned from Jira's mistake):
Jira's "Blocks / Is blocked by" links are purely informational — nothing prevents you from completing a blocked task. MindBlown dependencies are real constraints:
- Visual warnings when you try to start a blocked task
- Optional hard enforcement (configurable per project)
- Blocked tasks show a clear banner with what they're waiting on

**Automatic rescheduling:** When a task's dates change, downstream dependent tasks shift automatically (like Mindomo and MindManager).

**Critical path:** Highlight the chain of dependent tasks that determines the project's minimum duration. Only MindManager and Monday.com do this today — bringing it to an open-source web tool would be a significant differentiator.

**Dependency visualization:**
- In mindmap view: subtle dotted lines between dependent nodes
- In Gantt view: arrows between bars (standard)
- In list view: "Blocked by" / "Blocks" columns

### Phase 5: Collaboration

**Real-time co-editing:**
- Multiple users editing the same map simultaneously
- Cursor presence (see where others are working)
- Conflict resolution for concurrent edits to the same node

**Sharing and permissions:**
- Share maps with view/edit/admin permissions
- Public links for read-only sharing
- Team workspaces

**Activity:**
- Change history per node (who changed what, when) — full audit trail like Jira
- Comments on nodes (with inline editing — Asana's lack of comment editing is a top complaint)
- @mentions and notifications
- Notification controls that don't overwhelm (Asana's #4 complaint is notification overload)

**Triage workflow (learned from Linear):**
- Incoming items (from integrations, email, shared links) land in a triage inbox
- Items sit in triage until explicitly accepted into the map or dismissed
- Separates "incoming noise" from "committed work" — a powerful concept for teams

### Phase 6: Advanced PM Features

**Schedule projection and tracking:**
- **Projected completion date**: given estimates, progress velocity, dependencies, and team capacity → "At current pace, you'll finish on April 28"
- **Baseline comparison**: snapshot the plan at a point in time, show drift: "You're 3 days behind the original plan"
- **Early warnings**: "Backend has 0% progress and starts in 2 days" — flag branches that need attention before they become critical
- **Velocity tracking**: measure progress rate over time, use it to project forward (not sprint-based like Jira — continuous, based on actual % complete changes)

**Cross-map views (learned from Asana Portfolios and ClickUp):**
- "My Work" dashboard: all tasks assigned to me across all maps
- Portfolio view: see status and health of all projects at a glance — each project shows its root node's computed estimate, progress, and health signal
- Cross-project search and filtering

**Progress visualization (learned from Basecamp's Hill Charts):**
- Hill Charts: each major branch is a dot on a hill — left side = "figuring it out" (uncertainty), right side = "making it happen" (execution)
- A dot that doesn't move is a raised hand — surfaces stuck work without status meetings
- Captures *uncertainty*, not just completion percentage. "50% done" means nothing; "still figuring out the approach" means everything.
- This fits perfectly with our mindmap-first philosophy — brainstorming is the uphill, execution is the downhill

**Workload view (learned from Asana and Monday.com):**
- See each team member's load across maps (computed from effort estimates on assigned leaves)
- Color-coded capacity bars (under/at/over capacity)
- Measure by task count, effort points, or time
- Drag to reassign directly from workload view

**Automation (learned from Jira, Asana, Monday.com):**
- Trigger → Condition → Action rules
- Common triggers: status change, date approaching, assignment change
- Common actions: move to group, assign, notify, change property
- Keep it simple — Linear's auto-close and auto-rollover patterns cover 80% of needs without a complex rule builder
- Natural language rule creation (like Monday.com's AI builder): "When a task is marked done, notify the assignee of its parent"

**Templates:**
- Pre-built map structures for common project types (sprint planning, product launch, event planning, OKR tracking)
- Database templates per node type (like Notion): a "Bug" template pre-fills priority, severity, and steps-to-reproduce fields

**Versions, Milestones, and Sprints:**

Release planning uses three layered concepts — versions, milestones, and sprints — that are first-class entities separate from the mindmap tree structure.

*Versions:*
- A version is a release container (e.g. "V1", "V2", "1.0"). It groups milestones and sprints into a coherent release.
- Versions have a status lifecycle: planning → active → released → archived.
- Nodes can be tagged with a target version — "this feature ships in V2."
- The mindmap tree is organized by **functional area** (what it does), while versions track **when it ships**. These are orthogonal dimensions.

*Milestones:*
- A milestone is a key deliverable within a version (e.g. "Kernsystem MVP", "Billing Module Complete").
- Milestones are first-class entities — not just a boolean flag on a node. They have their own name, status, target date, and linked nodes.
- Nodes can be linked to a milestone — "this task contributes to the Billing milestone."
- Milestone progress is computed from linked nodes: weighted average of effort × progress.
- Milestones appear as diamonds on the Gantt, markers on the calendar.
- Useful for stakeholder communication: "We'll hit the Billing milestone by April 15."

*Sprints / Cycles (optional, not required):*
- Define time-boxed cycles (1–4 weeks) within a version
- Assign leaf nodes to a cycle — "this work happens in Sprint 3 of V1"
- Sprint view: filter the map/kanban/list to show only the current cycle's work
- Auto-rollover: unfinished items move to the next cycle automatically (learned from Linear)
- Sprint progress: computed from the leaf estimates and % complete within the cycle
- **Not mandatory.** Teams that don't do sprints simply don't use this. The planning loop works without it — cycles are an overlay, not the foundation.

*The key insight:* The mindmap tree represents **what** (functional structure), while versions represent **when** (release planning). A node lives in a functional branch (e.g. "Compliance > Data Retention") AND can be tagged with a version (V1), milestone (Kernsystem MVP), and sprint (Sprint 3). These are independent, orthogonal dimensions — not competing organizational schemes.

This is the balance: we're not Jira (no burndown charts, no velocity per sprint, no sprint ceremonies). But teams that work in iterations can use MindBlown for sprint planning by selecting which branches/leaves go into each cycle.

**Ticket system integration:**

MindBlown lives alongside your existing issue tracker, not instead of it. The mindmap is the planning layer; the ticket system is the execution layer.

*GitHub Issues (primary integration):*
- **Bidirectional sync**: a leaf node in MindBlown can be linked to a GitHub Issue. Status, assignee, and labels sync both ways.
- **Auto-create**: promote a leaf node to a GitHub Issue with one click — title, description, labels, and assignee carry over
- **Auto-update % complete**: when a linked GitHub Issue is closed, the leaf's progress goes to 100%. When a linked PR is merged, progress updates. This flows up through the rollup automatically.
- **Import existing issues**: pull GitHub Issues into the map as nodes, organizing them spatially. Turn a flat backlog into a structured plan.
- **PR linking**: link branches/PRs to nodes. See development status directly on the map — "this node has an open PR with 2 approvals."
- **GitHub Projects integration**: sync with GitHub Projects boards for teams already using them

*Other integrations (later):*
- **Jira**: import epics/stories into map hierarchy. Bidirectional sync of status and progress.
- **Linear**: sync issues and projects. Map Linear's hierarchy (Initiative → Project → Issue) to MindBlown's tree.
- **GitLab Issues**: same model as GitHub integration.
- **Generic webhook**: for any ticket system — push/pull status updates via API.

*The key design decision:* MindBlown is the **planning and tracking layer**. You think in the mindmap, see the big picture, track progress. The ticket system is where developers pick up individual tasks, write code, submit PRs. The sync keeps both in agreement without manual updates.

For solo developers or small teams, MindBlown alone may be enough — no external ticket system needed. For teams with an established GitHub/Jira workflow, MindBlown adds the visual planning layer they're missing.

**Import/Export:**
- Import from XMind, FreeMind/Freeplane, MindMeister, OPML
- Import from GitHub Issues, Jira, Linear (map to tree hierarchy)
- Export to CSV, JSON, ICS, PDF, PNG, GitHub Issues

**API and extensibility:**
- REST/GraphQL API for integrations
- Webhooks for event-driven automation
- Plugin system for community extensions (learned from Freeplane's add-on ecosystem, but with a modern web API)

**Calendar sync:**
- Bidirectional sync with Google Calendar, Outlook
- Learn from Taskade's unreliable implementation — do it right or don't do it

---

## What We Don't Build (Scope Boundaries)

- **Not a full agile suite.** We support lightweight sprints/cycles and milestones, but we don't replicate Jira's sprint ceremonies, burndown charts, or story point velocity tracking. The planning loop (estimate → track → project) is our alternative to agile rituals.
- **Not a whiteboard.** No sticky notes, no freeform drawing, no infinite canvas with arbitrary shapes. We're a structured mindmap with PM capabilities.
- **Not a document editor.** Nodes have rich text descriptions (every node is a mini-page), but we're not building Notion or Google Docs. No inline databases, no wiki.
- **Not an AI-first tool.** Taskade has pivoted hard to AI. We focus on the core interaction model. AI features (auto-suggest structure, generate subtasks, natural language filtering) can come later as enhancements, not as the product identity.
- **Not infinitely configurable.** Jira's biggest weakness is configuration complexity and field sprawl. We ship opinionated defaults (learned from Linear). Customization is available but not required. If it takes an admin to set up, we've failed.

---

## Lessons from the Best PM Tools

What we studied and what we're taking:

### From Linear — Speed and Opinion
- **Local-first sync engine**: data in browser IndexedDB, optimistic updates, background server sync. Network latency removed from the interaction path.
- **Keyboard-first with command palette**: single-key actions, `Cmd+K` for everything, contextual shortcut hints.
- **Opinionated defaults**: sensible status workflows out of the box. No configuration required to be productive.
- **Triage inbox**: clean separation between incoming and committed work.
- **What we skip**: Linear's lack of custom fields is their top complaint. We need custom fields — but governed.

### From Jira — Workflow Depth
- **Customizable workflows**: statuses, transitions, conditions, validators. Different issue types can have different workflows.
- **JQL-like querying**: powerful filtering for power users.
- **Rich reporting**: burndown, velocity, cumulative flow — real agile metrics.
- **What we skip**: Jira's configuration complexity, UI churn, and performance issues are cautionary tales. Dependencies that don't enforce behavior are useless.

### From Asana — Cross-Project Visibility
- **Multi-homing**: a task can live in multiple projects simultaneously. Powerful for cross-cutting concerns.
- **Portfolios**: high-level project status across the organization.
- **Workload management**: capacity bars showing who's overloaded.
- **All 4 dependency types** with actual date enforcement.
- **Gantt with baselining**: snapshot the plan, show drift.
- **What we skip**: single-assignee-only is controversial. Notification overload is their #4 complaint.

### From Monday.com — Visual Appeal
- **Color-coded everything**: statuses, priorities, tags — visual scanning is instant.
- **Dashboard widgets**: 50+ widget types for building custom views.
- **Button columns**: click a button, trigger an automation. Brilliant for ad-hoc workflows.
- **AI automation builder**: describe rules in natural language.
- **What we skip**: pricing model (3-seat minimum, bucket pricing) is universally hated. Feature paywalling destroys trust.

### From Notion — Data Model Flexibility
- **Every entry is a page**: rich content inside every item, not just metadata fields.
- **Relations and rollups**: lightweight relational database without SQL.
- **Formulas 2.0**: computed properties that can traverse relations.
- **Progressive disclosure**: hover-to-reveal, slash commands, minimal default state.
- **What we skip**: "blank canvas problem" — too much flexibility = setup tax. We ship with structure.

### From Basecamp — Honest Progress
- **Hill Charts**: visualize uncertainty, not just completion. The uphill is figuring it out; the downhill is executing.
- **What we skip**: Basecamp is opinionated to the point of rigidity. We need more flexibility.

### From Todoist — Frictionless Capture
- **Natural language quick add**: type a sentence, get a structured task. Zero friction from thought to tracked work.

### From Plane — Open Source PM
- **Proof that OSS PM tools can have great UX**: clean, Linear-inspired interface.
- **Integrated pages/wiki alongside work items**: context lives with the work.
- **All features on free tier**: no artificial restrictions in community edition.

### From Shortcut — Developer Experience
- **Git integration that actually works**: auto-link branches/PRs/commits to issues.
- **Fast onboarding**: "within a morning, teams were up and running."
- **Cross-team epics**: large initiatives can span teams without friction.

---

## Design Principles for the UI

### Our UX north star: Progressive disclosure

A new user opens MindBlown and sees a clean mindmap editor. Nothing about tasks, Gantt charts, or dependencies until they need it. Double-click a node to edit. Tab to create a child. Enter to create a sibling. That's it — you're productive in 10 seconds.

Task properties appear when you hover a node and click "+". Alternative views appear in a minimal sidebar. Dependencies appear when you option-drag between nodes. The power is there but it stays out of the way until invited.

This is Notion's core UI philosophy applied to mindmapping: **hide complexity until the user needs it, then make it one click away.**

### What to emulate:

- **Linear's speed** — every interaction feels instant, no spinners, optimistic updates
- **XMind's visual polish** — clean themes, smooth animations, maps that look good without effort
- **Notion's progressive disclosure** — hover to reveal, slash commands, minimal default state
- **Taskade's view switching** — instant, seamless, same data
- **Mindomo's node enrichment** — task properties feel like part of the node, not a separate dialog
- **Monday.com's color language** — visual scanning through consistent color-coding
- **Todoist's quick capture** — natural language, zero friction

### What to avoid:

- **Jira's configuration hell** — needing an admin to set up anything. Workflows that require a certification to understand.
- **Ayoa's cluttered UI** — trying to show everything at once
- **ClickUp's overwhelming feature set** — 15+ views, settings everywhere, hard to focus
- **MindMeister's conversion friction** — one topic at a time, notes lost, no sync back
- **Taskade's fake mindmap** — auto-layout tree is not a mindmap
- **MindManager's enterprise feel** — powerful but dated, steep learning curve
- **Freeplane's 2005 aesthetics** — powerful internals, hostile UI
- **Asana's notification flood** — drowning users in emails by default
- **Monday.com's pricing tricks** — seat minimums, bucket pricing, feature paywalling

---

## Success Metrics

For the first release:

1. **Time to first useful map:** Under 30 seconds from opening the app
2. **Mindmap quality:** Comparable to XMind in look and feel
3. **Task transition:** Enriching a node with task properties takes < 3 clicks
4. **Performance:** 500+ nodes without lag
5. **View switching:** Instant (< 200ms) between mindmap, kanban, list
6. **Onboarding:** Productive in 10 seconds, no configuration required (learned from Linear and Shortcut)

For the long term:

1. **Adoption:** Become the default recommendation for "open-source mindmap + PM tool"
2. **Completeness:** Cover the brainstorm-to-execute workflow end-to-end without needing a second tool
3. **Community:** Active contributors building plugins, templates, and integrations
4. **Speed:** Never slower than Linear for common operations

---

*This document is the north star. Implementation details, tech stack, and architecture decisions live in separate documents.*
