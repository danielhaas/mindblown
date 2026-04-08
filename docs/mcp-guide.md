# MindBlown MCP Guide

Connect AI agents to MindBlown via the Model Context Protocol.

---

## What is MCP?

The [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) is an open standard that lets AI assistants interact with external tools and data sources. MindBlown's MCP server exposes all project management capabilities -- reading maps, creating nodes, managing sprints, tracking progress -- so that AI agents like Claude can help you plan and manage projects.

The MCP server runs as a local process using stdio transport. It communicates with the MindBlown API over HTTP.

---

## Prerequisites

Before setting up the MCP server, make sure MindBlown is running:

```bash
# 1. Start the database (PostgreSQL)
docker run -d --name mindblown-db \
  -e POSTGRES_USER=mindblown \
  -e POSTGRES_PASSWORD=mindblown \
  -e POSTGRES_DB=mindblown \
  -p 5433:5432 postgres:16

# 2. Start the backend API
cd packages/server
pnpm build && node dist/index.js
# API will be running on http://localhost:3001

# 3. Build the MCP server
cd packages/mcp
pnpm build
```

Verify the backend is running:

```bash
curl http://localhost:3001/api/health
# Should return: {"status":"ok", ...}
```

---

## Setup

### Step 1: Get a JWT token

Register or log in via the API to get a token:

```bash
# Register a new user
curl -s -X POST http://localhost:3001/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com", "password": "your-password", "name": "Your Name"}'

# Or log in with an existing account
curl -s -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com", "password": "your-password"}'
```

Both return a JSON response with a `token` field. Copy that token -- you'll need it in the next step.

> **Note:** Tokens expire after 7 days by default. When your token expires, log in again and update the config.

### Step 2: Configure your AI client

#### Claude Code (recommended)

The easiest way is using the CLI command:

```bash
claude mcp add mindblown \
  --transport stdio \
  --scope user \
  -e MINDBLOWN_API_URL=http://localhost:3001 \
  -e MINDBLOWN_TOKEN=<your-jwt-token> \
  -- node /absolute/path/to/mindblown/packages/mcp/dist/index.js
```

- `--scope user` makes it available in **all** your Claude Code sessions (any project directory)
- `--scope project` would add it to `.mcp.json` in the current project only

Verify it's connected:

```bash
claude mcp list
# Should show: mindblown: node ... - ✓ Connected
```

**Important:** After adding the MCP server, **restart any running Claude Code sessions**. MCP servers are loaded at session startup.

#### Claude Code (manual config)

If you prefer to edit the config file directly, add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "mindblown": {
      "command": "node",
      "args": ["/absolute/path/to/mindblown/packages/mcp/dist/index.js"],
      "env": {
        "MINDBLOWN_API_URL": "http://localhost:3001",
        "MINDBLOWN_TOKEN": "<your-jwt-token>"
      }
    }
  }
}
```

> **Warning:** The config goes in `~/.claude.json` (the root-level dotfile), NOT `~/.claude/settings.json` or `~/.claude/mcp.json` -- those are different files.

#### Cursor

Add to your Cursor MCP settings (Settings > MCP Servers):

```json
{
  "mcpServers": {
    "mindblown": {
      "command": "node",
      "args": ["/absolute/path/to/mindblown/packages/mcp/dist/index.js"],
      "env": {
        "MINDBLOWN_API_URL": "http://localhost:3001",
        "MINDBLOWN_TOKEN": "<your-jwt-token>"
      }
    }
  }
}
```

#### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "mindblown": {
      "command": "node",
      "args": ["/absolute/path/to/mindblown/packages/mcp/dist/index.js"],
      "env": {
        "MINDBLOWN_API_URL": "http://localhost:3001",
        "MINDBLOWN_TOKEN": "<your-jwt-token>"
      }
    }
  }
}
```

#### Any MCP-compatible client

MindBlown uses **stdio transport**. Configure your client with:

- **Command:** `node`
- **Args:** `["/path/to/mindblown/packages/mcp/dist/index.js"]`
- **Environment variables:**
  - `MINDBLOWN_API_URL` -- URL of the MindBlown API (default: `http://localhost:3001`)
  - `MINDBLOWN_TOKEN` -- JWT authentication token

