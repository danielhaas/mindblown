# Hooking MindBlown into your Claude Code + GitHub repo

This walks you through connecting MindBlown (the hosted instance at `https://mind.project.li`) to **your** Claude Code so the model can plan and update tickets for you, and to **your** GitHub repo so issues stay in sync.

You'll end up with:

- A MindBlown account + map
- The `mindblown` MCP server wired into Claude Code (works in any project directory)
- A GitHub repo connected to the map so nodes ↔ issues sync both ways

Total time: ~5 minutes.

---

## What you need first

- **Node.js 20+** (`node --version`) — needed for `npx`
- **Claude Code** installed (`claude --version`)
- **A GitHub repo** you own and a **personal access token** with `repo` scope ([create one here](https://github.com/settings/tokens/new?scopes=repo))
- A working internet connection — you'll be talking to the hosted backend, not running it yourself

You do **not** need to clone this repo, run a database, or set up Docker. The MCP bridge is published on npm and `npx` will fetch it on demand.

---

## Step 1 — Make a MindBlown account and grab a token

Open `https://mind.project.li` and register an account. Then trade your password for a JWT the MCP server will use:

```bash
curl -s -X POST https://mind.project.li/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com", "password": "your-password"}'
```

The response includes a `token` field. Copy it. Tokens last 7 days — when it expires you'll get `401 Unauthorized` from the MCP server and you just rerun this and update your config.

---

## Step 2 — Register the MCP server with Claude Code

One command, run from anywhere:

```bash
claude mcp add mindblown \
  --transport stdio \
  --scope user \
  -e MINDBLOWN_API_URL=https://mind.project.li \
  -e MINDBLOWN_TOKEN=<paste-jwt-from-step-1> \
  -- npx -y @mindblown/mcp
```

- [`@mindblown/mcp`](https://www.npmjs.com/package/@mindblown/mcp) is the published bridge — `npx -y` downloads and caches it on first run.
- `--scope user` makes it available in every Claude Code session you start, in any directory. Use `--scope project` instead if you only want it in the current repo (writes a `.mcp.json` there).
- The `--` is mandatory — everything after it is the command Claude Code invokes.

Verify:

```bash
claude mcp list
# mindblown: npx -y @mindblown/mcp - ✓ Connected
```

**Restart any open Claude Code sessions** — MCP servers are loaded at session start, so a session that was already running won't see the new tools.

> If you'd rather edit the config by hand, the entry goes in `~/.claude.json` under `mcpServers.mindblown` — not `~/.claude/settings.json`, that's a different file.

---

## Step 3 — Create your first map

Easiest: open `https://mind.project.li`, click **New map**, give it a name, and you're in.

Or do it from Claude Code, which is the whole point:

> "Create a MindBlown map called 'Acme Rewrite' and add top-level branches for Backend, Frontend, and Infra."

Claude calls `create_map` and `create_node` and your map appears at `https://mind.project.li`.

---

## Step 4 — Connect your GitHub repo

In the MindBlown UI:

1. Open the map you just created.
2. Open the **GitHub panel** from the sidebar.
3. Paste your GitHub PAT, the repo **owner**, and the repo **name**, then click **Connect GitHub**. The status flips to "Connected to owner/repo" when it works.

Once connected, three flows are available on every node:

- **Link to existing issue** — paste a URL or number; the node mirrors that issue's status, labels, milestone, and assignee.
- **Create issue from node** — promote a leaf into a new GitHub issue. Title = node label, body = description, assignee carries over.
- **Import issues** — bulk-pull issues into the map. Re-runs are dedupe-safe (matches by externalId, then by title).

Sync direction:

- **MindBlown → GitHub:** changes to text, description, % complete, status, tags, priority, and milestone push to the linked issue. % complete = 100 closes the issue.
- **GitHub → MindBlown:** when a linked issue closes, the node jumps to 100% and rolls up through its parents. Project-board column moves update node status.

---

## Step 5 — Drive it from Claude Code

Restart your Claude Code session, `cd` into your repo, and try a few prompts:

> "List my MindBlown maps."

> "Import all open issues from `acme/api` into my Acme Rewrite map under the Backend branch."

> "Break down 'Auth refactor' into 5–8 child tasks with effort estimates, then create a GitHub issue for each leaf."

> "What's blocking us this week? Run a risk scan."

> "Mark issue #142 as 50% done and update its MindBlown node."

Claude has ~57 tools available — maps, nodes, sprints, versions, GitHub sync, AI breakdowns, schedule forecasting. The most useful day-to-day are `get_map`, `create_node`, `set_progress`, `set_status`, `import_github_issues`, `create_github_issue_from_node`, `risk_scan`, and `ai_standup`.

---

## Troubleshooting

**`MCP servers have disconnected: mindblown`** — the bridge can't reach the API. Check that `MINDBLOWN_API_URL=https://mind.project.li` (no trailing slash, with `https`) and that your token isn't expired.

**`401 Unauthorized`** — token expired (7-day lifetime). Re-run the login curl from Step 1, then:

```bash
claude mcp remove mindblown --scope user
claude mcp add mindblown ...   # same command as Step 2 with the new token
```

**Tools don't show up in Claude Code** — you didn't restart the session after `claude mcp add`. MCP servers load at startup. Run `claude mcp list` to confirm `✓ Connected`, then start a fresh `claude` session.

**GitHub sync silently doesn't push** — confirm the GitHub panel still says "Connected" (PATs can be revoked) and that the node has a linked issue. Newly created nodes don't sync until they're linked or promoted via "Create issue from node".

**`npx` can't find `@mindblown/mcp`** — make sure you have Node 20+ (`node --version`). If you're behind a corporate proxy, `npx` may fail to reach the npm registry; configure `npm config set registry` or set `HTTPS_PROXY` accordingly. To force a fresh download instead of using a stale cache: `npx --yes --package=@mindblown/mcp@latest mindblown-mcp`.

**Want to pin a specific version?** Replace `npx -y @mindblown/mcp` with `npx -y @mindblown/mcp@0.1.0` in the `claude mcp add` command.

---

That's it. Once it's wired up, Claude can manage the project plan and the issue tracker in the same conversation, and you stop double-entering tickets.
