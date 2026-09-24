# Self-Hosting MindBlown

This guide covers deploying MindBlown on your own infrastructure.

---

## Requirements

- **Node.js** 20 or later
- **PostgreSQL** 16 or later
- **pnpm** 9 or later (for building from source)
- **Docker and Docker Compose** (optional, for containerized deployment)

---

## Option A: Docker (Recommended)

The simplest way to run MindBlown in production.

### 1. Clone the repository

```bash
git clone https://github.com/your-org/mindblown.git
cd mindblown
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and set production values (see [Environment Variables](#environment-variables) below). At minimum, change `JWT_SECRET`.

### 3. Start everything

```bash
docker compose up -d
```

This starts:
- **PostgreSQL 16** on port 5433
- **MindBlown API** on port 3001

The database is automatically migrated and seeded on first start.

### 4. Verify

```bash
curl http://localhost:3001/api/health
```

You should see `{"status":"ok","timestamp":"..."}`.

### Rebuilding after updates

```bash
git pull
docker compose build
docker compose up -d
```

---

## Option B: Manual

### 1. Set up PostgreSQL

Install PostgreSQL 16+ and create a database:

```bash
sudo -u postgres createuser mindblown
sudo -u postgres createdb mindblown -O mindblown
sudo -u postgres psql -c "ALTER USER mindblown WITH PASSWORD 'your-secure-password';"
```

### 2. Clone and install

```bash
git clone https://github.com/your-org/mindblown.git
cd mindblown
pnpm install
```

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
DATABASE_URL=postgresql://mindblown:your-secure-password@localhost:5432/mindblown
PORT=3001
JWT_SECRET=your-random-secret-at-least-32-characters
JWT_EXPIRES_IN=7d
```

### 4. Build

```bash
pnpm build
```

### 5. Start the API server

```bash
cd packages/server
node dist/index.js
```

The database tables are created automatically on first start.

### 6. Build and serve the frontend

```bash
cd packages/mindmap
pnpm build
```

The built files are in `packages/mindmap/dist/`. Serve them with any static file server (nginx, caddy, etc.) or use the API server's static file serving if configured.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `postgresql://mindblown:mindblown@localhost:5433/mindblown` | PostgreSQL connection string |
| `PORT` | `3001` | API server port |
| `JWT_SECRET` | `mindblown-dev-secret-change-in-production` | Secret for signing JWT tokens. **Change this in production.** Use a random string of at least 32 characters. |
| `JWT_EXPIRES_IN` | `7d` | Token expiration time. Accepts values like `7d`, `24h`, `30m`. |
| `MINDBLOWN_API_URL` | `http://localhost:3001` | MCP server only: URL of the MindBlown API |
| `MINDBLOWN_TOKEN` | (empty) | MCP server only: JWT token for API authentication |
| `KUMA_FORGE_CATCHUP_PUSH_URL` | (empty) | Optional Uptime-Kuma/Gatus push URL for the forge catch-up heartbeat (the older `KUMA_GITHUB_CATCHUP_PUSH_URL` still works) |
| `KUMA_FORGE_AUTH_FAILURE_PUSH_URL` | (empty) | Optional push URL for the forge auth-failure alarm (`KUMA_GITHUB_AUTH_FAILURE_PUSH_URL` still works) |
| `KUMA_FORGE_DRIFT_PUSH_URL` | (empty) | Optional push URL for the drift audit (`KUMA_GITHUB_DRIFT_PUSH_URL` still works) |

---

## AI Backends (optional)

MindBlown runs without any LLM. AI features are switched on by configuring a backend; anything not offered by the configured backend is hidden in the UI and answered with `503 AI_NOT_CONFIGURED` by the API and the MCP tools. Private installs that must not talk to public LLM providers simply leave both variables unset, or point `AI_BASE_URL` at a model inside their own network.

| Variable | Description |
|----------|-------------|
| `AI_BASE_URL` | OpenAI-compatible base URL of a local model server, e.g. `http://ollama.internal:11434/v1` (Ollama, vLLM, llama.cpp, LM Studio). |
| `AI_MODEL` | Chat model on that server. Default `qwen2.5:14b`. |
| `AI_EMBED_BASE_URL` | OpenAI-compatible embeddings endpoint. Defaults to `AI_BASE_URL`. Set it alone on a Claude-only install that wants semantic search from a local embedding model. |
| `AI_EMBED_MODEL` | Embedding model on that server. Default `nomic-embed-text`. |
| `ANTHROPIC_API_KEY` | Claude API key. Enables the Claude backend (public internet). |
| `ANTHROPIC_MODEL` | Claude model for chat. |
| `TRIAGE_PROVIDER` | Backend for GitHub issue triage: `auto` (default, follows the admin-selected chat provider), `anthropic` or `ollama`. Falls back to whatever is configured. |
| `TRIAGE_MODEL` | Model for triage. Default `claude-haiku-4-5` on Claude, the `AI_MODEL` on a local backend. |
| `TRIAGE_AUTO_APPLY_CONFIDENCE` | Confidence (0–100) at which a Claude `place` decision auto-creates the node. Default 75. |
| `TRIAGE_LOCAL_AUTO_APPLY_CONFIDENCE` | Same lever for decisions made by a local model. Default 101 = never auto-apply; lower it once you trust the model. |
| `TRIAGE_LOCAL_AUTO_CONFIRM_SKIP_CONFIDENCE` | Local-model counterpart of `TRIAGE_AUTO_CONFIRM_SKIP_CONFIDENCE`. Default 101 = every local skip waits for review. |