### Step 3: Verify

Start a new session in your AI client and ask:

> "List my MindBlown maps"

The AI should call the `list_maps` tool and return your projects. If the AI doesn't recognize MindBlown, see the [Troubleshooting](#troubleshooting) section.

---

## What can the AI do?

Once connected, the AI can fully manage your projects through natural conversation. The server provides detailed instructions to the AI about MindBlown's domain model, so it understands concepts like the planning loop, weighted rollup, and health signals.

### Quick examples

| You say | What happens |
|---------|-------------|
| "What's the status of my project?" | AI reads the map tree and health report, gives an executive summary |
| "Create a task for API authentication under the Backend branch" | AI calls `create_node` with the right parent |
| "Estimate all unestimated tasks" | AI uses the `estimate_tasks` prompt to suggest estimates with reasoning |
| "Mark the Design System as 75% complete" | AI calls `set_progress` on the leaf node |
| "What's blocking us?" | AI analyzes dependencies, bottlenecks, and overdue items |
| "Create a sprint for next week with the top priority tasks" | AI creates a cycle and assigns appropriate nodes |
| "Generate a standup update" | AI uses the `daily_standup` prompt to summarize recent changes |

---

## Available Tools (26)

### Map Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `list_maps` | List all maps with progress and health | (none) |
| `get_map` | Get full tree with computed fields | `mapId` |
| `create_map` | Create a new map/project | `name`, `description?` |

### Node Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `create_node` | Create a node under a parent | `mapId`, `parentId`, `text`, `effortEstimate?`, `priority?`, `status?`, `dueDate?`, `startDate?` |
| `update_node` | Update any field on a node | `mapId`, `nodeId`, `text?`, `description?`, `effortEstimate?`, `percentComplete?`, `status?`, `priority?`, `dueDate?`, `startDate?`, `tags?`, `assigneeIds?`, `isMilestone?` |
| `delete_node` | Delete a node and descendants | `mapId`, `nodeId` |
| `move_node` | Move a node to a new parent | `mapId`, `nodeId`, `newParentId`, `index?` |
| `bulk_update_nodes` | Update multiple nodes at once | `mapId`, `updates` (array of `{nodeId, fields}`) |
| `search_nodes` | Search nodes by text | `mapId`, `query` |

### Task Property Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `set_estimate` | Set effort estimate on a leaf | `mapId`, `nodeId`, `estimate` |
| `set_progress` | Set percent complete on a leaf | `mapId`, `nodeId`, `percent` (0-100) |
| `set_status` | Set status on a node | `mapId`, `nodeId`, `status` |
| `set_priority` | Set priority on a node | `mapId`, `nodeId`, `priority` (P0-P3) |

### Dependency Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `add_dependency` | Add dependency between nodes | `mapId`, `fromNodeId`, `toNodeId`, `type` (FS/SS/FF/SF) |
| `remove_dependency` | Remove a dependency | `mapId`, `nodeId`, `targetNodeId` |

### Version Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `list_versions` | List all versions for a workspace | `workspaceId` |
| `create_version` | Create a new version/release | `workspaceId`, `name`, `description?`, `targetDate?` |

### Milestone Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `list_milestones` | List milestones, optionally filtered by version | `workspaceId`, `versionId?` |
| `create_milestone` | Create a milestone within a version | `workspaceId`, `name`, `versionId?`, `description?`, `targetDate?` |

### Sprint Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `list_cycles` | List sprints for a workspace | `workspaceId` |
| `create_cycle` | Create a new sprint, optionally within a version | `workspaceId`, `name`, `startDate`, `endDate`, `versionId?` |
| `assign_to_sprint` | Assign a node to a sprint | `cycleId`, `nodeId` |
| `rollover_sprint` | Move incomplete items between sprints | `fromCycleId`, `toCycleId` |

### Utility Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `get_schedule` | Get computed schedule and critical path | `mapId` |

---

## Available Resources (6)

Resources provide read-only data that the AI can access for context.

