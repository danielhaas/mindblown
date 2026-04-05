# MindBlown MCP Guide

Connect AI agents to MindBlown via the Model Context Protocol.

---

## What is MCP?

The [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) is an open standard that lets AI assistants interact with external tools and data sources. MindBlown's MCP server exposes all project management capabilities -- reading maps, creating nodes, managing sprints, tracking progress -- so that AI agents like Claude can help you plan and manage projects.

The MCP server runs as a local process using stdio transport. It communicates with the MindBlown API over HTTP.

---

## Setup

### 1. Build the MCP server

```bash
cd packages/mcp
pnpm build
```

### 2. Get a JWT token

Register or log in via the API to get a token:

```bash
# Register a new user
curl -X POST http://localhost:3001/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com", "password": "your-password", "name": "Your Name"}'

# Or log in
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com", "password": "your-password"}'
```

Copy the `token` from the response.

### 3. Configure your AI client

#### Claude Code

Add to your Claude Code MCP configuration (typically `~/.claude/mcp.json` or project-level `.mcp.json`):

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

### 4. Verify

Ask your AI assistant: "List my MindBlown maps." It should call the `list_maps` tool and return your projects.

---

## Available Tools (22)

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

### Sprint Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `list_cycles` | List sprints for a workspace | `workspaceId` |
| `create_cycle` | Create a new sprint | `workspaceId`, `name`, `startDate`, `endDate` |
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

### "Create a sprint for next week"

**You:** Create a sprint for next week and assign the highest-priority unfinished tasks.

**AI:** Let me check your current tasks and set that up.

*AI calls `get_map` to see all nodes, then `create_cycle` with next week's dates.*

**AI:** I created **Sprint 5** (April 7 - April 11).

Now let me find the best tasks to include. Looking at unfinished P0 and P1 tasks:

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
  curl -X POST http://localhost:3001/api/auth/login \
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

### Tools not appearing in AI client

- Restart your AI client after changing MCP configuration
- Check the MCP server logs for startup errors
- Verify the config JSON is valid (no trailing commas, correct paths)
