# Deploying MindBlown to a Proxmox LXC

Runbook for running MindBlown natively (no Docker) on a Debian 12 LXC.

Stack:
- **Postgres 15** (Debian-packaged) — peer-friendly, snapshot-friendly
- **Node.js 20** + **pnpm** — runs the API via `tsx` (same as dev)
- **Caddy** — TLS, reverse proxy, static frontend
- **systemd** — supervises the API and runs nightly backups

The whole thing fits in 2 vCPU / 2 GB RAM / 16 GB disk.

---

## 1. Create the LXC (on the Proxmox host)

```bash
pct create <vmid> local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst \
  --hostname mindblown \
  --cores 2 \
  --memory 2048 \
  --rootfs local-lvm:16 \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp \
  --unprivileged 1 \
  --features nesting=1 \
  --onboot 1 \
  --start 1
pct enter <vmid>
```

(`nesting=1` is harmless and lets a few systemd units behave better. No Docker required.)

## 2. Install dependencies

```bash
apt update
apt install -y curl ca-certificates git build-essential debian-keyring debian-archive-keyring apt-transport-https gnupg postgresql rsync openssl sudo

# Node 20 via NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# pnpm via corepack (ships with Node)
corepack enable
corepack prepare pnpm@9.15.4 --activate

# Caddy (official repo)
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update
apt install -y caddy
```

## 3. Create the system user and directories

```bash
adduser --system --group --home /opt/mindblown --shell /usr/sbin/nologin mindblown
mkdir -p /etc/mindblown /var/backups/mindblown
chown postgres:postgres /var/backups/mindblown
chmod 750 /var/backups/mindblown
```

## 4. Postgres setup

```bash
sudo -u postgres createuser mindblown
sudo -u postgres createdb -O mindblown mindblown
sudo -u postgres psql -c "ALTER USER mindblown WITH PASSWORD 'CHANGE-ME';"
```

Verify:
```bash
PGPASSWORD=CHANGE-ME psql -h localhost -U mindblown -d mindblown -c '\dt'
```

## 5. Clone and build

```bash
cd /opt
git clone <your-repo-url> mindblown
chown -R mindblown:mindblown /opt/mindblown

sudo -u mindblown bash <<'EOF'
cd /opt/mindblown
pnpm install --frozen-lockfile
# Empty VITE_API_URL → frontend uses same-origin requests, which Caddy reverse-proxies.
VITE_API_URL="" pnpm build
EOF
```

> **Don't pass `--prod` to pnpm install.** The API runs via `tsx`, which is in `devDependencies`.

## 6. Environment file

```bash
install -m 0640 -o root -g mindblown /dev/null /etc/mindblown/api.env
cat > /etc/mindblown/api.env <<EOF
DATABASE_URL=postgresql://mindblown:CHANGE-ME@localhost:5432/mindblown
JWT_SECRET=$(openssl rand -hex 32)
PORT=3001
NODE_ENV=production

# Optional — transactional email (share invitations) over SMTP. If
# SMTP_HOST is unset, invitations are silently skipped (server logs a
# "dev mode" line per attempt). Port 465 uses implicit TLS; anything
# else (587, 25) uses STARTTLS. Set SMTP_SECURE=true/false to override.
# SMTP_HOST=smtp.example.com
# SMTP_PORT=587
# SMTP_USER=noreply@example.com
# SMTP_PASS=CHANGE-ME
# MAIL_FROM=MindBlown <noreply@example.com>

# Optional — Uptime-Kuma push URLs for GitHub-sync observability.
# Without these, the API still runs the catchup loop + daily drift
# audit, but silent failures have no external alarm. See below.
# KUMA_GITHUB_CATCHUP_PUSH_URL=https://kuma.example.com/api/push/<token>
# KUMA_GITHUB_DRIFT_PUSH_URL=https://kuma.example.com/api/push/<token>

# Optional — Uptime-Kuma push URL for the weekly Pushover-canary
# (alarm-chain liveness probe). Unset = canary is disabled. See the
# "Pushover canary" section below for the full operator runbook.
# KUMA_ALARM_CANARY_PUSH_URL=https://kuma.example.com/api/push/<token>

# Optional — cap on the number of drift nodes the daily audit will
# auto-backfill PER MAP per tick. Drift over this cap is left in
# place so the Kuma alarm escalates to a human. Set to 0 to disable
# auto-backfill entirely (audit still runs + alarms). Default: 50.
# AUTO_BACKFILL_MAX_PER_DAY=50
EOF
chmod 640 /etc/mindblown/api.env
chown root:mindblown /etc/mindblown/api.env
```