| Resource URI | Description |
|-------------|-------------|
| `mindblown://maps` | List of all maps with summary stats (name, progress, health, effort unit) |
| `mindblown://maps/{mapId}` | Full map tree as formatted text with status, progress, and effort for every node |
| `mindblown://maps/{mapId}/health` | Health report: lists all at-risk and behind nodes with reasons |
| `mindblown://maps/{mapId}/schedule` | Schedule with critical path and projected dates |
| `mindblown://maps/{mapId}/sprints` | Sprint overview with progress per sprint |
| `mindblown://nodes/{nodeId}` | Single node with all properties and computed fields |

---

## Available Prompts (5)

Prompts are pre-built templates that guide the AI through common workflows.

| Prompt | Description | Parameters |
|--------|-------------|------------|
| `project_status` | Summarize overall project health -- progress, on-track areas, concerns, recommended actions | `mapId` |
| `sprint_review` | Review sprint progress -- velocity, what went well, what is at risk, blockers | `cycleId` |
| `estimate_tasks` | Suggest effort estimates for all unestimated leaf tasks, with reasoning based on already-estimated tasks | `mapId` |
| `identify_risks` | Analyze project risks -- health issues, dependency bottlenecks, overdue items, with severity ranking and mitigation | `mapId` |
| `daily_standup` | Generate a standup update -- what was done (last 24h changes), what is in progress, blockers | `mapId` |

---

## Example Conversations

### "What's the project status?"

**You:** What is the current status of my Website Redesign project?

**AI:** Let me check your project.

*AI calls `list_maps` to find the map, then `get_map` with the map ID, then reads the `mindblown://maps/{mapId}/health` resource.*

**AI:** Here is the status of Website Redesign:

- **Overall:** 23% complete, 47 days of effort estimated
- **Design (75%):** Nearly done. Wireframes complete, visual design at 80%, design system at 25%.
- **Frontend (10%):** Just getting started. Component library at 15%, page templates at 5%.
- **Backend (0%):** Not started. This is the biggest risk -- 12 days of work with no progress yet.
- **Content (30%):** Copywriting in progress, photography barely started.

The Backend branch is flagged as **at risk** because it has zero progress and significant effort remaining. I recommend prioritizing API endpoints this week.

---

### "Estimate all unestimated tasks"

**You:** Can you suggest estimates for the unestimated tasks in my project?

**AI:** Let me look at your tasks.

*AI uses the `estimate_tasks` prompt, which loads all leaf nodes and identifies unestimated ones.*

**AI:** I found 4 unestimated leaf tasks. Based on the complexity of already-estimated tasks in this project (effort unit: days):

| Task | Suggested Estimate | Reasoning |
|------|--------------------|-----------|
| Set up CI/CD | 2 days | Similar to "Database Migration" (estimated at 2d) -- standard pipeline setup |
| Write API docs | 3 days | Your API has 6 endpoint groups; similar scope to "Copywriting" (estimated at 5d) but more structured |
| Load testing | 1 day | Scripted test runs, comparable to the simpler tasks in your project |
| User acceptance testing | 3 days | Requires coordinating with stakeholders; similar to "Visual Design" review cycles |

Want me to apply these estimates? I can use `bulk_update_nodes` to set them all at once.

**You:** Yes, apply them.

*AI calls `bulk_update_nodes` with the 4 updates.*

**AI:** Done. All 4 tasks are now estimated. Your project total effort updated from 47 days to 56 days.

---

### "Set up version planning"

**You:** We're planning two releases -- V1 is the MVP due in June, V2 adds advanced features for Q4. Set that up.

**AI:** Let me create the version structure.

*AI calls `create_version` twice, then `create_milestone` for key deliverables.*

**AI:** Done. I created:

- **V1** (target: June 30) with milestones:
  - "Core System MVP" -- the minimum viable product
  - "Billing Module" -- payment processing
- **V2** (target: December 15) with milestones:
  - "Advanced Reporting" -- analytics dashboard
  - "API Platform" -- public API for integrations

Now I'll tag the relevant tasks. Looking at your map, the Backend and Design branches seem like V1 work, and the API Platform branch is V2.

*AI calls `update_node` on each relevant node to set `versionId` and `milestoneId`.*

**AI:** Tagged 18 nodes with version and milestone. The tree structure stays the same (organized by functional area), but now you can track what ships in each release. Use `list_versions` or `list_milestones` anytime to check release scope.

