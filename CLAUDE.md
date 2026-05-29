# MindBlown

A mindmap-based project management tool where ideas become plans.

## Project Documentation

- [Product Vision](docs/product-vision.md) — What we're building and why. **Read this first.**
- [Market Research](docs/market-research.md) — Competitor analysis

## Architecture

Monorepo with clear package boundaries:

```
packages/
  core/        — Shared data model, types, computation engine (rollups, scheduling, critical path)
  mindmap/     — The SVG/Canvas mindmap editor component
  views/       — Alternative views: kanban, gantt, list/table, calendar
  server/      — Backend: API, persistence, auth, real-time sync
  integrations/ — GitHub Issues sync, import/export, webhooks
```

## Core Concept

The **planning loop** is the heart of the product:
1. Map out work as a mindmap (visual, spatial, freeform)
2. Estimate effort and % complete on leaf nodes
3. Everything above auto-computes (weighted rollup)
4. Health signals propagate upward (on track / at risk / behind)
5. Schedule projections update in real-time

A node IS a task. No conversion step. Gradual enrichment.

**Mindmap = functional structure, Versions = release planning.**
The tree is organized by *what* (functional area), not *when* (release). Release planning uses three orthogonal entities:
- **Versions** — release containers (V1, V2). Has milestones and sprints.
- **Milestones** — key deliverables within a version. First-class entities, not node flags.
- **Sprints/Cycles** — time-boxed iterations within a version. Optional.
Nodes can be tagged with a version, milestone, and sprint independently of their tree position.

## Team

This project uses specialized agents. See `.claude/agents/` for definitions:

- **Atlas** — Architect. System design, data model, API contracts, tech decisions.
- **Canvas** — Frontend mindmap editor. SVG/Canvas rendering, node interactions, layouts.
- **Lens** — Frontend views. Kanban, Gantt, List/Table, Calendar — all from the same data.
- **Engine** — Backend. API, persistence, sync, computation (rollups, scheduling, critical path).
- **Bridge** — Integrations. GitHub Issues sync, import/export, external APIs.
- **Oracle** — MCP server. Exposes MindBlown to AI agents via Model Context Protocol.

## Development Principles

- Speed is a feature. Optimistic updates, local-first where possible.
- Progressive disclosure. Simple by default, powerful on demand.
- Opinionated defaults. Works without configuration.
- The mindmap is the primary surface. Other views are derived.
- Leaf nodes hold estimates and progress. Parents auto-compute.

## Working Principles

1. Don't assume. Don't hide confusion. Surface tradeoffs.
2. Minimum code that solves the problem. Nothing speculative.
3. Touch only what you must. Clean up only your own mess.
4. Define success criteria. Loop until verified.

## Feature Definition of Done

A feature isn't shipped until a real user can exercise it through their normal tools. Server-side correctness alone is not "done." This rule exists because the codebase has multiple surface layers (DB, REST, MCP, mindmap UI) and a feature added to fewer than all of them works in unit tests but is invisible to the end user.

### When adding a field to `Node` (or any cross-cutting type)

Every layer below must be touched in the same PR. Skipping any one silently breaks the feature at runtime for at least one consumer:

| # | Layer | File(s) | What changes |
|---|---|---|---|
| 1 | Type definition | `packages/core/src/types.ts` | Add the field to `Node` (and to `CreateNodeInput` / `UpdateNodeInput` if applicable) |
| 2 | DB schema | `packages/server/src/db/schema.ts` | Drizzle column definition |
| 3 | DB migration | `packages/server/src/db/migrate.ts` | Idempotent `ALTER TABLE … ADD COLUMN IF NOT EXISTS` so it lands on API startup |
| 4 | DB mapping | `packages/server/src/db/{helpers,nodes}.ts` | `dbNodeToCore` round-trip + insert/update pass-through |
| 5 | REST API | `packages/server/src/routes/nodes.ts` | Request body type + handler forwards the field to the DB layer |
| 6 | MCP tool-kit | `packages/tool-kit/src/tools/node.ts` | Zod schema on BOTH `create_node` and `update_node` |
| 7 | Frontend store | `packages/mindmap/src/store.ts` | Stub `Node` literals include the field (TypeScript fails otherwise) |
| 8 | Tests | each layer | Round-trip test in tool-kit; webhook/route test in server; type assertions in core |

### Common failure mode

Adding (2)–(5) but skipping (6). The feature works in HTTP curl but is invisible to MCP agents (Jenna, etc.) who only have the tool-kit surface. The DB column exists, the route accepts the field, the type system passes — and the feature is effectively dead for every agent-driven user.

If you are tempted to file an "expose X in the MCP" follow-up issue: stop. That follow-up IS the feature, not a polish item. Land it in the same PR.

### Sanity check before opening a PR

- `pnpm turbo typecheck` clean across all packages
- `pnpm turbo test` clean across all packages
- The new behavior is reachable through `packages/tool-kit` (the MCP surface), not only through direct HTTP calls
- A user invoking the relevant tool gets the new field on the round trip

### Valid follow-ups vs blocked surfaces

| Valid follow-up | Blocked surface (must ship in this PR) |
|---|---|
| Additional test coverage beyond the happy path | Any layer where the new field is silently dropped |
| Performance optimizations | MCP tool-kit zod schema |
| OpenAPI / docs updates | REST route accepting the field |
| Migration for backfilling existing data | DB column + migration |
| Rich-text variants of a description tail | Round-trip mapping in `dbNodeToCore` |
