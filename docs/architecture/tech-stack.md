# Technology Stack

Technology decisions for MindBlown. For each choice: what we considered, what we picked, and why.

---

## Summary

| Layer | Choice |
|-------|--------|
| Frontend framework | React with TypeScript |
| Mindmap rendering | SVG (with Canvas fallback for 1000+ nodes) |
| State management | Zustand + IndexedDB (local-first) |
| Backend runtime | Node.js (Express/Fastify) |
| Database | PostgreSQL |
| Real-time sync | WebSockets (via Socket.IO) |
| API style | REST with JSON |
| Monorepo tooling | pnpm workspaces + Turborepo |
| Testing | Vitest + Playwright |
| Deployment | Docker Compose (self-host) |

---

## Frontend Framework

### Options Considered

1. **React** — Largest ecosystem, best hiring pool, mature tooling. Verbose but predictable. Performance requires care (memo, virtualization).
2. **Svelte (SvelteKit)** — Smaller bundle, reactive by default, less boilerplate. Smaller ecosystem, fewer libraries for complex canvas/SVG interactions.
3. **SolidJS** — React-like API with fine-grained reactivity. Excellent performance. Small ecosystem, less battle-tested for large apps.

### Choice: React

**Why:** The mindmap editor is the hardest frontend challenge. React has the deepest ecosystem for this kind of work — libraries for drag-and-drop, virtual scrolling, accessible trees, keyboard management, and rich text editing are all mature. The team ramp-up cost is lowest. TypeScript support is best-in-class.

We pay for React's re-rendering overhead with careful memoization in the mindmap renderer, but we gain an ecosystem where almost every problem has a proven solution. For an open-source project that needs contributors, React is the pragmatic choice.

**Build tool:** Vite. Fast dev server, good production builds, first-class React support.

---

## Mindmap Rendering

### Options Considered

1. **SVG** — Native browser rendering. Each node is a DOM element. Easy hit detection, accessibility, CSS styling. Performance degrades at very high element counts (5000+).
2. **Canvas 2D** — Single pixel buffer, manual hit detection. Better raw performance for large counts. Harder to make accessible, no native text editing.
3. **WebGL (via PixiJS / Three.js)** — GPU-accelerated. Overkill for 2D node rendering. Complex setup, poor text rendering.

### Choice: SVG

**Why:** Our target is 500+ nodes with smooth interaction. SVG handles this comfortably — modern browsers can render thousands of SVG elements at 60fps with proper techniques (virtualization of off-screen nodes, `will-change` hints, avoiding expensive filters).

SVG gives us critical advantages for a mindmap:
- Each node is a real DOM element: screen readers work, `querySelector` works, CSS transitions work, browser DevTools inspect individual nodes.
- Text rendering is native and crisp at any zoom level.
- Hit detection is free (DOM events on each element).
- Connection lines between nodes are simple SVG `<path>` elements.
- CSS-based theming and conditional styling (overdue = red border) are trivial.

Canvas would require reimplementing text layout, hit testing, accessibility, and cursor management. The engineering cost doesn't justify it at our scale.

**Escape hatch:** If a user creates a map with 2000+ nodes, we can virtualize — only render nodes visible in the viewport. This is straightforward with SVG since we control the viewBox. If we ever need Canvas, we can swap the renderer behind the same component API without changing the data model or state management.

**Zoom and pan:** Implemented via SVG `viewBox` transforms. Smooth zoom with `wheel` events, pan with pointer drag. No library needed — this is ~100 lines of code with SVG.

---

## State Management

### Options Considered

1. **Redux Toolkit** — Battle-tested, large ecosystem, verbose. Good for complex state with many reducers.
2. **Zustand** — Minimal API, great TypeScript support, React-friendly. No boilerplate. Supports middleware for persistence.
3. **Jotai/Recoil** — Atomic state. Good for fine-grained reactivity. More complex mental model for tree-structured data.

### Choice: Zustand + IndexedDB

**Why:** Zustand is the right size for this project. It gives us a single store for the node tree with fine-grained subscriptions (a node component only re-renders when its specific data changes). The middleware system lets us plug in IndexedDB persistence and undo/redo cleanly.

### Local-First Architecture

This is critical for achieving Linear-like speed. The architecture:

