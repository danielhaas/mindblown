# Plan Linter — v1 Specification

*Status: surfaces 1 (`plan_lint` MCP tool) and 2 (plan-health panel + dismissals) implemented, the daily self-check (`lint/daily.ts`) runs every active map once a day, plus the requirements pack (rules 9–11) and sprint (`cycleId`) scoping; the engine lives server-side (`packages/server/src/lint/engine.ts`) and both surfaces consume `GET /api/maps/:id/lint`. Moment-of-action nudges (surface 3) open. Companion to the "Guided Project Management" section of [product-vision.md](product-vision.md).*

---

## What it is

A set of **deterministic, explainable checks on plan quality**, run against a map's current state and its change history. Each finding names the problem, teaches the principle behind it in one sentence, and points at a concrete fix.

The linter is the productized form of "the tool guides you into good PM": it targets the four failure modes of untrained project management — no decomposition, missing/uncalibrated estimates, vague done-criteria, publish-and-forget plans — using signals the engine already computes.

**Coach, not autopilot.** The linter itself never mutates the plan. It surfaces findings; the user (or their AI agent) fixes them. Since 2026-09-28 a finding may *offer* one-click fixes (see "Fixes" below) — applied only on an explicit click or `plan_fix` call, through the same write path as a hand edit. The one exception is the **daily self-check** (below, since 2026-11-19): it applies a short list of safe fixes itself, per map switchable, and puts everything else in front of a person.

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
| 9 | `sprint-state` | An open sprint whose state disagrees with its dates (ended but still planned/active, started yesterday or earlier but still planned) or that overlaps another open sprint of the same version (a shared boundary day is not an overlap). One summary finding — the Sprint panel shows the same signals per sprint (`core/sprintSignals.ts`). | warn | "A sprint that ended while still planned, or never got activated, means the sprint view and every sprint-scoped number describe a plan nobody is running." | Start, complete or re-date the sprint; move overlapping sprints apart |
| 8 | `dates-without-dependencies` | Map has ≥ 10 dated leaves and zero dependencies | info | "Without dependencies the schedule assumes everything can happen in parallel — the critical path is what makes a finish date real." | Point at dependency creation |

### Requirements pack (added 2026-07-16, evaluated map-wide)

| # | Rule id | Fires when | Severity | Why-line (teaching sentence) | Fix action |
|---|---|---|---|---|---|
| 9 | `uncovered-requirement` | Incomplete `must`-requirement with zero estimated effort in its subtree | warn | "A requirement without estimated implementation work exists only on paper — the forecast has no idea it is missing." | Break into estimated children (ai_breakdown) |
| 10 | `stale-acceptance` | Active acceptance whose node changed since sign-off (>1% progress drift or revision bump — same definition as the register) | warn | "A sign-off is a snapshot — when the work changes afterwards, the acceptance silently stops meaning anything." | Re-review with the acceptor: re-accept or revoke |
| 11 | `unscheduled-must` | Incomplete `must`-requirement with no version tag (own or inherited) | info | "A must-requirement with no release assignment is committed scope floating outside every plan." | Assign a target version |

Scoping also accepts `cycleId` (sprint) with the same ancestor-inheritance semantics — lint a sprint's contents before committing to it.

### Sync pack (added 2026-09-27, evaluated on the scoped nodes, parents included)

The map, its linked issues and its repository are three views of one plan, and they drift: a coding agent marks a node done on PR open, a person closes the issue by hand, a worker bounces a ticket through the queue for a night. The first audit of a small private map found a dozen such drifts that none of the existing checks caught. These rules compare two sources and name both sides; they never decide which one is right.

