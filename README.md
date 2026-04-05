# MindBlown

**A mindmap-based project management tool where ideas become plans.**

[Screenshot]

## What is MindBlown?

MindBlown is an open-source project management tool built around the mindmap. You brainstorm your project as a mindmap, estimate effort on the leaf nodes, and everything above auto-computes -- progress, health signals, and schedule projections roll up through the tree automatically. There is no "convert to task" step: a node starts as an idea and gradually becomes a task by accumulating properties like due dates, assignees, and status. The result is a tool where you think visually and get a project plan for free.

## Features

### Views

| View | Description |
|------|-------------|
| **Mindmap** | Primary planning surface with 4 layout algorithms (radial, left-to-right, top-down, org chart) and freeform positioning |
| **Kanban** | Drag-and-drop board grouped by status, priority, assignee, or any property |
| **Gantt** | Auto-generated timeline from node dates and dependencies with critical path highlighting |
| **List / Table** | Spreadsheet-style view with sortable columns, inline editing, and bulk operations |
| **Calendar** | Tasks plotted on day/week/month calendar by due date |
| **Hill Chart** | Basecamp-style uncertainty visualization -- see which areas are still being figured out vs. executing |
| **Workload** | Team capacity view showing effort distribution per assignee |

### Planning

- **Effort estimation with auto-rollup** -- estimate leaf nodes; parents auto-sum. Weighted progress rolls up to the root.
- **Health signals** -- on track / at risk / behind, propagated upward through the tree. One stuck leaf turns its whole branch amber.
- **Critical path** -- identifies the chain of dependent tasks that determines minimum project duration.
- **Schedule projection** -- given estimates, dependencies, and progress velocity, computes projected completion dates.
- **Baselines** -- snapshot the plan at any point, compare actual progress against the original.

### Sprints

- **Cycle management** -- define time-boxed sprints with start/end dates.
- **Node assignment** -- assign any leaf node to a sprint; filter views to show only the current cycle's work.
- **Milestones** -- mark any node as a zero-effort checkpoint; auto-completed when all children finish.
- **Auto-rollover** -- move incomplete items from one sprint to the next automatically.

### Collaboration

- **Real-time editing** -- multiple users editing the same map simultaneously via WebSocket.
- **Cursor presence** -- see where other users are working on the map.
- **Comments** -- threaded comments on any node, with inline editing and deletion.
- **Sharing** -- share maps with view/edit/admin permissions; generate public read-only links.

### Integrations

- **GitHub Issues** -- bidirectional sync. Link nodes to existing issues, create issues from nodes, import issues into the map. Webhook support for automatic status updates.
- **MCP for AI agents** -- expose all project management capabilities to AI assistants via the Model Context Protocol. 22 tools, 6 resources, 5 prompts.

### Editor

- **Keyboard-first** -- `Tab` create child, `Enter` create sibling, `Space` collapse/expand, `Delete` remove.
- **Command palette** -- `Cmd/Ctrl+K` to jump to any node or run any action.
- **Quick add** -- `Q` opens quick-add from anywhere with natural language parsing.
- **Drag and drop** -- move nodes between parents, reorder siblings.
- **4 layout algorithms** -- radial, tree left-to-right, tree top-down, org chart.
- **Drill-down navigation** -- focus on a subtree with breadcrumb trail; sibling branches shown dimmed for context.
- **Multi-select** -- select multiple nodes for bulk operations.

### Import / Export

JSON, CSV, OPML, and PNG.

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org) 20+
- [pnpm](https://pnpm.io) 9+
- [Docker](https://www.docker.com/) and Docker Compose (for the database)

### 1. Clone and install

```bash
git clone https://github.com/your-org/mindblown.git
cd mindblown
pnpm install
```

### 2. Start the database

```bash
docker compose up -d db
```

This starts PostgreSQL 16 on port 5433.

### 3. Configure environment

```bash
cp .env.example .env
```

The defaults work out of the box for local development.

### 4. Build and start the backend

```bash
pnpm build
cd packages/server
node dist/index.js
```

The API starts on `http://localhost:3001`. The database is automatically migrated and seeded on first run.

### 5. Start the frontend

In a second terminal:

```bash
cd packages/mindmap
pnpm dev
```

Open `http://localhost:5180` in your browser.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React, Zustand, SVG/Canvas, Vite |
| Backend | Fastify, Drizzle ORM, PostgreSQL 16 |
| Real-time | WebSocket (Fastify plugin) |
| Build | Turborepo, pnpm workspaces, TypeScript |
| MCP | @modelcontextprotocol/sdk, stdio transport |

## Project Structure

```
packages/
  core/           Shared types, computation engine (rollups, scheduling, critical path)
  mindmap/        Frontend app -- mindmap editor + all views (kanban, gantt, list, calendar, etc.)
  server/         Backend API, auth, persistence, real-time sync
  integrations/   GitHub Issues sync, import/export, webhooks
  mcp/            MCP server for AI agent integration
```

## MCP Integration

MindBlown includes an MCP (Model Context Protocol) server that lets AI agents read and manage your projects.

### Setup

1. Build the MCP server:

```bash
cd packages/mcp
pnpm build
```

2. Get a JWT token by logging in via the API (see [API Reference](docs/api-reference.md)).

3. Add to your Claude Code or Cursor MCP config:

```json
{
  "mcpServers": {
    "mindblown": {
      "command": "node",
      "args": ["packages/mcp/dist/index.js"],
      "env": {
        "MINDBLOWN_API_URL": "http://localhost:3001",
        "MINDBLOWN_TOKEN": "<your-jwt-token>"
      }
    }
  }
}
```

See [docs/mcp-guide.md](docs/mcp-guide.md) for the full list of tools, resources, and example conversations.

## API Overview

All endpoints are under `/api/`. Authentication is via JWT Bearer token.

| Group | Endpoints | Description |
|-------|-----------|-------------|
| Auth | `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me` | Registration, login, current user |
| Maps | `GET/POST /api/maps`, `GET/PUT/DELETE /api/maps/:id` | Create, list, read, update, delete maps |
| Nodes | `POST /api/maps/:id/nodes`, `PUT/DELETE /api/maps/:id/nodes/:nodeId` | CRUD on nodes within a map |
| Cycles | `GET/POST /api/cycles`, `GET/PUT/DELETE /api/cycles/:id` | Sprint/cycle management |
| Comments | `GET/POST /api/maps/:mapId/nodes/:nodeId/comments` | Comments on nodes |
| Sharing | `POST /api/maps/:mapId/share`, `GET /api/maps/:mapId/permissions` | Permissions and public links |
| GitHub | `POST /api/integrations/github/connect`, import/link/create endpoints | GitHub Issues integration |
| WebSocket | `ws://localhost:3001/ws/maps/:id` | Real-time sync and cursor presence |

See [docs/api-reference.md](docs/api-reference.md) for full request/response documentation.

## Contributing

We welcome contributions. See the project documentation:

- [Product Vision](docs/product-vision.md) -- what we are building and why
- [Market Research](docs/market-research.md) -- competitor analysis
- [API Reference](docs/api-reference.md) -- REST API documentation
- [Self-Hosting Guide](docs/self-hosting.md) -- deployment and operations
- [MCP Guide](docs/mcp-guide.md) -- AI agent integration

To get started:

1. Fork the repository
2. Create a feature branch
3. Follow the Quick Start to run locally
4. Submit a pull request

## License

MIT