## 7. Install the systemd units

```bash
cp /opt/mindblown/deploy/mindblown-api.service     /etc/systemd/system/
cp /opt/mindblown/deploy/mindblown-backup.service  /etc/systemd/system/
cp /opt/mindblown/deploy/mindblown-backup.timer    /etc/systemd/system/

systemctl daemon-reload
systemctl enable --now mindblown-api
systemctl enable --now mindblown-backup.timer

systemctl status mindblown-api
journalctl -u mindblown-api -f   # watch startup
```

The API should log `MindBlown API listening on http://localhost:3001` and the migrations should complete. On first boot it will also seed a demo workspace — that gets overwritten in the next step.

## 8. Restore the backup

From your old machine:
```bash
./scripts/backup.sh
scp backups/mindblown-*.sql.gz root@<new-host>:/tmp/
```

On the new host:
```bash
systemctl stop mindblown-api
sudo -u postgres psql -d mindblown -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO mindblown; GRANT ALL ON SCHEMA public TO public;"
gunzip -c /tmp/mindblown-*.sql.gz | sudo -u postgres psql -d mindblown -v ON_ERROR_STOP=1

# Reassign ownership: the dump uses --no-owner, so objects end up owned by
# whoever ran psql (postgres). The API runs as 'mindblown' and its migrations
# do ALTER TABLE on startup, which fails unless mindblown owns the tables.
sudo -u postgres psql -d mindblown <<'SQL'
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP
    EXECUTE 'ALTER TABLE public.' || quote_ident(r.tablename) || ' OWNER TO mindblown';
  END LOOP;
  FOR r IN SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema='public' LOOP
    EXECUTE 'ALTER SEQUENCE public.' || quote_ident(r.sequence_name) || ' OWNER TO mindblown';
  END LOOP;
END
$$;
SQL

systemctl start mindblown-api
```

## 9. Caddy

```bash
cp /opt/mindblown/deploy/Caddyfile /etc/caddy/Caddyfile
$EDITOR /etc/caddy/Caddyfile           # change the hostname
systemctl reload caddy
```

If you're on a LAN with no public DNS, replace the site address in the Caddyfile with `:80` (plain HTTP) or use `tls internal` for a self-signed cert. See the comments in `deploy/Caddyfile`.

## 10. Sanity checks

```bash
curl http://localhost:3001/api/health
curl -k https://mindblown.example.com/api/health
systemctl list-timers mindblown-backup.timer
ls -lh /var/backups/mindblown/
```

---

## Updates / redeploys

```bash
sudo -u mindblown bash <<'EOF'
cd /opt/mindblown
git pull
pnpm install --frozen-lockfile
VITE_API_URL="" pnpm build
EOF
systemctl restart mindblown-api
systemctl reload caddy   # only if you changed the Caddyfile
```

The API runs migrations on every startup, so schema changes apply automatically.

## GitHub-sync observability (Uptime-Kuma push monitors)

The API exposes two passive heartbeats for the GitHub→MindBlown sync
loop. Both are no-ops unless the corresponding env var is set, so this
section is optional — but strongly recommended in production.

### Why two monitors

- **Catchup heartbeat (`KUMA_GITHUB_CATCHUP_PUSH_URL`)** — pushed once
  per catchup tick (every 5 min). Alarms when pushes stop = catchup
  scheduler dead, mindblown-api crashed, network broken, etc.

- **Drift audit (`KUMA_GITHUB_DRIFT_PUSH_URL`)** — pushed once per
  day. Pushes `status=down` if any opted-in map has open GitHub issues
  with no linked MindBlown node. Alarms when push is `down` OR pushes
  stop entirely = webhook silently misconfigured on the GH side, the
  ingest path is silently throwing, etc.