What each mode offers today:

| Feature | No LLM | Local model (`AI_BASE_URL`) | Claude (`ANTHROPIC_API_KEY`) |
|---------|--------|-----------------------------|------------------------------|
| Mindmap, views, GitHub sync, MCP tools, fleet dispatch | yes | yes | yes |
| AI chat panel | – | yes | yes |
| Breakdown, brain dump, estimate, refine structure, standup | – | yes | yes |
| Semantic search (embeddings) | – | yes | only with `AI_EMBED_BASE_URL` pointing at a local embedding model |
| GitHub issue triage | – | yes (review-only by default) | yes |

### Per-map AI policy

The provider choice above is server-wide. A map can narrow it in its settings (gear icon on the map → "AI policy for this map"), or via the `update_map` MCP tool's `aiPolicy`:

| Policy | Effect |
|--------|--------|
| `any` (default) | Follows the server-wide provider. |
| `local` | Only the local model is ever used for this map. If no local backend is configured the AI features are off for the map — it never falls back to Claude. |
| `none` | No AI at all for this map: chat, structured features, semantic search, node embeddings and issue triage are all off, and `/api/ai/*` answers `503 AI_POLICY` for it. |

Enforced on the server, so it holds for the web UI, the REST API and MCP clients alike. `GET /api/ai/config?mapId=<id>` reports a map's effective capabilities. Use `local` or `none` for projects whose content must not reach a public LLM while other maps on the same server keep using Claude.

With both configured, chat, triage and the structured features use the admin-selected provider (Settings → AI Provider) and every feature is available. The chat's semantic-search tool is offered to Claude and to local models of roughly 30B parameters and up; smaller local models pick between text and semantic search at random, so they only get text search. A map with triage enabled on a server without any LLM logs one warning at startup and routes incoming issues straight to the inbox. Triage decisions made by a local model are never auto-applied unless `TRIAGE_LOCAL_AUTO_APPLY_CONFIDENCE` is lowered; they queue in the Triage panel for review.

`GET /api/ai/config` reports the effective flags as `capabilities` and is served even in no-LLM mode.

---

## Issue tracker: GitHub or Gitea (optional)

MindBlown syncs nodes with the issues of one repository per workspace. Two forges are supported with the same feature set — import, issue-from-node, close on done, catch-up reconcile, drift audit, triage label writeback, and the PR gates that drive nodes to done when a pull request merges:

| | GitHub | Gitea / Forgejo (self-hosted) |
|---|---|---|
| Auth | GitHub App installation (recommended) or a personal access token | Personal access token |
| Connect | Settings → GitHub → *Install the app* or *Use legacy token* | Settings → GitHub → *Forge: Gitea*, instance URL + token |
| Webhooks | Delivered by the App, or a repository webhook for token setups | Repository webhook |
| Not available | — | Check-suite status on PR gates (Gitea has no `check_suite` event); close reasons (`not_planned`) |

### Signing in with Gitea instead of pasting a token

Register an OAuth2 application on the Gitea instance (*Settings → Applications → Manage OAuth2 Applications*, confidential, redirect URI `https://<your-mindblown>/api/auth/gitea/callback`) and set on the server:

| Variable | Description |
|----------|-------------|
| `GITEA_URL` | Instance root, e.g. `https://git.example.com` |
| `GITEA_OAUTH_CLIENT_ID` / `GITEA_OAUTH_CLIENT_SECRET` | The application's credentials |
| `PUBLIC_URL` | This server's public origin (the callback is built from it) |
| `ENCRYPTION_KEY` | Already required for GitHub sign-in; the user's Gitea tokens are stored encrypted with it |

The GitHub panel then shows **Sign in with Gitea** and, once signed in, a picker of the repositories that user can see; **Use this repository** binds the workspace. Tokens are refreshed automatically; revoking the grant on Gitea (or *Disconnect*) stops the sync until someone signs in again or connects with a token.

### Connecting a Gitea repository with a token

