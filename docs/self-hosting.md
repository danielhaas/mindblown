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

---

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