### Creating the monitors in Kuma

1. Open your Kuma instance, **Add New Monitor** → **Push**.
2. Set a name (e.g. `mindblown-github-catchup`) and a heartbeat
   interval — see suggested thresholds below.
3. Save. Kuma generates a push URL like
   `https://kuma.example.com/api/push/abc123XYZ`.
4. Repeat for the drift-audit monitor.
5. Wire each push URL into `/etc/mindblown/api.env` (uncomment the two
   `KUMA_GITHUB_*` lines) and `systemctl restart mindblown-api`.

### Suggested Kuma thresholds

| Monitor | Heartbeat interval | "Down" threshold | Notes |
|---|---|---|---|
| catchup heartbeat | 60 s | 10 min | API pushes every 5 min — 10 min absorbs one missed tick (restart/upgrade) without false-alarming. |
| drift audit | 60 s | 30 h | API pushes daily — 30 h gives 6 h of slack for restart timing, clock drift, etc. |

### Auto-backfill on drift detection

When the daily audit finds drift, the API attempts to self-heal by
calling the same code path as the manual "Backfill" button in the UI
for each drifted map. The cap is per-map per audit tick:

| Setting | Default | Behaviour |
|---|---|---|
| `AUTO_BACKFILL_MAX_PER_DAY=50` (default) | up to 50 drift nodes per map | auto-healed; Kuma `up msg=auto-backfilled-N` |
| drift > cap | none | left in place; Kuma `down msg=manual-N` |
| `AUTO_BACKFILL_MAX_PER_DAY=0` | 0 | kill switch: audit still runs + alarms, nothing self-heals |

The Kuma message format makes both outcomes auditable from the alert
history:

- `no-drift` — clean tick (status=up).
- `auto-backfilled-3` — 3 nodes self-healed (status=up).
- `manual-5` — 5 nodes left for manual ack (status=down).
- `auto-backfilled-2,manual-3` — mixed (status=down).
- `audit_failed:<reason>` — audit itself threw (status=down).

`status=up` for full self-heal means the operator never gets paged
when the system recovers itself; anything requiring action still
alarms.

**Triage `manual-N` alerts.** The same `manual-N` message covers two
distinct failure modes — grep the server logs to tell them apart:

```bash
journalctl -u mindblown-api | grep auto-backfill
```

- `drift detected, all N maps over the per-day cap` → expected: hit
  the manual backfill endpoint (or raise `AUTO_BACKFILL_MAX_PER_DAY`).
- `drift detected, per-map auto-backfill failed: <error>` → expected:
  read the warn log for the underlying cause (revoked GitHub token,
  GitHub 503, rate-limit, etc.) and fix that before re-running.

### Watchdog auto-restart

The unit file uses `Type=notify` + `WatchdogSec=300` so a frozen
catchup loop (network stall, hung pg query) triggers a systemd-driven
kill + restart after 5 min of no `WATCHDOG=1` pings. The catchup loop
pings only after a fully-successful tick — partial failures
deliberately don't reset the watchdog because that's the failure mode
the watchdog exists to catch. Combined with `Restart=on-failure +
RestartSec=10s`, a hung API recovers in ≤ 5 min 10 s without operator
involvement.

The READY ping is sent once Fastify has bound the port; without it,
`Type=notify` would leave `systemctl start` blocked forever waiting
for ready notification.

### Manual trigger

For ops testing without waiting 24h for the next scheduled drift
audit, hit the manual endpoint as a logged-in user:

```bash
curl -sf -X POST https://mindblown.example.com/api/maps/sync/audit-drift \
  -H "Cookie: <session cookie from your browser>" | jq .
```

Returns `{reports: DriftReport[], autoBackfill: {...}, counts: {...}}`.
The manual trigger runs the same auto-backfill + Kuma push the
scheduled audit does, so it's a faithful end-to-end smoke test of the
auto-repair flow. API-key auth is deliberately rejected — this is a
session-only operator surface.

