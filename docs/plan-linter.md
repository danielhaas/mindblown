# Plan Linter — v1 Specification

*Status: surfaces 1 (`plan_lint` MCP tool) and 2 (plan-health panel + dismissals) implemented, plus the requirements pack (rules 9–11) and sprint (`cycleId`) scoping; the engine lives server-side (`packages/server/src/lint/engine.ts`) and both surfaces consume `GET /api/maps/:id/lint`. Moment-of-action nudges (surface 3) open. Companion to the "Guided Project Management" section of [product-vision.md](product-vision.md).*

---

## What it is

A set of **deterministic, explainable checks on plan quality**, run against a map's current state and its change history. Each finding names the problem, teaches the principle behind it in one sentence, and points at a concrete fix.

The linter is the productized form of "the tool guides you into good PM": it targets the four failure modes of untrained project management — no decomposition, missing/uncalibrated estimates, vague done-criteria, publish-and-forget plans — using signals the engine already computes.

**Coach, not autopilot.** The linter never mutates the plan. It surfaces findings; the user (or their AI agent) fixes them.

## Relationship to existing MI tools

The MI suite already computes most raw signals:

| Existing tool | Signals the linter reuses |
|---|---|
| `risk_scan` | stalled WIP, leaves without estimates, overruns, unassigned P0/P1, fragile critical path |
| `completion_forecast` / `get_estimation_accuracy` | calibration fudge factor (sum actual / sum estimate) |
| `remaining_work` | no-estimate count, largest remaining leaves |
| `change_events` substrate | per-field change timestamps (progress, dates, estimates) since 2026-04-14 |

The difference is intent: `risk_scan` answers *"what is at risk right now?"* (execution). The linter answers *"is this a well-formed plan, and what habit is missing?"* (hygiene + teaching). Overlapping checks share detection logic but the linter adds the **why** line, a **fix** action, and **dismissal**.

## v1 checks

Ordered basics-first: "when is it done / how much is left" hygiene before advanced practice. Severity is `warn` (materially distorts forecast or progress) or `info` (habit-forming nudge).

| # | Rule id | Fires when | Severity | Why-line (teaching sentence) | Fix action |
|---|---|---|---|---|---|
| 1 | `unestimated-leaf` | Leaf has no `effortEstimate` (reuse `risk_scan` no_estimate) | warn | "Unestimated work is invisible to the forecast — your finish date is under-counting." | Prompt estimate (offer `ai_estimate` draft) |
| 2 | `oversized-leaf` | Leaf estimate > **5 days** or > **15% of map total** | warn | "Small pieces get estimated far more accurately — projects built from small chunks succeed dramatically more often." | Suggest breakdown (offer `ai_breakdown`) |
| 3 | `stale-progress` | In-progress leaf with no `percentComplete` change in **7 days** (change_events; reuse `risk_scan` stalled) | warn | "A task that stops moving is usually stuck, not slow — surface it before it slips the schedule." | Prompt update / flag blocker |
| 4 | `overdue-unreplanned` | Leaf past `dueDate`, < 100%, and no date/estimate change since the due date passed | warn | "Plans only work if they're amended when reality diverges — an ignored overdue date makes every downstream date fiction." | Prompt re-plan (new date, split, or descope) |
| 5 | `calibration-drift` | Fudge factor outside **0.8–1.25** with ≥ 5 calibration samples | info | "Your estimates historically run {X}× — the forecast already corrects for this; consider sizing new estimates accordingly." | Show `get_estimation_accuracy` detail |
| 6 | `no-done-criteria` | Leaf with estimate ≥ 2 days and empty description | info | "A task without a definition of done tends to be 90% finished forever — one sentence of 'done means…' prevents it." | Prompt description (links to requirements register where present) |
| 7 | `stale-plan` | Map < 100% complete and no change_events at all in **14 days** | info | "A plan that isn't touched weekly is a document, not a plan — a 2-minute review keeps the forecast honest." | Suggest review (offer `status_digest`) |
| 8 | `dates-without-dependencies` | Map has ≥ 10 dated leaves and zero dependencies | info | "Without dependencies the schedule assumes everything can happen in parallel — the critical path is what makes a finish date real." | Point at dependency creation |

