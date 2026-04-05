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