## Pushover canary (weekly alarm-chain liveness probe)

The catchup heartbeat + drift audit alarm when the GitHub sync breaks.
But they only exercise the **delivery chain** (mindblown → Kuma →
Pushover) during a real outage. If Pushover credentials silently
expire, or the Kuma monitor loses its notification link, we'd only
find out during the next actual incident — by which point the
operator is flying blind.

The canary fires a synthetic `status=down` push to a dedicated Kuma
monitor once a week, waits 60 s, then fires `status=up` to recover.
If the chain works, the operator gets a Pushover saying "synthetic
test" once a week. If the chain is broken, either the Pushover never
arrives (Pushover credentials expired) or Kuma's own "missing push"
threshold alarms (mindblown-api dead) — either way the breakage
surfaces within a week instead of during the next real incident.

### 1. Create the Kuma monitor

1. **Add New Monitor** → **Push**.
2. Name: `mindblown-alarm-canary`.
3. Heartbeat interval: 60 s.
4. **Down threshold: 90 s.** This is the critical bit — short enough
   that the synthetic `status=down` trips Kuma's alarm channel before
   the ack push lands 60 s later, so the monitor briefly flips to
   `down`, fires its notification, then recovers when the ack
   arrives.
5. Save. Copy the generated push URL.

### 2. Route to a dedicated Pushover device (recommended)

A weekly Pushover that says "synthetic-test" on your main device is
annoying. Configure a separate Pushover device key for the canary
monitor so it doesn't spam the channel you actually triage from:

1. In Pushover, register a second device (e.g. `mindblown-canary`).
   You can use the iOS/Android Pushover app's "Add Device" flow, or
   create a virtual device via the Pushover web UI.
2. In Kuma, **Settings → Notifications**, add a new Pushover
   notification with that device key.
3. Link the new notification to the `mindblown-alarm-canary` monitor
   only — leave your main GitHub-sync monitors pointing at the
   default device.

This way a weekly "I'm alive" ping lands on a phone surface you can
mute or silence, while real outage alerts on the main monitors still
escalate normally.

### 3. Wire the env var

Add to `/etc/mindblown/api.env`:

```bash
KUMA_ALARM_CANARY_PUSH_URL=https://kuma.example.com/api/push/<token>
```

Then `systemctl restart mindblown-api`.

### 4. Verify on first deploy

The scheduler runs every 7 days, so you don't want to wait a week to
confirm the wiring works. Override the interval with the
`CANARY_INTERVAL_MS` env var for a single test run:

```bash
# As root, edit api.env and add at the bottom:
CANARY_INTERVAL_MS=60000

systemctl restart mindblown-api
```

Within ~60 s the canary fires `status=down`. Kuma's 90 s "down"
threshold trips, you get a Pushover saying `synthetic-test` (or
similar — Pushover renders the Kuma monitor name + msg). 60 s later
the canary fires `status=up`, Kuma flips back to up, the next push
60 s after that keeps it green.

**Once confirmed, REMOVE the `CANARY_INTERVAL_MS` line from
`api.env`** so it falls back to the weekly default, and restart:

```bash
# Remove the CANARY_INTERVAL_MS line
systemctl restart mindblown-api
```

### Notes

- The canary intentionally has **no startup invocation** — we don't
  want a Pushover on every restart/upgrade. The first push lands
  `CANARY_INTERVAL_MS` after process start.
- The canary is a **pure no-op** when `KUMA_ALARM_CANARY_PUSH_URL` is
  unset, so deploying without the env var costs nothing.
- Both pushes are best-effort: the ack push fires even if the down
  push throws, so a transient error during the first push can't
  leave the monitor stuck in `down` state.

## What's NOT in the LXC backup

Proxmox container snapshots cover the whole rootfs (code, configs, Postgres data). The systemd timer also dumps the DB nightly to `/var/backups/mindblown/`. The dumps are kept for 30 days; copy them off-host periodically if you care about disaster recovery beyond a single Proxmox node.

Nothing in MindBlown writes to disk outside of Postgres — no upload directories, no local caches.