### Requirements pack (added 2026-07-16, evaluated map-wide)

| # | Rule id | Fires when | Severity | Why-line (teaching sentence) | Fix action |
|---|---|---|---|---|---|
| 9 | `uncovered-requirement` | Incomplete `must`-requirement with zero estimated effort in its subtree | warn | "A requirement without estimated implementation work exists only on paper — the forecast has no idea it is missing." | Break into estimated children (ai_breakdown) |
| 10 | `stale-acceptance` | Active acceptance whose node changed since sign-off (>1% progress drift or revision bump — same definition as the register) | warn | "A sign-off is a snapshot — when the work changes afterwards, the acceptance silently stops meaning anything." | Re-review with the acceptor: re-accept or revoke |
| 11 | `unscheduled-must` | Incomplete `must`-requirement with no version tag (own or inherited) | info | "A must-requirement with no release assignment is committed scope floating outside every plan." | Assign a target version |

Scoping also accepts `cycleId` (sprint) with the same ancestor-inheritance semantics — lint a sprint's contents before committing to it.

Thresholds above are **opinionated defaults, not configuration**. v1 exposes only `stalledDays`-style overrides where `risk_scan` already does; no settings sprawl.

## Output shape

Per finding: `{ ruleId, severity, nodeId, nodeText, detail, why, fix }` plus a summary header ("Plan health: 3 warnings, 2 suggestions"). Sorted by severity, then rule order (basics first), then node effort descending. Same scoping params as the MI suite: `nodeId` subtree, `versionId`, `milestoneId` with ancestor inheritance.

## Dismissals

- Stored per `(mapId, nodeId, ruleId)` — dismissing `oversized-leaf` on one node never hides it elsewhere.
- Map-level rule mute per `(mapId, ruleId)` for teams that reject a given opinion (e.g. sprints-only teams muting `dates-without-dependencies`).
- v1 semantics: dismissals are permanent until explicitly undone (the panel offers undo/unmute; re-firing on material change of the underlying value is a possible v2 refinement).
- Table: `lint_dismissals (map_id, node_id nullable, rule_id, dismissed_by, created_at)` — uniqueness enforced app-level (nullable node_id + pre-PG15).

## Surfaces (in ship order)

1. **MCP tool `plan_lint`** — 9th MI tool, same pattern as the suite (fetch via `api.getMap`, shared scoping helper — extract it now, this is the 4th consumer; plain-text output). This makes the linter available to AI agents and the chat panel immediately, per the standing "MCP tools first, defer dashboard UI" directive.
2. **Mindmap UI plan-health panel** — pull-based sidebar; badge with finding count, click-through jumps to the node. No toasts, no emails.
3. **Moment-of-action nudges** (separate, later milestone) — inline prompt when a node becomes an estimated leaf, or when the forecast slips past a target. Reuses the same rules; only the delivery differs. Strictly capped (max 1 pushed nudge per session).

Per the Feature Definition of Done: surface 1 must land with whatever server endpoint it needs in the same PR; the UI panel (surface 2) is a valid follow-up because the MCP surface already makes the feature reachable by real users.

## Non-goals (v1)

- No AI in the detection path (AI only assists fixes, via existing `ai_estimate` / `ai_breakdown`).
- No cross-map linting (each map lints alone; portfolio view later).
- No custom user-defined rules.
- No auto-fix. The linter never edits nodes.

## Open questions

1. `no-done-criteria` (#6): once the requirements register lands, should the check key on "has linked requirement" instead of "has description"? Probably yes — revisit after that branch merges.
2. `stale-progress` overlap: fold `risk_scan`'s stalled detection into a shared helper, or accept ~30 lines of duplication? (The MI memory says: extract on the 4th consumer — this is the 4th.)
3. Should dismissals sync to the change_events log for auditability? Leaning yes (`lint.dismissed` event type).