1. In Gitea, create an access token for a user who can read and write the repository (*Settings → Applications*, scopes `repository: read and write`, `issue: read and write`).
2. In MindBlown open the map's GitHub panel, choose **Forge: Gitea / Forgejo**, enter the instance URL (`https://git.example.com` — the API is reached under `/api/v1` automatically), the token, owner and repository name, and press **Test connection**. The check reads the repository and reports whether the token can write to it.
3. Press **Connect**. The MCP tool `connect_github_repo` does the same with `kind: "gitea"` and `apiBaseUrl`.
4. In the repository's *Settings → Webhooks* add a Gitea webhook: target `https://<your-mindblown>/api/webhooks/github`, content type JSON, a secret, events *Issues*, *Issue comment*, *Pull request*. Store the same secret with the connection (`webhookSecret` on the connect call) so deliveries verify.
5. If MindBlown lives on a private address, allow it in Gitea's `app.ini`: `[webhook] ALLOWED_HOST_LIST = private` (or the host name).

Issue numbers and labels behave as on GitHub. Labels that don't exist on the repository are created when MindBlown publishes a node as an issue; the triage writeback (`triage:placed` / `triage:skipped`) expects them to exist and logs a warning otherwise, exactly as on GitHub.

Existing GitHub installs need no change: connections created before the Gitea support default to github.com.

Limits worth knowing:

- Connecting a self-hosted forge (and the *Test connection* call for one) is an admin action done from a web session: the server fetches the URL you type with the token you type, so API keys — including the MCP HTTP transport — are refused for that. Connecting github.com is open to any authenticated user, as before.
- A Gitea token scoped to the repository only cannot list organisation-level labels; those still resolve by name when MindBlown adds them, but a label MindBlown creates itself is always created on the repository.
- One forge per workspace. A repository named `owner/repo` on both GitHub and Gitea in the same installation would share issue identities (`owner/repo#N`) — keep the names distinct.
- Gitea has no close reason and its timeline does not attribute a merge-close to a commit. The abandoned-PR reopen and the closed-issue audit therefore only act on closes made by MindBlown's own login: set `MINDBLOWN_BOT_LOGIN` to the user whose token you connected, otherwise every close looks like a human decision and is left alone (the safe direction).

## Reverse Proxy (nginx)

For production, put MindBlown behind a reverse proxy with SSL.

### Example nginx configuration

```nginx
upstream mindblown_api {
    server 127.0.0.1:3001;
}

server {
    listen 80;
    server_name mindblown.example.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name mindblown.example.com;

    ssl_certificate /etc/letsencrypt/live/mindblown.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mindblown.example.com/privkey.pem;

    # Frontend static files
    root /opt/mindblown/packages/mindmap/dist;
    index index.html;

    # API proxy
    location /api/ {
        proxy_pass http://mindblown_api;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket proxy
    location /ws/ {
        proxy_pass http://mindblown_api;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 86400;
    }

    # Webhook endpoint (GitHub)
    location /api/webhooks/ {
        proxy_pass http://mindblown_api;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # SPA fallback — serve index.html for frontend routes
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

---

## Systemd Service

Create a service file to auto-start the API server.

### /etc/systemd/system/mindblown.service

```ini
[Unit]
Description=MindBlown API Server
After=network.target postgresql.service
Requires=postgresql.service

[Service]
Type=simple
User=mindblown
WorkingDirectory=/opt/mindblown
Environment=NODE_ENV=production
EnvironmentFile=/opt/mindblown/.env
ExecStart=/usr/bin/node packages/server/dist/index.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable mindblown
sudo systemctl start mindblown
sudo systemctl status mindblown
```

View logs:

```bash
journalctl -u mindblown -f
```

---

## Backup

### Database backup

```bash
pg_dump -U mindblown -h localhost -d mindblown > mindblown_backup_$(date +%Y%m%d_%H%M%S).sql
```

### Restore from backup

```bash
psql -U mindblown -h localhost -d mindblown < mindblown_backup_20250901_120000.sql
```

### Automated daily backup (cron)

```bash
crontab -e
```

Add:

```
0 2 * * * pg_dump -U mindblown -h localhost -d mindblown | gzip > /backups/mindblown_$(date +\%Y\%m\%d).sql.gz
```

---

## Updating

```bash
cd /opt/mindblown
git pull
pnpm install
pnpm build
sudo systemctl restart mindblown
```

If using Docker:

```bash
cd /opt/mindblown
git pull
docker compose build
docker compose up -d
```

Database migrations run automatically on server start -- no manual migration step needed.

---

## Troubleshooting

**Server won't start: "Failed to initialize database"**
Check that PostgreSQL is running and `DATABASE_URL` is correct. Verify the database exists and the user has access.

**WebSocket connections fail behind proxy**
Make sure your reverse proxy is forwarding the `Upgrade` and `Connection` headers. See the nginx example above.

**JWT token expired**
The default expiration is 7 days. Adjust `JWT_EXPIRES_IN` if needed. Users need to log in again after expiration.

**Port 5433 already in use**
Docker Compose maps PostgreSQL to port 5433 to avoid conflicts with a local PostgreSQL on 5432. Either stop the conflicting service or change the port mapping in `docker-compose.yml`.
