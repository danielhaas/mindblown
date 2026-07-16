# Market Research: Mindmap-Based Project Management Tools

*Last updated: 2026-04-04*

---

## Executive Summary

The market for tools combining mindmapping with task/project management is fragmented. Most solutions either bolt task features onto a mindmap tool or add a mindmap view to a PM tool — neither side feels first-class. There is **no mature open-source tool** in this space, which represents the clearest opportunity.

The closest commercial competitors are **Ayoa** (tight integration, good mindmap) and **Taskade** (same-data multi-view, but weak mindmap UX). Enterprise players like **ClickUp** and **Wrike** offer mindmap views but treat them as secondary.

---

## Detailed Competitor Profiles

### 1. Ayoa

> Formerly iMindMap (Tony Buzan) + DropTask, merged into one product.

| | |
|---|---|
| **Website** | [ayoa.com](https://www.ayoa.com/) |
| **Pricing** | [ayoa.com/pricing](https://www.ayoa.com/pricing/) — Freemium. Free tier limited. Pro ~$10/mo, Ultimate ~$13/mo |
| **Features** | [ayoa.com/features](https://www.ayoa.com/features/) |
| **Target** | Creative professionals, teams who brainstorm visually |

**What they do well:**
- Organic, hand-drawn-style mindmaps (inherited from iMindMap) — visually distinctive
- Tight integration: mindmap nodes can become tasks with status, assignees, due dates
- Multiple views: mindmap, kanban board, Gantt chart, whiteboard — all within one app
- Real-time collaboration

**What they don't do well:**
- UI feels cluttered — trying to do too much in one interface
- Performance degrades with large maps (50+ nodes gets sluggish)
- The organic/curved branch style is polarizing — looks great but wastes space
- Pricing has crept up since the merger
- No API / no extensibility

#### PM & Planning Deep Dive

**Three task board views:**

1. **Canvas View** — Tasks as circles grouped in category circles. Side panel with assignee, dates, completion %, notes, comments. Progress shows as a ring around the circle.
2. **Workflow View (Kanban)** — Kanban board with horizontal bars showing start/end dates. Drag to adjust dates and set task dependencies. A simplified Gantt-kanban hybrid.
3. **Gantt Timeline View** — Timeline with dependencies, milestones, start/end dates. Drag-and-drop scheduling.

**Mindmap → Task workflow:**
Mindmaps and task boards are **linked but separate**. While in a mindmap, a **task panel** pops up on the side where you can create tasks, attach a dedicated task board, and assign people. However, **mindmap branches don't automatically become tasks** — you create tasks alongside the map, not from the nodes themselves. Users consistently report this as a friction point.

**Additional planning features:**
- "Now, Next, Soon" priority scheduling that converts into Gantt view
- My Calendar view consolidating tasks from all boards
- Daily summary emails for upcoming deadlines
- Filter tasks by assignee, keywords, and status

**What's missing:**
- No resource allocation or budget tracking
- No sophisticated dependency management (basic only)
- No critical path analysis
- No reporting/analytics dashboards
- The mindmap-to-task bridge is manual, not automatic

**Key takeaway:** Closest to our vision. Their biggest weakness is the **seam between mindmap and tasks** — they're side-by-side, not unified. A node in the mindmap is not the same object as a task on the board. This is the problem we should solve.

---

### 2. Taskade

| | |
|---|---|
| **Website** | [taskade.com](https://www.taskade.com/) |
| **Pricing** | [taskade.com/pricing](https://www.taskade.com/pricing) — Freemium. Pro ~$8/user/mo |
| **Templates** | [taskade.com/gallery](https://www.taskade.com/gallery) |
| **Target** | Teams wanting an all-in-one workspace |

**What they do well:**
- **Tightest data integration in the market** — same underlying data renders as mindmap, task list, kanban board, org chart, or calendar. Edit in any view, all others update.
- Clean, modern UI
- AI features for generating tasks and expanding ideas
- Good collaboration and real-time editing

**What they don't do well:**
- The "mindmap" is really an **auto-layout outline**, not a freeform visual map. You cannot drag nodes to arbitrary positions.
- Can feel overwhelming — too many views, too many options
- Mindmap rendering is basic (straight lines, uniform styling)
- No desktop-quality mindmap experience

#### PM & Planning Deep Dive

**A node IS a task.** Taskade uses a unified tree-structured data model — every item is a node. Whether you see an outline bullet, a kanban card, or a mindmap node, it's the same object. No conversion step needed.

**8 project views, all on the same data:**

| View | Purpose |
|------|---------|
| List / Outline | Hierarchical task list with collapsible nesting |
| Board / Kanban | Cards in customizable columns, drag-and-drop |
| Table | Spreadsheet-like with filtering, grouping, custom field columns |
| Mind Map | Left-to-right tree diagram |
| Gantt Chart | Timeline bars with task duration and deadlines |
| Calendar | Calendar layout with deadline management |
| Org Chart | Top-down hierarchical structure |
| Actionsheet | Simplified table for streamlined tracking |

**Task properties:**
- Assignees, due dates, status (checkbox + custom via Select fields)
- Custom fields: Text, Number, Date, Select, Person, Checkbox, URL, Password
- AI Fill: auto-complete field content using AI
- **No task dependencies** — this is their biggest PM gap. Workarounds: subtask nesting or `#dependent` tags

**Gantt chart capabilities:**
- Daily/weekly/monthly/yearly time scales
- Drag to reposition and resize task bars
- Today marker and seeker arrows
- **No dependency arrows**, no critical path, no workload balancing — more of a visual timeline than a scheduling engine

**What's missing:**
- No task dependencies (most cited gap)
- No time tracking
- No portfolio/program-level views
- No workload management or resource balancing
- No sprint management, burndown charts, or velocity tracking
- No offline mode
- Google Calendar sync is unreliable

**Key takeaway:** Best multi-view architecture — the unified data model is the right approach. But the mindmap isn't a real mindmap (no freeform positioning), and the PM features are too lightweight for complex projects. Best for small teams doing brainstorming + simple task tracking.

---

### 3. MindMeister + MeisterTask

| | |
|---|---|
| **MindMeister** | [mindmeister.com](https://www.mindmeister.com/) |
| **MeisterTask** | [meistertask.com](https://www.meistertask.com/) |
| **Pricing** | [mindmeister.com/pricing](https://www.mindmeister.com/en/pricing) — Freemium (3 free maps). Personal ~$7/mo, Pro ~$12/mo. MeisterTask priced separately. |
| **Target** | Teams who brainstorm in maps and execute in kanban |

**What they do well:**
- MindMeister is one of the best web-based mindmap editors — smooth, intuitive, visually polished
- MeisterTask is a solid kanban board
- The bridge between them works: select a topic → convert to task → creates card in MeisterTask
- Good collaboration on both sides

**What they don't do well:**
- **They are two separate products.** You switch between apps. There is no unified view.
- Paying for both products gets expensive fast
- Free tier is very restrictive (3 maps total)

#### PM & Planning Deep Dive

**Mindmap → Task conversion:**
- Connect a mindmap to a MeisterTask project board
- Select any topic, click the task icon (or `ALT+SHIFT+T`)
- Choose target project and kanban column, set due date, assign team member
- **Each topic must be converted individually** — no bulk branch conversion
- Notes and comments on mindmap topics are **not carried over**
- Conversion is **browser-only** — not available on mobile

**Sync direction — partially bidirectional:**
- MindMeister → MeisterTask: creating tasks pushes data
- MeisterTask → MindMeister: assignee/date changes sync back
- **Critical gap:** Task completion in MeisterTask is **not visually reflected** in the mindmap — no checkmark, no strikethrough, no color change. This is the most common complaint.

**MeisterTask views:**

| View | Description |
|------|-------------|
| Kanban Board | Primary view. Customizable columns, drag-and-drop. |
| Timeline | Calendar-based Gantt-like view (Business plan+). Drag-and-drop scheduling. |
| Agenda | Personal upcoming tasks and deadlines. |
| Dashboard | Overview of all projects with status indicators. |

**No list/table view** — a common complaint. Kanban-centric and rigid.

**Task properties:**
- Single assignee per task (no multi-assign)
- Due dates with overdue tracking
- Dependencies via "Task Relationships" Power-Up (must be manually activated, no cross-project dependencies)
- **No built-in priority field** — users workaround with color-coded tags
- Subtasks, checklists, tags, time tracking, attachments

**Timeline/Gantt:**
- Calendar-based, drag-and-drop scheduling
- Available on Business plan and above only
- **No critical path, no baseline tracking, no dependency arrows**
- Reports that Gantt features were **reduced in recent updates**, frustrating users

**What's missing:**
- No bulk mindmap-to-task conversion
- Task completion not reflected back in mindmap
- No list/table view in MeisterTask
- No critical path, burndown charts, or sprint analytics
- Cross-project dependencies not supported
- Limited reporting — no custom reports
- Mobile apps lack the integration features entirely
- Two separate subscriptions required

**Key takeaway:** Excellent individual tools, poor integration. The conversion is one-topic-at-a-time, notes don't carry over, and completion doesn't sync back. The "two-tool problem" at its worst.

---

### 4. MindManager

| | |
|---|---|
| **Website** | [mindmanager.com](https://www.mindmanager.com/en/) |
| **Pricing** | [mindmanager.com/pricing](https://www.mindmanager.com/en/pricing/) — Paid only. Essentials ~$99/yr, Professional ~$179/yr or $369 one-time |
| **Product** | [mindmanager.com/product](https://www.mindmanager.com/en/product/mindmanager/) |
| **Target** | Enterprise project managers, consultants |

**What they do well:**
- Most powerful mindmap-to-PM tool on the market
- Sophisticated Gantt chart with full dependency types, critical path, milestones
- Resource management with allocation and cost tracking
- Integrates with MS Project, Excel, Outlook, SharePoint, Teams
- Multiple map structures (radial, org chart, flowchart, timeline)

**What they don't do well:**
- Expensive — no free tier
- Windows-centric (Mac version is limited, no mobile, no Linux)
- Feels like 2010s enterprise software
- No kanban view
- Weak collaboration (file-based, no real-time co-editing)

#### PM & Planning Deep Dive

**Gantt chart — live alternate view of the same map data:**
- Any topic with task info (dates, duration, resources) appears as a bar on the Gantt
- Changes in either view propagate instantly
- **Gantt Pro** adds critical-path highlighting, resource allocation visualization, and schedule optimization
- Exportable as HTML5

**All four dependency types supported:**

| Type | Meaning |
|---|---|
| Finish-to-Start (FS) | Task 2 can't start before Task 1 finishes |
| Start-to-Start (SS) | Task 2 can't start before Task 1 starts |
| Finish-to-Finish (FF) | Task 2 can't finish before Task 1 finishes |
| Start-to-Finish (SF) | Task 2 can't finish before Task 1 starts |

**Critical path:**
- Scheduling algorithms identify tasks whose delay would delay the project
- Gantt Pro highlights critical path on both chart and map
- Compares actual vs. planned progress

**Resource management:**
- Manage Resources dialog: list resources, set weekly availability
- Assign resources with Load % per task
- Standard rates per resource → auto-calculated resource costs
- Task Info pane tracks general cost + resource cost
- **No resource leveling** (no automatic over-allocation resolution)

**Integrations:**
- **MS Project:** Import .mpp files → mindmap with task info. Export mindmap → .mpp file.
- **SharePoint:** Bidirectional task/resource sync across multiple SharePoint sites
- **Excel:** Data Mapper for spreadsheet → map conversion
- **Outlook:** Generate tasks and send to Outlook
- **Teams:** Dedicated "MindManager for Microsoft Teams" product

**Additional views:** Outline, Schedule, Icon, Tag, Priority — all from the same data.

**What's missing:**
- No resource leveling
- No earned value management
- No baseline tracking documented
- Limited reporting capabilities
- No built-in time tracking
- Collaboration requires paid licenses for every editor
- Not scalable for large organizations

**Key takeaway:** The most complete PM implementation in a mindmap tool. Study their Gantt Pro, dependency types, and resource management. But it's a legacy desktop app with no modern collaboration — our opportunity is to bring this level of PM depth to the web in an open-source package.

---

### 5. Mindomo

| | |
|---|---|
| **Website** | [mindomo.com](https://www.mindomo.com/) |
| **Pricing** | [mindomo.com/pricing](https://www.mindomo.com/pricing/) — Freemium (3 free maps). Premium ~$6/mo, Professional ~$14/mo |
| **Features** | [mindomo.com/business/features](https://www.mindomo.com/business/features/) |
| **Target** | Education and business planning |

**What they do well:**
- Task properties directly on mindmap nodes
- Gantt chart bidirectionally synced with mindmap
- Dependencies with automatic rescheduling
- Good education pricing and features
- Presentation mode

**What they don't do well:**
- No kanban/board view (kanban is template-based, not a dynamic view)
- No cross-map task visibility
- Limited reporting
- Export to other formats loses fidelity

#### PM & Planning Deep Dive

**Task properties on nodes:**
- **Assignees:** One or multiple per task, with email notifications on changes. "Ghost users" (no account) can be assigned.
- **Priority:** P0–P4 levels with numbered icon
- **Progress:** Draggable percentage bar. **"Roll up Subtasks"** option auto-calculates parent progress = (completed subtask duration) / (total subtask duration)
- **Start date + Duration:** End date auto-calculated. Or set end date and duration updates.
- **Due date:** Separate from Gantt start/end, with overdue/upcoming filtering
- **Checkboxes:** Auto-added when tasks are enabled
- **Comments:** Activity-tracking dialog with change history

**Three synchronized views:**
1. **Mind Map** — the primary brainstorming/planning surface
2. **Outline** — hierarchical text view
3. **Gantt Chart** — timeline view with task bars

All three reflect the same data. Changes in any view propagate to the others.

**Gantt chart details:**
- One-click toggle from mindmap → Gantt (and back)
- Central topic = first summary task; children = subtasks preserving hierarchy
- Drag-and-drop scheduling on task bars
- **Dependencies:** Created by dragging between task bars. Finish-to-start relationships. **Automatic rescheduling** of downstream tasks when dates change.
- **Milestones:** Diamond-shaped markers on the Gantt
- Indent/outdent to restructure hierarchy within Gantt
- Parent dates auto-calculated from subtasks
- iCalendar sync with Google Calendar, Outlook, Apple Calendar

**Kanban — template-based only:**
- Created from templates (columns: New Task, Assigned, In Progress, On Hold, For Review, Testing, Done)
- Tasks dragged between columns manually
- **Not a dynamic view** of project data — you must build the kanban structure yourself as a diagram. Cannot toggle an existing mindmap into kanban view.

**What's missing:**
- No cross-map task filtering ("all tasks due today across my projects")
- No critical path analysis
- No resource leveling or workload views
- No true kanban view (template-based only)
- No table/list view for tasks
- Performance issues with large maps
- Mobile apps lack feature parity
- Vendor lock-in on export formats

**Key takeaway:** The **best implementation of task-properties-on-nodes** with genuine bidirectional Gantt sync and automatic dependency rescheduling. Worth studying closely. Main weakness: no kanban view and siloed maps.

---

### 6. ClickUp (Mindmap Feature)

| | |
|---|---|
| **Website** | [clickup.com](https://clickup.com/) |
| **Mind Maps** | [clickup.com/features/mind-maps](https://clickup.com/features/mind-maps) |
| **Pricing** | [clickup.com/pricing](https://clickup.com/pricing) — Freemium. Unlimited ~$7/user/mo |
| **Target** | Teams wanting a full PM suite |

**What they do well:**
- Full-featured PM platform (tasks, docs, goals, time tracking, dashboards, sprints)
- One source of truth: all 15+ views render the same task data
- Can create tasks directly from mindmap view
- Task Mode mindmap = live bidirectional view of actual task hierarchy

**What they don't do well:**
- **The mindmap view is clearly an afterthought**
- Users describe it as "massively limited" and "incomplete"
- Feature stagnation — users report waiting 2+ years for improvements

#### PM & Planning Deep Dive

**Two mindmap modes:**

1. **Task Mode** — Auto-generated mindmap from existing task hierarchy. Nodes = Spaces/Folders/Lists/Tasks. Fully bidirectional: create, edit, delete, move tasks directly. Dragging a node changes its actual location in the hierarchy. This is a live view, not a copy.

2. **Blank Mode** — Freeform canvas for brainstorming. Nodes start disconnected from tasks. Can be converted to tasks by clicking "Create Task" and choosing a target List. **No automatic sync** until conversion.

**Mindmap limitations (the big ones):**
- Only one root node per mindmap
- Blank Mode is a **right-aligned tree layout**, not a radial/circular mindmap
- Sub-branches **overlap** with complex maps; no proper rebalancing
- No cross-links between branches
- No custom fields displayed on nodes (no progress bars, dates, etc.)
- No text color customization, no images on nodes
- No dependency visualization (unlike Gantt view)
- **100-use cap** on Free and Unlimited plans (cumulative, workspace-wide, doesn't reset)

**How it connects to other views:**
Through the shared task data model — not through direct feature integration. Tasks created in mindmap appear in Gantt once dates are assigned. You switch views; there's no "convert mindmap branch to Gantt timeline" workflow. Views available: List, Board, Calendar, Gantt, Timeline, Workload, Mindmap, Table, and more.

**What's missing from the mindmap specifically:**
- No styling, formatting, or visual customization
- No relationship lines between non-adjacent nodes
- No way to see task metadata (dates, assignees) on the map itself
- Performance issues with many nodes
- Users resort to Miro, Boardmix, or MindMeister for actual brainstorming

**Key takeaway:** ClickUp proves that mindmap-as-a-view-on-PM-data has demand but their implementation is poor. The Task Mode bidirectional sync is architecturally correct; the UX is not. Their Blank Mode shows that brainstorming and task management are fundamentally different workflows that need a graceful bridge.

---

### 7. XMind

| | |
|---|---|
| **Website** | [xmind.com](https://xmind.com/) |
| **Pricing** | [xmind.com/pricing](https://xmind.com/pricing) — Free version available. Premium ~$60/yr |
| **Features** | [xmind.com/features](https://xmind.com/features) |
| **Target** | Individual knowledge workers, students |

**What they do well:**
- **Best-looking mindmaps in the market** — beautiful themes, smooth UX, multiple structures
- Surprisingly deep task system (Premium): full task properties, Gantt chart, dependencies
- Great export options (PDF, PNG, Markdown, OPML, CSV, ICS)
- Fast, polished desktop app

**What they don't do well:**
- Single-player tool — limited collaboration
- No cross-map task visibility
- No kanban/board view, no agile features
- Premium-gated PM features

#### PM & Planning Deep Dive

**Two task systems:**
1. **To-Do** (free) — Simple checkboxes on topics for quick tracking
2. **Task** (Premium) — Full structured PM layer with all properties below

**Task properties on nodes:**

| Property | Details |
|---|---|
| Priority | Multiple levels with visual markers |
| Start Date | When the task begins |
| Due/End Date | Deadline |
| Duration | Auto-calculated or manual |
| Progress | Completion percentage |
| Assignee(s) | One or more (comma-separated) |
| Dependencies | **All 4 types:** Finish-to-Start, Start-to-Finish, Start-to-Start, Finish-to-Finish |
| Notes | Text notes per task |

**Built-in Gantt chart (Premium):**
- Bidirectional sync with mindmap — edit dates in either view
- Drag-and-drop scheduling with auto-update of dependent tasks
- Dependency visualization as connecting lines
- Progress indicators on bars
- Skip non-working days option
- Export: PNG, JPEG, PDF, Excel, ICS

**Task filtering:**
- Task Tracker panel for monitoring progress within a map
- Quick filter (`Cmd/Ctrl+F`) to highlight unfinished items
- Advanced Filter by markers, labels, priority, task status
- **No cross-map dashboard** — each map is an island

**Export to PM formats:**
- CSV with title, due date, assignee, notes, dependencies (encoded as Topic ID + type)
- ICS for calendar import
- Excel for spreadsheet workflows
- Dependency export uses opaque Topic IDs — not human-readable

**What's missing:**
- No cross-map task visibility (the critical gap)
- No resource management or workload views
- No budgeting or cost tracking
- No reporting (burndown, velocity, etc.)
- No kanban, sprints, or agile views
- No native PM tool integrations (export-only)
- Performance degrades on large maps
- Dependencies export as opaque Topic ID codes

**Key takeaway:** XMind has quietly become more PM-capable than most people realize — full dependency types, Gantt chart, and task properties. But it's a **single-user, single-map tool** with no way to see tasks across projects. The gold standard for mindmap UX; study their interaction design and visual polish.

---

### 8. Freeplane (Open Source)

| | |
|---|---|
| **Website** | [docs.freeplane.org](https://docs.freeplane.org/) |
| **GitHub** | [github.com/freeplane/freeplane](https://github.com/freeplane/freeplane) |
| **License** | GPL-2.0 |
| **Pricing** | Free |
| **Target** | Power users, knowledge management enthusiasts |

**What they do well:**
- Mature, actively maintained open-source project (fork of FreeMind)
- Extremely powerful for advanced users — scripting, formulas, attributes, conditional styles
- Rich plugin/add-on ecosystem for PM
- Can store arbitrary structured data on nodes via key-value attributes

**What they don't do well:**
- **Dated Java Swing UI** — looks and feels like 2005
- Desktop only (Java app, no web version)
- No collaboration (file-based sharing only)
- Task management is entirely DIY
- Steep learning curve

#### PM & Planning Deep Dive

**Arbitrary key-value attributes on every node:**
No fixed schema — define whatever you need (`status`, `priority`, `assignee`, `estimatedTime`, `cost`, `duration`, etc.). Attributes can contain **formulas** (Groovy expressions):
```
=children.sum(0){ it['duration'].num0 }
```
This rolls up child durations to the parent, with `.num0` safely handling non-numeric values.

**Calendar/date features:**
- Built-in Time Management dialog with date/time pickers
- Reminder system with pop-up alerts at scheduled dates
- Community scripts that generate calendar node trees (year → month → week → day)

**PM add-ons:**

| Add-on | Purpose |
|---|---|
| **Freeplane\|GTD+** | Full Getting Things Done: next-action lists, context/project filtering, due-date views, mark-done |
| **GTD Sync** | Syncs GTD mindmaps with `todo.txt` files |
| **Freeplane\|WBS** | Work Breakdown Structure: aggregates costs/durations up the tree, assigns WBS codes (1.2.3), percentage breakdowns |
| **Task Time Tracker** | Tracks actions, delegated items, appointments; elapsed time and daily totals |
| **Pomodoro Timer** | Pomodoro time credits on node attributes |

**Formulas and conditional styling:**
- Groovy-based formulas in node text, attribute values, and notes
- Hierarchy traversal: sum costs across children, find nodes by text
- Conditional styles: rules that test node content/attributes/icons → apply visual formatting
- Practical PM use: red when `status == 'overdue'`, green when `status == 'done'`
- Progress icons in 10% or 25% increments

**Export:** PDF, HTML, PNG, SVG, CSV (via scripts). No native MS Project export — WBS add-on exports tables for import into other PM tools.

**Key takeaway:** More PM-capable than it looks through its extensibility model. The WBS add-on and formula-based rollups are genuinely powerful. But the Java Swing UI and DIY approach mean it's a tool for tinkerers, not teams. A modern web-based tool could borrow its extensibility philosophy.

---

### 9. Wisemapping (Open Source)

| | |
|---|---|
| **Website** | [wisemapping.com](https://www.wisemapping.com/en) |
| **GitHub** | [github.com/wisemapping/wisemapping-open-source](https://github.com/wisemapping/wisemapping-open-source) |
| **License** | MIT |
| **Pricing** | Free (hosted or self-hosted) |
| **Target** | Anyone wanting a simple web-based mindmap |

**What they do well:**
- Web-based, self-hostable open-source mindmap editor
- Clean, simple interface
- MIT license — very permissive
- Real-time collaboration
- Available as Docker image for self-hosting

**What they don't do well:**
- **Zero task management features** — no status, priority, dates, assignees, progress
- No formulas, no plugins, no scripting
- Limited styling options
- Basic export (FreeMind, SVG, PNG, PDF)

#### Tech Stack (for reference)

| Layer | Technology |
|---|---|
| Frontend | React, SVG-based rendering (Web2D abstraction → Mindplot engine → Webapp shell) |
| Backend | Spring Boot v3 (Java) |
| Requirements | JDK 24+, Maven 3+, Node v24+, Yarn v12+, PostgreSQL v15+ |

Actively maintained (last updates: Aug 2025 styling improvements, Sep 2024 performance fixes). Originated 2010, major architectural overhaul in 2021.

**Key takeaway:** The only web-based OSS mindmap tool of note. Zero PM features, but the tech stack (React + Spring Boot) is modern. Worth examining as a reference for SVG-based mindmap rendering, but building on top of it would mean adding an entire PM layer from scratch.

---

## Competitive Landscape Matrix

| | Mindmap Quality | Task Mgmt | Gantt/Timeline | Dependencies | Multi-View | Collab | OSS | Free Tier |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **Ayoa** | ★★★★ | ★★★ | ★★★ | ★★ | ★★★★ | ★★★★ | ✗ | Limited |
| **Taskade** | ★★ | ★★★ | ★★ | ✗ | ★★★★★ | ★★★★ | ✗ | Yes |
| **MindMeister+MeisterTask** | ★★★★ | ★★★ | ★★ | ★★ | ★★ | ★★★★ | ✗ | Limited |
| **MindManager** | ★★★★ | ★★★★★ | ★★★★★ | ★★★★★ | ★★★ | ★★ | ✗ | ✗ |
| **Mindomo** | ★★★★ | ★★★ | ★★★★ | ★★★ | ★★★ | ★★★ | ✗ | Limited |
| **ClickUp** | ★★ | ★★★★★ | ★★★★ | ★★★★ | ★★★★★ | ★★★★★ | ✗ | Yes |
| **XMind** | ★★★★★ | ★★★ | ★★★★ | ★★★★ | ★★ | ★ | Partial | Yes |
| **Freeplane** | ★★★ | ★★ | ✗ | ✗ | ★ | ✗ | ✓ GPL | ✓ |
| **Wisemapping** | ★★ | ✗ | ✗ | ✗ | ✗ | ★★ | ✓ MIT | ✓ |

---

## PM Feature Comparison Matrix

| Feature | Ayoa | Taskade | MindMeister+MT | MindManager | Mindomo | ClickUp | XMind |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| Node = Task (unified data) | ✗ | ✓ | ✗ | ✓ | ✓ | ✓ (Task Mode) | ✓ |
| Kanban board | ✓ | ✓ | ✓ | ✗ | Template only | ✓ | ✗ |
| Gantt chart | ✓ | Basic | Basic (Business+) | Full (with Gantt Pro) | ✓ | ✓ | ✓ (Premium) |
| Dependencies | Basic | ✗ | Power-Up | All 4 types | FS only | ✓ | All 4 types |
| Critical path | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ |
| Milestones | ✗ | ✗ | ✗ | ✓ | ✓ | ✓ | ✗ |
| Resource management | ✗ | ✗ | ✗ | ✓ | ✗ | Basic | ✗ |
| Cost tracking | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ |
| Progress rollup | ✗ | ✗ | ✗ | ✗ | ✓ (auto) | ✗ | ✗ |
| Cross-project views | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ |
| Time tracking | ✗ | ✗ | ✓ | ✗ | ✗ | ✓ | ✗ |
| Auto-reschedule on dependency change | ✗ | ✗ | ✗ | ✓ | ✓ | ✓ | ✓ |
| Calendar sync | ✓ | Unreliable | ✗ | ✓ (Outlook) | ✓ (iCal) | ✓ | ✓ (ICS) |

---

## Key Market Gaps (Opportunities)

### 1. No Open-Source Contender
There is no open-source tool that offers both good mindmapping and task management. Freeplane has powerful mindmapping but DIY PM. Wisemapping is web-based but feature-thin. **An OSS tool in this space would be unique.**

### 2. The "Two-Tool Problem"
MindMeister + MeisterTask is the poster child: two good products, mediocre integration (one-at-a-time conversion, no completion sync-back). Users want one tool, one data model, seamless transitions. Taskade gets closest but sacrifices mindmap quality.

### 3. Brainstorm → Execute Transition
Every tool struggles here. Ayoa keeps mindmap and tasks as parallel structures. MindMeister requires manual one-by-one conversion. ClickUp's Blank Mode has no auto-sync until conversion. **No tool handles the transition from "idea node" to "actionable task" gracefully.**

### 4. Freeform Spatial Mapping + Structured Data
Taskade proves multi-view works but sacrifices freeform positioning. XMind has beautiful freeform maps but is single-player. **The tool that lets you freely arrange nodes AND attach structured task data, with real collaboration, wins.**

### 5. Performance at Scale
Mindmaps become unwieldy at 100+ nodes. PM tools handle thousands of tasks. Collapsible sub-trees, focus mode, and smart filtering could solve this but nobody does it well.

### 6. Dependency Intelligence Gap
Only MindManager and XMind support all 4 dependency types. Only MindManager has critical path. Only Mindomo and MindManager auto-reschedule on dependency changes. **Most tools treat dependencies as an afterthought.**

---

## What to Steal from Each

| Tool | What to borrow |
|---|---|
| **XMind** | Mindmap UX, visual polish, interaction design, all 4 dependency types |
| **Taskade** | Same-data-multiple-views architecture (node IS task) |
| **Mindomo** | Task properties on nodes, auto progress rollup, bidirectional Gantt, auto-rescheduling |
| **MindManager** | Critical path, resource management, Gantt Pro depth |
| **Ayoa** | Canvas + Workflow + Timeline as complementary views |
| **ClickUp** | Task Mode bidirectional sync architecture, cross-project visibility |
| **Freeplane** | Extensibility via attributes/formulas, WBS rollups, conditional styling |

---

## Recommended Positioning for MindBlown

**"The tool that makes you a good project manager without you noticing."**

The mechanism pitch behind it: *the open-source tool where projects start as ideas and become plans — without switching apps.* The benefit is guided PM; the seamless mindmap→plan transition is how it's delivered.

Core differentiators:
0. **Guided PM** — the defaults are the methodology, plus a plan linter that teaches as it checks. No tool on the market coaches untrained users into PM practice (see product-vision.md → Guided Project Management)
1. **Open source** — no competitor here
2. **Mindmap-first, but not mindmap-only** — the map is the primary planning surface, with kanban/list/Gantt as derived views
3. **Graceful brainstorm → execute transition** — nodes start as ideas, get promoted to tasks when ready, without breaking the visual flow
4. **Freeform + structured** — spatial positioning AND task metadata, together
5. **Fast and lightweight** — not an enterprise monolith
6. **Dependency intelligence** — all 4 dependency types, auto-rescheduling, critical path (eventually)

---

*Next steps: Define tech stack and build an interactive prototype of the core mindmap editor with task properties on nodes.*