```
┌─────────────────────────────────┐
│  Zustand Store (in-memory)      │  ← All reads come from here. Instant.
│  - nodes: Map<NodeId, Node>     │
│  - computed cache                │
│  - UI state (selection, zoom)   │
└───────────┬─────────────────────┘
            │ writes
            ▼
┌─────────────────────────────────┐
│  IndexedDB (persistent)         │  ← Survives refresh. Offline-capable.
│  - Full node tree per map       │
│  - Pending mutations queue      │
└───────────┬─────────────────────┘
            │ background sync
            ▼
┌─────────────────────────────────┐
│  Server (PostgreSQL)            │  ← Source of truth for collaboration.
│  - Receives mutations           │
│  - Broadcasts to other clients  │
└─────────────────────────────────┘
```

**How it works:**

1. **Every user action writes to Zustand immediately.** No waiting for the server. The UI updates in the same frame.
2. **Zustand middleware persists to IndexedDB.** This happens asynchronously — the user doesn't wait for it.
3. **A background sync worker sends mutations to the server.** Mutations are queued and sent in order. If offline, the queue grows. When back online, it drains.
4. **The server broadcasts changes to other clients via WebSocket.** Other clients apply the changes to their Zustand store.
5. **On page load, hydrate Zustand from IndexedDB first** (instant), then fetch latest from server (background).

**Conflict resolution:** For Phase 1, last-write-wins at the field level is sufficient. Each mutation carries a timestamp and the field path (`nodes.{id}.status`). The server merges by latest timestamp per field. This handles 95% of real-world collaboration — two people rarely edit the same field of the same node simultaneously.

For Phase 2+, if we need true offline-first with guaranteed convergence, we can adopt Yjs or Automerge CRDTs for the node tree. The Zustand + sync architecture makes this a swap-in — the store interface doesn't change.

**Undo/Redo:** Zustand middleware that maintains a stack of inverse operations. Each mutation generates its inverse at creation time. Undo pops the inverse stack and applies it. This is more efficient than full-state snapshots and works with the sync system (undos are just new mutations).

---

## Backend Runtime

### Options Considered

1. **Node.js (TypeScript)** — Same language as frontend. Huge ecosystem. Good enough performance for our workload.
2. **Go** — Excellent performance, great concurrency. Different language from frontend means duplicated type definitions.
3. **Rust (Axum/Actix)** — Best performance. Highest learning curve. Overkill for an API server.

### Choice: Node.js with TypeScript

**Why:** Shared language with the frontend means shared type definitions in `packages/core/`. When we change the Node schema, both frontend and backend see the change in one PR. This eliminates an entire category of bugs (serialization mismatches, field name typos, type drift).

The performance ceiling of Node.js is well above our needs. We're serving tree-structured JSON to clients — not doing heavy computation server-side. The scheduling/critical-path algorithms run client-side (where the node tree already lives in memory).

**Framework:** Fastify. Faster than Express, built-in schema validation, TypeScript-first, good plugin ecosystem. Lightweight enough to not feel like a framework.

---

## Database

### Options Considered

1. **PostgreSQL** — Full-featured relational DB. JSONB for flexible fields, array types for `childrenIds`/`tags`, excellent indexing. Well-understood operational story.
2. **SQLite (via Turso/libSQL)** — Simpler deployment, embedded. Good for self-hosting. Limited concurrent writes, no native array types.
3. **MongoDB** — Document model fits our node schema naturally. Weaker for cross-collection queries, less predictable performance.

### Choice: PostgreSQL

**Why:** Our data is structured (nodes, maps, users, cycles) with relationships (parent/child, dependencies, assignees). PostgreSQL handles this naturally. Key advantages:

- **JSONB** for `customFields`, `dependencies`, and `externalLinks` — flexible schema where we need it, strict schema where we don't.
- **Array types** (`uuid[]`, `text[]`) for `childrenIds`, `assigneeIds`, `tags` — with GIN indexes for efficient lookups.
- **Transactions** for tree operations (move a node = update old parent, new parent, and node in one atomic operation).
- **Self-hosting story:** PostgreSQL is the most commonly available database. Every cloud provider offers it. Docker setup is one line.
- **Migration tooling:** Mature ecosystem (we'll use Drizzle ORM with its migration system).

**ORM:** Drizzle. Type-safe, lightweight, generates migrations, doesn't hide SQL. Avoids the pitfalls of heavy ORMs (Prisma's slow cold starts, TypeORM's complexity) while still giving us type safety from database schema to API response.

**Why not SQLite?** For a single-user self-hosted setup, SQLite would be simpler. But our collaboration features require concurrent reads/writes from multiple connections (WebSocket server + API routes). PostgreSQL handles this natively. We may offer a SQLite mode for single-user self-hosting in the future.

---

## Real-Time Sync

### Options Considered

1. **WebSockets (Socket.IO)** — Bidirectional, low latency, well-supported. Battle-tested library with fallbacks.
2. **Server-Sent Events (SSE)** — Server-to-client only. Simpler, works through proxies. Client-to-server still needs REST.
3. **CRDT-based (Yjs/Automerge)** — True offline-first conflict resolution. Higher complexity, larger payloads.

### Choice: WebSockets via Socket.IO

**Why:** We need bidirectional communication — the client sends mutations, the server broadcasts them to other clients. WebSockets are the natural fit.

Socket.IO specifically because:
- Automatic reconnection with exponential backoff.
- Room-based broadcasting (one room per map — only clients viewing a map receive its mutations).
- Fallback to HTTP long-polling if WebSockets are blocked.
- Mature, well-documented, handles edge cases we'd otherwise have to build.

**Message protocol:** Mutations are the unit of sync. A mutation is:

```typescript
interface Mutation {
  id: string;           // unique mutation ID
  mapId: MapId;
  nodeId: NodeId;
  field: string;        // e.g. 'text', 'status', 'x'
  value: unknown;       // new value
  timestamp: number;    // client timestamp
  userId: UserId;
}
```

The client sends mutations to the server. The server persists them to PostgreSQL, then broadcasts to all other clients in the map's room. Each client applies incoming mutations to its Zustand store.

**Cursor presence:** Separate lightweight channel. Each client broadcasts its selected node and cursor position every 100ms (throttled). This data is ephemeral — not persisted.

**Why not CRDTs now?** Yjs/Automerge add significant complexity (document model, encoding, garbage collection). Our last-write-wins per-field approach handles real-time collaboration well enough for Phase 1. We can layer in CRDTs later if we need true offline-first (the mutation-based architecture is compatible).

---

## API Style

### Options Considered

1. **REST** — Simple, cacheable, well-understood. One endpoint per resource.
2. **GraphQL** — Flexible queries, reduces over-fetching. Higher complexity, harder caching.
3. **tRPC** — End-to-end type safety, no codegen. Ties frontend to backend tightly.

### Choice: REST

**Why:** Our API surface is simple. The main operations are:

- Load a map: `GET /api/maps/:id` (returns all nodes)
- Apply mutations: `POST /api/maps/:id/mutations` (batch of field-level changes)
- CRUD for maps, users, workspaces, cycles
- Integration endpoints

GraphQL would over-complicate this. We rarely need to fetch partial data — the client loads the full node tree for a map (it needs all of it for rollup computation). GraphQL's query flexibility solves a problem we don't have.

tRPC is appealing for type safety but limits us to TypeScript clients. We want the API to be usable by third-party integrations in any language.

**Response format:** JSON. All timestamps as ISO 8601 strings. All IDs as UUIDv7 strings. Consistent error shape:

```typescript
interface ApiError {
  error: {
    code: string;       // machine-readable, e.g. 'NODE_NOT_FOUND'
    message: string;    // human-readable
  };
}
```

**Validation:** Zod schemas shared between `packages/core/` (type definitions) and `packages/server/` (request validation). Define once, validate everywhere.

---

## Monorepo Tooling

### Options Considered

1. **pnpm workspaces + Turborepo** — Fast installs (pnpm), cached builds (Turbo). Minimal config.
2. **Nx** — Full-featured monorepo tool. More powerful but more complex. Better for very large repos.
3. **npm workspaces + custom scripts** — Simplest. No caching, no parallelism.

### Choice: pnpm workspaces + Turborepo

**Why:** We have 5 packages with clear dependencies. pnpm workspaces handles linking and dependency hoisting. Turborepo adds build caching and parallel task execution with near-zero config.

**Package structure:**

```
packages/
  core/           → shared types, schemas, computation functions
  mindmap/        → React mindmap editor component
  views/          → Kanban, Gantt, List, Calendar components
  server/         → Fastify API, WebSocket, persistence
  integrations/   → GitHub, Jira, etc. sync logic
apps/
  web/            → Vite React app (imports mindmap/ and views/)
```

**Why pnpm over npm/yarn?** Strict dependency isolation (no phantom dependencies), faster installs, efficient disk usage via hard links. The strictness catches dependency issues early.

**Turborepo config:** Build `core` first (everything depends on it), then build packages in parallel, then build the app.

---

## Testing Strategy

### Options Considered

1. **Vitest** — Vite-native, fast, Jest-compatible API. Best for our Vite-based setup.
2. **Jest** — Industry standard. Slower, needs more config for TypeScript/ESM.
3. **Playwright** — Browser automation for E2E tests. Best-in-class reliability.
4. **Cypress** — Alternative E2E. Heavier, slower, but good DX.

### Choice: Vitest (unit/integration) + Playwright (E2E)

**What to test, in priority order:**

1. **`packages/core/` — computation functions (CRITICAL)**
   - Effort rollup: verify weighted sums across various tree shapes.
   - Progress rollup: verify weighted averages, unestimated node handling.
   - Health signal: verify threshold logic, propagation rules.
   - Scheduling: verify forward pass, all 4 dependency types, lag handling.
   - Critical path: verify identification of zero-float chains.
   - Tree operations: insert, move, delete, re-parent with invariant checks.
   - Dependency cycle detection.
   - These are pure functions — fast, deterministic, no mocking needed.

2. **`packages/server/` — API routes**
   - Request validation (Zod rejects bad input).
   - Auth/permission checks.
   - Mutation application and persistence.
   - Integration tests against a real PostgreSQL (via Testcontainers or a test database).

3. **`packages/mindmap/` — interaction tests**
   - Keyboard shortcuts (Tab creates child, Enter creates sibling, etc.).
   - Drag and drop (node reordering, re-parenting).
   - Zoom and pan behavior.
   - Use Playwright component tests or React Testing Library.

4. **E2E (Playwright) — critical user flows**
   - Create a map, add nodes, estimate, see rollup.
   - Switch between views (mindmap → kanban → list).
   - Collaborative editing (two browser contexts).
   - Import/export.

**Coverage target:** 90%+ for `packages/core/`. This is the most important code — bugs in rollup or scheduling are data-corruption-level severity. Lower targets for UI code where visual testing matters more than line coverage.

---

## Deployment

### Options Considered

1. **Docker Compose** — Single command to run everything. Best for self-hosting.
2. **Kubernetes** — Scalable, complex. Overkill for early stage and self-hosters.
3. **Serverless (Vercel/Cloudflare)** — Good for frontend, awkward for WebSockets and PostgreSQL.

### Choice: Docker Compose (primary), with cloud deploy option

**Self-hosting story (our primary deployment model):**

```yaml
# docker-compose.yml — the entire stack
services:
  app:
    image: ghcr.io/mindblown/mindblown:latest
    ports:
      - "3000:3000"
    environment:
      - DATABASE_URL=postgresql://...
    depends_on:
      - db

  db:
    image: postgres:17
    volumes:
      - pgdata:/var/lib/postgresql/data
    environment:
      - POSTGRES_DB=mindblown

volumes:
  pgdata:
```

**One container for the app.** The Fastify server serves both the API and the static frontend assets. No nginx, no separate frontend container. Simple.

`docker compose up` and you have MindBlown running. This is the Plane/Gitea model — one command to self-host.

**For cloud/SaaS deployment (future):**
- Frontend: static assets on CDN (Cloudflare Pages or similar).
- Backend: containerized on Fly.io, Railway, or similar (supports WebSockets natively).
- Database: managed PostgreSQL (Neon, Supabase, or provider-managed).
- The same Docker image works everywhere.

**Environment configuration:** All settings via environment variables. No config files to manage. Sensible defaults for everything — the only required variable is `DATABASE_URL`.

---

## Decisions We're Deferring

These don't need to be decided now:

- **Auth provider:** For self-hosting, start with simple email/password (bcrypt + JWT). Add OAuth providers (GitHub, Google) in Phase 5. Consider Lucia or Auth.js when we get there.
- **File storage (attachments):** Local filesystem for self-hosted, S3-compatible for cloud. Not needed until we support file attachments on nodes.
- **Search engine:** PostgreSQL full-text search is sufficient initially. Consider Meilisearch if search becomes a core feature.
- **Caching layer:** Not needed. Our local-first architecture means the client rarely hits the server for reads. If the server becomes a bottleneck, add Redis.
- **CRDT library:** Evaluate Yjs vs Automerge when we need true offline-first. The current mutation-based sync is sufficient for connected collaboration.