| # | Rule id | Fires when | Severity | Why-line (teaching sentence) | Fix action |
|---|---|---|---|---|---|
| 12 | `status-progress-mismatch` | Leaf whose status is in the `done` category with `percentComplete` < 100, or at 100 % with a non-done status | warn | "Views group by status, forecasts read % complete — when the two disagree, the map is done in one view and open in another." | Set both; an automated done-step must write both |
| 13 | `done-parent-open-child` | Non-leaf with a done status whose rolled-up progress < 100 | warn | "A parent computes its progress from its children — marking it done while a child is open hides that child from every rollup." | Finish or move the children, or reopen the parent |
| 14 | `issue-state-mismatch` | Forge link `state` is `open` on a done node, or `closed` on a node that is not done (links without a stored state are ignored) | warn | "The issue tracker and the map are two views of one ticket — when they disagree, one of them is lying to whoever reads it." | Close the issue, or reopen the node |
| 15 | `done-without-pr` | Done node whose linked issue has no pull request referencing it on the forge. The route checks the **20** most recently updated done+linked nodes *in scope* per run (title says so when capped), counts a direct PR link as its own PR, caches answers per node revision for 15 min, only runs when the rule is part of the answer, and skips the rule when no forge is bound or the batch exceeds 8 s (a single failed lookup drops only that node) | info | "A ticket marked done with nothing in the repository referencing it is either non-code work or a claim nobody verified — worth a look either way." | Confirm the work landed; dismiss for non-code work |
| 16 | `stale-blocked-reason` | `blockedReason` set on a done node (on an open node the reason itself keeps it out of get_next_ticket / ready_nodes, so it is not stale) | info | "The node is done but still says it is blocked — the map keeps showing it, and its parents, as blocked." | Clear the reason |
| 17 | `claim-churn` | ≥ **5** `node.claimed` events on one node in the last **24 h** | warn | "A ticket that keeps bouncing back to the queue is a broken worker, not slow work — every bounce buries the change history a little deeper." | Check the worker; park the node until fixed |
| 18 | `stalled-unclaimed` | Open leaf in progress (an `in_progress`-category status, or 1–99 % without a todo status — a todo status is a queued ticket) with **no claim**, no blocker (reason, `blocked` tag or status, unfinished FS predecessor), no skip tag (`needs-human` …: a person already owns the rest) and **no change_event for 2 h** (falls back to `updatedAt` when the log has none); never on an archived map. Detail names progress, idle time and the last claim holder from `node.released`. Same list (core `findStalled`, server `lib/stalled.ts`) as the map payload's `stalled[]`, blocked_digest's stalled group, the Blocked panel and the PM Cockpit. A fix re-checks the node through the same list first (409 `STALE_FINDING` once claimed, changed or finished); a failed change-log read reports the rule skipped | warn | "A worker that dies mid-ticket leaves it in progress with no claim — the pull queue skips it (not todo) and the board shows it like live work, so nobody decides." | Mark it done, put it back in the queue (progress kept), or make the rest a person's step. After 24 h (a "Decision:" ticket after 2 h) it is also asked on the Questions card (below) |
| 19 | `broken-repo-connection` | Map-level (#513). The map names a repo (`github_repo_owner/name`) and either **no binding resolves it** (`getForgeRepoForMap` is null — the exact check behind the fleet's `repo: null`), or the binding resolves but **catch-up's last fetch with that binding was refused** (401, 404, or 403 that is not a rate limit). Refusals are keyed per binding (`app:<installation>` / `row:<id>:<updatedAt>`, `sync/forgeRefusals.ts`), so another workspace's bad token never flags this map, and a reconnect (which bumps the row's `updatedAt`) retires the refusal at once; in memory, cleared by the next good fetch, refilled one tick after a restart. Catch-up fetches a repo once per tick with the first binding it finds, so a second, broken binding of the same repo goes unseen. Server `lib/forgeProblem.ts`; the same `forgeProblem` rides on the map payload for the forge settings and the Fleet tab. A map without a repo named never fires | warn | "Issue sync, catch-up, webhooks, triage and the fleet all stop silently for a map whose repo connection is gone or refused — the map keeps looking fine while nothing reaches it." | Reconnect the repo; dismiss if the map is done with it |

### Stuck-work pack (added 2026-10-21)

Work that waits without anyone being asked. On Navy (21.10.2026) "blocked" meant four things — a question for Dan that never reached his card, a person's next step, a wait on another ticket, a leftover — five finished features sat at 85–90 % for up to 11 days, and a `needs-human` tag on the security-audit umbrella held all 18 findings overnight. The rule of thumb these rules enforce: **blocked = waiting on someone's answer (an ask) or on another ticket (a dependency); a person's step is `needs-human`; finished work is done.**

| # | Rule | Fires when | Severity | Why | Suggested fix |
|---|---|---|---|---|---|
| 20 | `blocker-without-question` | An open node (any depth) with a `blockedReason` and **no open ask** on the map's Questions card naming it (`unblocks.node_id` of an open asks row). Skipped for a map without a fleet — it has no card | warn | "A blocker holds the ticket (and everything below it) out of the queue, but only an ask on the Questions card reaches a person." | A question → ask it; a person's step → `needs-human`; waiting on a ticket → a dependency |
| 21 | `hold-on-parent` | An open parent whose skip tag or blocker holds open leaves below it (core `parentHolds`, the same reading as `dispatchHold`). One finding per parent with the count; the Dispatch card shows the same list (`heldByParents`). No fix: dismiss it when holding the subtree is intended | warn | "The pull queue skips the whole subtree — nothing on the tickets themselves says so." | Move the tag/blocker to the tickets that really wait |
| 22 | `misfiled-repo` | An open leaf that names a repo (a `Repo:` / `**Repo:**` line in the description, or a title starting `<repo>:`, `<repo> (…)`, `(<repo>)`, `<component> (<repo>):`) which another map the caller can see plans, while this map plans a different one (core `findMisfiledRepo`, services/misfiled.ts). Running-text mentions never count. Skipped for a map that plans no repo | warn | "One map plans one repo: the fleet works a ticket in this map's repo." | Move it (`move-to-map`); if it belongs here, dismiss and take the `misfiled?` tag off |

**Stalled work on the Questions card.** A `stalled-unclaimed` leaf with no change for **24 h** (`STALLED_ASK_AFTER_HOURS`; a ticket titled "Decision: …" / "Entscheid: …" after the stall's **2 h**, core `stalledAskAfterHours`) also shows as an ask on the map's Questions card (fleet maps only): id `stalled-<nodeId>`, answerer Dan, options *Done* / *Back to the queue* / *For a person*; any other answer text is kept as the person's next step. The asks are **derived on read** (services/derivedAsks.ts), not stored while open — a fleet push replaces the open set and would wipe them, and no collector can see them (no worker holds the ticket). Answering runs the matching fix below (`mark-done` / `requeue` / `needs-human`); the stall ends, so the question is gone on the next read. Every answer is still recorded as an asks row (answered fold, digest); *Later* and *Delegate* snooze the question for `ANSWER_RETENTION_DAYS`.

**Your steps (added 2026-10-21).** Every open ticket that carries a skip tag itself (`needs-human`, `kira-skip` …) is a row in a second card under the Questions, "Your steps — what only a person can do" (id `step-<nodeId>`, hint `ops-task`, core `humanSteps.ts`), so the card lists everything the Kanban "Needs you" badge counts: questions to answer, steps to do. The text is the node's "Next step (a person): …" line. *Done* = `mark-done`; *Fleet can do it* = `to-fleet`; any other text = `needs-human` with the text as the new next step. Derived on read like stalled asks; a node a collector's open question already names gets no step, blocker or stalled row.

### Fixes (added 2026-09-28)

A finding carries `actions: [{ id, label, bulk }]` when a deterministic write resolves it, most conservative first. The vocabulary (rule ids, action ids, which rule may offer which action) lives in `packages/core/src/lint.ts` so the engine, the MCP tool and the panel cannot drift. The panel shows the actions as buttons under the finding; `plan_lint` prints them as `[fix: a | b]` and `plan_fix(mapId, ruleId, nodeId, action)` applies one. A **Fix all** button appears on a rule only when every active finding offers exactly one action and it is `bulk`-safe (`clear-blocker`, `park` — the two writes that cannot fabricate progress or flip a done state). Hygiene rules (estimates, dates, descriptions) offer none — those need a human number.

`POST /api/maps/:id/lint/fix` refuses an action the rule does not offer (`LINT_FIX_ACTIONS`) and, for the four rules that depend on the map alone, recomputes the finding for that node first and answers `409 STALE_FINDING` when it no longer offers the action — a panel left open while a colleague edited cannot apply yesterday's fix.

| Action | Write (lint/fix.ts) | Offered by |
|---|---|---|
| `mark-done` | status → the workflow's done status **unless it already is one** (then only the number moves); `percentComplete` 100 on leaves only (parents roll up); the issue closes via outbound sync (subject to its PR-landed gate) | status-progress-mismatch, issue-state-mismatch (issue closed, leaf), stalled-unclaimed |
| `reopen` | status → first todo status, `completedAt` null, `percentComplete` 0 on leaves; the issue reopens via sync | status-progress-mismatch (done at < 100), done-parent-open-child, issue-state-mismatch (issue open, leaf), done-without-pr |
| `close-issue` | forge `updateIssue` closed/completed + the stored link `state`; a leaf below 100 % is brought to 100 first, because closing asserts the work is done and the forge's `closed` webhook echo is gated on exactly that | issue-state-mismatch (node done) |
| `reopen-issue` | forge `updateIssue` open/reopened + the stored link `state`, node untouched | issue-state-mismatch (issue closed) |
| `clear-blocker` | `unblockNode`: blockedReason null, `blocked` tag removed, status back to todo if it was blocked | stale-blocked-reason |
| `park` | status `blocked`, `blocked` tag, claim released, blockedReason kept or "Parked from Plan health: …" | claim-churn |
| `requeue` | status → first todo status, claim released, **progress kept** (unlike `reopen`, which says "start over") | stalled-unclaimed |
| `needs-human` | `needs-human` tag; the blocker text (and the `note`, e.g. a free-text answer) go to the top of the description as "Next step (a person): …"; blockedReason null, `blocked` tag off, a status named `blocked` → in progress (or todo at 0 %); claim released | stalled-unclaimed, blocker-without-question; a step answered with free text |
| `to-fleet` | every skip tag off, status → first todo status, progress kept, claim released — "Fleet can do it" | (no rule) a step on the Questions card |
| `move-to-map` | detection runs again (`409 NOT_MISFILED` when the node no longer names another map's repo), then `move_node_to_map` to the suggested map's root: same node id; version, sprint, phase cleared; issue links into another repo and dependencies across the maps dropped with a note; claim released (refused while an agent runs); the `misfiled?` hold off | misfiled-repo |

The link a fix acts on is the one the finding named: the node's first forge link that is an issue (not a PR) with a synced state. Every node-side fix records field changes and the claim trail, broadcasts, and runs the outbound sync — it looks exactly like the same edit made by hand, attributed to the user who clicked; issue-side fixes leave an `issueState` change event. Known limit: the webhook / catch-up "already done here" gate still reads the literal status `done` or 100 % (`looksDoneInMB`), not the workflow's done category — a follow-up.

Deliberately not a rule: the `#N ` prefix on imported node titles. The import writes it on purpose; that the outbound title sync copies it back onto the forge issue is a sync bug to fix at the source, not a finding to dismiss on every ticket.

### Daily self-check (added 2026-11-19)

A manual sweep on 19.11.2026 found stranded work, stale blockers, done-at-0 % tickets and silent blockers across four maps. plan_lint knew almost all of it, but nothing ran it and nothing acted on it. Now a job does (`packages/server/src/lint/daily.ts`):

- **When.** Every 10 minutes the server checks the clock; from `LINT_DAILY_HOUR` (default 06:00, in `DIGEST_MAIL_TZ`, default Europe/Zurich — before the 08:00 mail) it runs plan_lint with **scope all** on every active (not archived) map not yet checked that local day. On demand: `POST /api/maps/:id/lint/runs` or the MCP tool `lint_runs` with `run: true` (edit on the map; replaces today's run). Dismissed findings and muted rules are left alone, as in the panel.
- **What it does with a finding** is declared per rule in `packages/core/src/lint.ts`, `LINT_DAILY`:

| Handling | Rules | What happens |
|---|---|---|
| `auto` | `status-progress-mismatch`, `stale-blocked-reason`, `stalled-unclaimed` | The safe case gets its fix through `applyLintFix` — the plan_fix path, so change history, claim trail, live update and outbound sync as for a hand edit (attributed to no user). Safe cases: a **done leaf below 100 %** → `mark-done`; a blocker that is a **fleet worker's own note** (`Fleet worker <id>: …`) on a done node → `clear-blocker`; a stalled ticket with a **merged PR** on record (`mergedPrNumber` on a link, or the linked-PR mirror `merged`) → `mark-done`, else idle **24 h** and a worker's orphan (`isOrphanRequeueable`) → `requeue`, else under 24 h → wait. Any other case — a person's blocker text, 100 % without a done status, a never-claimed or "Decision:" stall — becomes an ask. A failed fix is listed as failed and asked. |
| `ask` | `blocker-without-question`, `issue-state-mismatch`, `broken-repo-connection`, `misfiled-repo`, `done-parent-open-child` | One row per finding on the map's Questions card (`lint-<rule>-<node>`; a map-level finding sits on the root node), to the map owner. Options: the finding's fixes by label, plus **Leave it**. An option runs that fix (`plan_fix` write path); Leave it is recorded and nothing changes; free text on a rule that offers `needs-human` becomes that person's next step. |
| `digest` | `unestimated-leaf`, `oversized-leaf`, `ai-draft-estimate`, `no-done-criteria`, `stale-plan`, `done-without-pr` | Counted; one line per map in the daily mail to the map's admins: "Navy App: 24 without estimate, 3 oversized, 7 AI drafts to confirm", linking to the map with its plan-health panel open (`?map=<id>&lint=1`). A mail goes out for hygiene lines alone. |
| `off` | the rest | Not part of the daily check; the panel and plan_lint still show them. |

- **Asks once.** The asks are derived on read from the map's newest run (`services/derivedAsks.ts`), not stored while open — a fleet push replaces the stored open set. The id is per rule and node and the run keeps a finding's first-seen time, so tomorrow's run shows the **same** row, not a new one. An answered row stays answered while its question reads the same (Leave it does not come back tomorrow); Later / Delegate snooze it like other derived rows. A node that already has another derived row (a blocker, stalled, step, question … row) gets no lint row — that row is its question; so the `stalled-unclaimed` ask is the existing `stalled-<node>` row.
- **Switch.** Per map, `lintAutoFix` (`update_map lintAutoFix`, `PUT /api/maps/:id`): rule id → `false` turns that rule's auto-fix off and its findings become asks. A missing key is on.
- **Run summary.** Each run is stored per map and local day (`lint_runs`): the fixes applied (each listed, failed ones with why), the asks, the counts. `GET /api/maps/:id/lint/runs?days=N`, `GET /api/lint/runs?days=N` (every map the caller can view), MCP `lint_runs`.
- **Not covered here:** ready work outside the dispatch gate is not a lint rule, so the daily check does not see it; it gets its own Questions-card ask in a separate change ("ready work outside the dispatch gate is never silent").

**Wiring in a new rule:** add the id to `LINT_RULE_IDS`, the rule to `computePlanLint` (engine.ts), its fixes to `LINT_FIX_ACTIONS` — and its entry in `LINT_DAILY` (the type is a `Record` over every rule id, so forgetting it does not compile). `ask` and `digest` (with a `label`) need nothing else: the daily check picks it up from the next run. `auto` also needs the safe case in `autoAction` (lint/daily.ts); without it the finding is asked.

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
- No auto-fix in plan_lint and the panel — they never edit nodes. The daily self-check (above) applies only the `auto` rules' safe cases, switchable per map.

## Open questions

1. `no-done-criteria` (#6): once the requirements register lands, should the check key on "has linked requirement" instead of "has description"? Probably yes — revisit after that branch merges.
2. `stale-progress` overlap: fold `risk_scan`'s stalled detection into a shared helper, or accept ~30 lines of duplication? (The MI memory says: extract on the 4th consumer — this is the 4th.)
3. Should dismissals sync to the change_events log for auditability? Leaning yes (`lint.dismissed` event type).
