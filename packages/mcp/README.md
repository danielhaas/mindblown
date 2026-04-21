# @mindblown/mcp

MCP server for [MindBlown](https://mind.project.li) — a mindmap-based project
management tool where every node is a task.

Exposes your MindBlown workspace to AI agents (Claude Code, Claude Desktop, any
MCP client) over stdio so they can read maps, edit nodes, track progress, run
schedule projections, import GitHub issues, and more.

## Setup

1. Sign in at https://mind.project.li (or your self-hosted instance).
2. Open **Workspace Settings → Connect to Claude Code** and click *Generate
   connection command*. This mints a 1-year token and hands you a one-line
   install command.
3. Paste the command into your terminal and restart your MCP client.

The command looks like:

```
claude mcp add mindblown \
  --env MINDBLOWN_API_URL=https://mind.project.li \
  --env MINDBLOWN_TOKEN=<your-token> \
  -- npx -y @mindblown/mcp
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `MINDBLOWN_API_URL` | yes | Base URL of your MindBlown API (e.g. `https://mind.project.li`). |
| `MINDBLOWN_TOKEN`   | yes | Bearer token. Generate from the web UI — do not paste a session JWT. |

## Available tools

A few dozen tools covering maps, nodes, estimates, sprints, versions,
dependencies, AI breakdowns, GitHub sync, and reporting (burnup, WIP,
forecast, risk scan, standups). Your MCP client will enumerate them on
connect.

## License

MIT.