---

### "Create a sprint for next week"

**You:** Create a sprint for next week within V1 and assign the highest-priority unfinished tasks.

**AI:** Let me check your current tasks and set that up.

*AI calls `list_versions` to get the V1 ID, then `get_map` to see all nodes, then `create_cycle` with next week's dates and the V1 versionId.*

**AI:** I created **Sprint 5** (April 7 - April 11) within V1.

Now let me find the best V1 tasks to include. Looking at unfinished P0 and P1 tasks tagged for V1:

- "API Endpoints" (P0, 7 days, 0% complete) -- too large for a 1-week sprint alone
- "Component Library" (P1, 8 days, 15% complete) -- in progress, 6.8 days remaining
- "Design System" (P1, 4 days, 25% complete) -- in progress, 3 days remaining

I recommend assigning "Design System" (3 days remaining) and splitting "API Endpoints" into smaller tasks if possible. The sprint has 5 working days of capacity.

*AI calls `assign_to_sprint` for "Design System".*

**AI:** Assigned "Design System" to Sprint 5. Want me to break down "API Endpoints" into smaller tasks that could fit in this sprint?

---

### "What's blocking us?"

**You:** What are the current blockers and risks?

*AI uses the `identify_risks` prompt to analyze health signals, dependency bottlenecks, and overdue items.*

**AI:** I found 3 risks:

1. **Backend branch at risk (severity: high)** -- 12 days of work with 0% progress. "API Endpoints" blocks "Page Templates" (FS dependency). If API work doesn't start this week, Frontend will be blocked.

2. **Dependency bottleneck on "Design System" (severity: medium)** -- 3 other tasks depend on it (Component Library, Page Templates, and Photography). It is only 25% complete. Any delay here cascades to 3 downstream tasks.

3. **"Photography" overdue (severity: low)** -- due date was March 28, currently at 10%. Low impact since it is not on the critical path, but should be rescheduled or reassigned.

Recommended priority: Start Backend API work immediately (risk 1), then unblock Design System (risk 2).

---

## Troubleshooting

### Tools not appearing in AI client

This is the most common issue. Check these in order:

1. **Restart the AI session.** MCP servers are loaded at session startup. If you added the config while a session was running, it won't see the server until you restart.

2. **Verify the config is in the right file:**
   - Claude Code: `~/.claude.json` (for user scope) or `.mcp.json` (for project scope)
   - NOT `~/.claude/settings.json` or `~/.claude/mcp.json` -- these are different files
   - Run `claude mcp list` to verify: you should see `mindblown: ... - ✓ Connected`

3. **Check the MCP server can start:**
   ```bash
   MINDBLOWN_API_URL=http://localhost:3001 MINDBLOWN_TOKEN=<token> \
     node /path/to/mindblown/packages/mcp/dist/index.js
   ```
   If it hangs silently, that's correct (it's waiting for stdio input). Press Ctrl+C.

4. **Verify the backend is running:**
   ```bash
   curl http://localhost:3001/api/health
   ```

### "Error: connect ECONNREFUSED"

The MCP server cannot reach the MindBlown API. Make sure:
- The backend is running (`node packages/server/dist/index.js`)
- `MINDBLOWN_API_URL` points to the correct host and port (default: `http://localhost:3001`)
- If running in Docker, use the container network address, not `localhost`

### "API Error (401): Unauthorized"

Your JWT token has expired or is invalid.
- Tokens expire after 7 days by default (configurable via `JWT_EXPIRES_IN`)
- Generate a new token by logging in again:
  ```bash
  curl -s -X POST http://localhost:3001/api/auth/login \
    -H "Content-Type: application/json" \
    -d '{"email": "you@example.com", "password": "your-password"}'
  ```
- Update `MINDBLOWN_TOKEN` in your MCP config and restart your AI client

### "MCP server failed to start"

- Verify the MCP server is built: `cd packages/mcp && pnpm build`
- Check the path in your MCP config is absolute and correct
- Verify Node.js 20+ is installed: `node --version`

### "No maps found" when maps exist

The token might belong to a user without access. Check that the user associated with the token has permission to view the maps in question.
