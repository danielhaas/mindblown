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

# Optional — Heartbeat-push URLs for GitHub-sync observability.
# Without these, the API still runs the catchup loop + drift audit,
# but silent failures have no external alarm. See below.
#
# The helper `pushKumaHeartbeat` accepts EITHER shape:
#   - Gatus  (preferred): http://<host>/api/v1/endpoints/push_<name>/external
#     Requires GATUS_PUSH_TOKEN set with the matching bearer.
#   - Kuma (legacy):      https://kuma.example.com/api/push/<token>
#     No bearer needed; token is embedded in the path.
#
# Env var names are kept as KUMA_* for minimum-diff compatibility.
# Migration target as of 2026-06-12: Gatus (see crm#2620).
# KUMA_GITHUB_CATCHUP_PUSH_URL=http://10.0.20.14:8080/api/v1/endpoints/push_mindblown-github-catchup/external
# KUMA_GITHUB_DRIFT_PUSH_URL=http://10.0.20.14:8080/api/v1/endpoints/push_mindblown-github-drift/external
# KUMA_GITHUB_AUTH_FAILURE_PUSH_URL=http://10.0.20.14:8080/api/v1/endpoints/push_mindblown-github-auth-failure/external
# KUMA_WEBHOOK_AUTH_FAILURE_PUSH_URL=http://10.0.20.14:8080/api/v1/endpoints/push_mindblown-webhook-auth/external
# GATUS_PUSH_TOKEN=<bearer from /opt/gatus/.env on CT 124>

# Optional — consecutive GH 401 ticks per repo before the catchup
# fires `status=down msg=auth_failed:owner/repo` on the auth-failure
# Kuma monitor. Lower = louder, higher = more tolerant of a flaky
# bridge. Default 3 (≈ 15 min on a 5-min catchup tick).
# CATCHUP_AUTH_FAILURE_THRESHOLD=3

# Optional — Heartbeat-push URL for the weekly Pushover-canary
# (alarm-chain liveness probe). Unset = canary is disabled. See the
# "Pushover canary" section below for the full operator runbook.
# Same dual-mode (Gatus or Kuma) as the other 4 push URLs above.
# KUMA_ALARM_CANARY_PUSH_URL=http://10.0.20.14:8080/api/v1/endpoints/push_mindblown-alarm-canary/external

# Optional — drift-audit cadence in milliseconds. Default 21600000
# (6h). Minimum 3600000 (1h) — values below the minimum (incl. zero
# or non-numeric) are rejected with a console warning and the default
# is used. Tighter intervals shrink alarm-to-detect latency but
# multiply GitHub API calls (one list-issues per opted-in map per
# tick); the 1h floor protects against env-var typos turning the
# audit into a rate-limit grinder. See the "GitHub-sync observability"
# section below for the full rationale.
# DRIFT_AUDIT_INTERVAL_MS=21600000

# Optional — cap on the number of drift nodes the audit will
# auto-backfill PER MAP per tick. Drift over this cap is left in
# place so the Kuma alarm escalates to a human. Set to 0 to disable
# auto-backfill entirely (audit still runs + alarms). Default: 50.
# AUTO_BACKFILL_MAX_PER_DAY=50

# ── AI triage (#92, #93) ────────────────────────────────────────
# Triage is opt-in PER MAP via the `maps.triage_enabled` column
# (default false). When true, new GitHub issues for that map go
# through `triageIssue()` before any node is created; the LLM
# decides skip / place / uncertain and the choice is persisted in
# the `triage_decisions` table. High-confidence place-decisions
# auto-create the node under the suggested epic; everything else
# waits for human review via the CRUD routes under
# /api/maps/:id/triage-decisions.
#
# Requires ANTHROPIC_API_KEY to be set. There is no Ollama fallback
# for triage in Phase 0 — the prompt-caching path that makes triage
# cost-effective is Anthropic-specific.
#
# To enable triage on a map (Phase 0 has no UI yet — direct SQL):
#   UPDATE maps SET triage_enabled = TRUE WHERE id = '<map-uuid>';
#
# Optional — model used by `triageIssue()`. Defaults to a Haiku-class
# model since triage is cheap classification. Override if you want
# Sonnet for higher accuracy. Set to any Anthropic model id.
# TRIAGE_MODEL=claude-haiku-4-5
#
# Optional — confidence threshold (0-100) above which a `place`
# decision is auto-applied. Below this, the decision is persisted
# but no node is created — operator must review and override.
# Default 75. Lower = more auto-apply (fewer manual reviews, more
# false positives). Higher = stricter (more reviews queued, fewer
# false positives). Values outside [0, 100] fall back to 75 with a
# console warning.
# TRIAGE_AUTO_APPLY_CONFIDENCE=75
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

The API exposes four passive heartbeats for the GitHub→MindBlown sync
loop. Each is a no-op unless the corresponding env var is set, so this
section is optional — but strongly recommended in production.

### Why four monitors

- **Catchup heartbeat (`KUMA_GITHUB_CATCHUP_PUSH_URL`)** — pushed once
  per catchup tick (every 5 min). Alarms when pushes stop = catchup
  scheduler dead, mindblown-api crashed, network broken, etc.

- **Drift audit (`KUMA_GITHUB_DRIFT_PUSH_URL`)** — pushed once per
  drift-audit tick (every 6h by default; configurable via
  `DRIFT_AUDIT_INTERVAL_MS`, minimum 1h). Pushes `status=down` if any
  opted-in map has open GitHub issues with no linked MindBlown node.
  Alarms when push is `down` OR pushes stop entirely = webhook
  silently misconfigured on the GH side, the ingest path is silently
  throwing, etc.

- **Auth failure (`KUMA_GITHUB_AUTH_FAILURE_PUSH_URL`)** — pushed only
  when a specific repo has hit `CATCHUP_AUTH_FAILURE_THRESHOLD`
  consecutive 401s (default 3, ≈ 15 min on a 5-min catchup tick).
  Message is `auth_failed:owner/repo` so the alert names the bound
  repo whose token/install needs attention; one revoked install on a
  multi-repo deployment doesn't drown out the others. A successful
  fetch on that repo resets the counter and the monitor goes UP on
  the next tick.

- **Webhook auth (`KUMA_WEBHOOK_AUTH_FAILURE_PUSH_URL`)** — pushed
  once a day. Catches a silent failure mode the three monitors above
  miss: the GH-side webhook secret has rotated, mindblown's copy is
  stale, every webhook POST fails signature verification → 401, and
  the 5-min catchup loop silently papers over the gap. The realtime
  path is dead but drift stays at 0 so nothing else alarms. The
  scheduler reads a 24h rolling counter and pushes
  `status=down msg=webhook_auth_failed:received_N_authenticated_0`
  when N ≥ 3 calls all failed verification, `status=up` when at
  least one passed, or skips the push entirely when fewer than 3
  calls landed (avoids false-alarming a quiet day where one
  transient blip is the only sample). Note: the all-zero case
  ("GH webhook never configured at all") is deliberately NOT
  alarmed by this monitor — that's a different failure mode and
  conflating them would page operators on fresh deploys with no
  webhook wired yet.

### Creating the monitors in Kuma

1. Open your Kuma instance, **Add New Monitor** → **Push**.
2. Set a name (e.g. `mindblown-github-catchup`) and a heartbeat
   interval — see suggested thresholds below.
3. Save. Kuma generates a push URL like
   `https://kuma.example.com/api/push/abc123XYZ`.
4. Repeat for the drift-audit, auth-failure, and webhook-auth monitors
   (four monitors total — one per env var below).
5. Wire each push URL into `/etc/mindblown/api.env` (uncomment the
   `KUMA_GITHUB_CATCHUP_PUSH_URL`, `KUMA_GITHUB_DRIFT_PUSH_URL`,
   `KUMA_GITHUB_AUTH_FAILURE_PUSH_URL`, and
   `KUMA_WEBHOOK_AUTH_FAILURE_PUSH_URL` lines) and
   `systemctl restart mindblown-api`.

### Suggested Kuma thresholds

| Monitor | Heartbeat interval | "Down" threshold | Notes |
|---|---|---|---|
| catchup heartbeat | 60 s | 10 min | API pushes every 5 min — 10 min absorbs one missed tick (restart/upgrade) without false-alarming. |
| drift audit | 60 s | 8 h | API pushes every 6 h by default — 8 h gives 2 h of slack for restart timing, clock drift, etc. If you raise `DRIFT_AUDIT_INTERVAL_MS`, raise the down threshold to `interval + 2h` to match. |
| auth failure | 60 s | 20 min | API pushes only on the threshold-crossing tick + every subsequent failing tick; 20 min covers two consecutive 5-min catchup ticks so a single delayed Kuma push doesn't flap the monitor. |
| webhook auth | 60 s | 30 h | API pushes daily — 30 h gives 6 h of slack matching the drift audit. Push only fires when ≥ 3 webhook calls landed in the rolling 24h; before that the monitor sits in "no push received" but Kuma should NOT alarm on it during normal low-traffic periods — set the down threshold generously. |

### Auto-backfill on drift detection

When the drift audit finds drift, the API attempts to self-heal by
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

### Triage `webhook_auth_failed` alerts

The webhook-auth monitor pushes `status=down msg=webhook_auth_failed:received_N_authenticated_0`
when N ≥ 3 webhook deliveries arrived in the last 24h and ALL of them
failed signature verification. The catchup loop will be silently
papering over the gap — node updates still flow, but with up to 5 min
of lag — so the operator-visible symptom is "sync feels sluggish but
nothing is broken". Triage:

1. Verify the alarm is real — hit `journalctl -u mindblown-api | grep "invalid signature"`
   to see the rejected POSTs. Each line carries the GH event type and
   the source IP; the IP should match GitHub's published webhook ranges.
   **DoS check:** if `received_N` is unexpectedly large (orders of
   magnitude beyond your normal webhook volume), grep the source IPs
   against GitHub's published [hooks ranges](https://api.github.com/meta) —
   non-GH traffic hitting the webhook endpoint should be rate-limited
   at the ingress (Caddy / load balancer), not papered over here.
2. Check whether the secret was rotated on the GitHub side. For a
   GitHub App: **App settings → Webhook → "Generate new secret"**
   history. For a per-integration PAT: ask whoever set it up most
   recently.
3. Update the matching secret in mindblown:
   - GitHub App: `GITHUB_APP_WEBHOOK_SECRET` in `/etc/mindblown/api.env`
     → `systemctl restart mindblown-api`.
   - PAT integration: `POST /api/integrations/github/connect` with the
     new `webhookSecret` (the connect endpoint is the supported way to
     edit a stored secret — direct DB UPDATEs work but aren't audited).
4. Within 24h the rolling counter clears and the monitor flips back
   to `up`. To verify the fix faster, override the cadence:
   `WEBHOOK_AUTH_CHECK_INTERVAL_MS=60000` in `api.env`, restart, and
   the next successful webhook delivery + tick will push `status=up`.
   To verify the alarm actually fires end-to-end, send ≥ 3 deliveries
   with the WRONG secret first (e.g. trigger 3 issue events from a
   test repo while the secret is intentionally stale), then wait for
   one tick — Kuma should flip `down`, fire its notification, then
   flip `up` once correct deliveries land and the rolling window
   refreshes. Remove the override afterwards.

If no webhook traffic has landed yet (received < 3), the monitor sits
in "no push received" — that's normal and Kuma should NOT alarm on a
short window of no pushes. Tune the down threshold to ~30 h
(matching the daily push cadence + slack).

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

### Tuning the drift-audit cadence

The drift audit runs every **6 hours** by default. Override via
`DRIFT_AUDIT_INTERVAL_MS` in `/etc/mindblown/api.env` (value in
milliseconds, minimum `3600000` = 1 hour):

```bash
# Every 4 hours
DRIFT_AUDIT_INTERVAL_MS=14400000

# Every 6 hours (the default — equivalent to leaving it unset)
DRIFT_AUDIT_INTERVAL_MS=21600000

# Every 12 hours (lighter on GitHub API at large scale, longer
# alarm-to-detect latency)
DRIFT_AUDIT_INTERVAL_MS=43200000
```

Then `systemctl restart mindblown-api`.

**Rationale.** The audit was previously hardcoded to 24h; a drift
incident that started at 09:00 could wait until 08:59 the next day
before alarming. Dropping to 6h caps that latency at 6h max and only
4× the GitHub API spend (still one `list-issues` call per opted-in
map per tick — negligible at single-digit map counts).

**Floor.** Values below `3600000` (1h) — including `0`, a typo like
`6h`, and any non-numeric string — are rejected with a console
warning and the 6h default is used instead. The floor exists because
`setInterval(0)` would hammer the GitHub API at the event-loop rate,
and the same map fetched a hundred times a second would tank both
the audit's own rate-limit budget and any other GitHub-touching code
in the API.

**If you raise the interval**, also raise the Kuma down-threshold on
the drift-audit monitor (interval + ~2h slack for restart timing,
clock drift) so a single missed tick doesn't false-alarm.

### Manual trigger

For ops testing without waiting up to 6h for the next scheduled
drift audit, hit the manual endpoint as a logged-in user:

```bash
curl -sf -X POST https://mindblown.example.com/api/maps/sync/audit-drift \
  -H "Cookie: <session cookie from your browser>" | jq .
```

Returns `{reports: DriftReport[], tokenErrors: TokenError[], autoBackfill: {...}, counts: {...}}`.
`tokenErrors` lists every map whose GitHub binding couldn't resolve
a current token (App install revoked, PAT expired, or no binding at
all — see `reason` field for the cause). The manual trigger runs the
same auto-backfill + Kuma push the scheduled audit does, so it's a
faithful end-to-end smoke test of the auto-repair flow. API-key auth
is deliberately rejected — this is a session-only operator surface.

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
4. **Down threshold: 90 s.** Kuma flips a push monitor to `down`
   *immediately* on receipt of `status=down` (and fires its
   notification right then), independent of the missed-heartbeat
   threshold — so the canary alarm trips as soon as the synthetic
   down push lands, not after 90 s. The 90 s threshold is the
   *liveness* signal: it catches a dead canary (mindblown-api
   crashed, scheduler frozen) at the next missed weekly tick — Kuma
   alarms on "no push received within 90 s" once the heartbeat
   timeout passes. So the 90 s value is a safety floor for missed
   ticks, not a race-condition control between the down and ack
   pushes.
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

**The nightly dump is Postgres only.** Since #286 there is a second place with state in it: `MEDIA_DIR` (see below). A restore from `mindblown-*.sql.gz` brings back the `verification_video_url` values but not the files they point at — those ride on the Proxmox snapshot, and nothing else. If you care about the clips, either add `MEDIA_DIR` to whatever copies the dumps off-host, or accept that they're only as safe as the container.

## Uploaded media (#286)

Users attach files — mostly short verification clips — through the web UI. `POST /api/media` stores them; `GET /api/media/<id>/<name>` serves them back. Caddy needs no new block: both live under the `/api/*` prefix it already proxies.

### Configuration

| Variable | Default | Notes |
|---|---|---|
| `MEDIA_DIR` | `.media` under the server's working directory | Set **in the unit file**, not `api.env` — see below. Production: `/var/lib/mindblown/media`. |
| `MEDIA_MAX_BYTES` | `104857600` (100 MB) | Per-file ceiling. Oversized uploads get a 413 and nothing is kept. |
| `MEDIA_PUBLIC_BASE_URL` | falls back to `FRONTEND_URL` | Only needed if media is served from a different origin than the app. |

There is nothing to add to `/etc/mindblown/api.env`. Copy the new unit file and `systemctl daemon-reload && systemctl restart mindblown-api` — that's the whole change.

Two lines in the unit do the work, and both are easy to drop on a rebuild:

- `StateDirectory=mindblown` creates `/var/lib/mindblown` owned by the service user and adds it to the writable set. `ProtectSystem=strict` makes the rest of the filesystem read-only, so without it the first upload fails with `EROFS`.
- `Environment=MEDIA_DIR=%S/mindblown/media` points the server at it. This deliberately does **not** live in `api.env`, because forgetting it there wouldn't fail — the default resolves against `WorkingDirectory` to `/opt/mindblown/packages/server/.media`, which is inside `ReadWritePaths` and gitignored. Uploads would work, files would pile up in the checkout, and the loss would surface months later on a re-clone. Keeping the path next to the sandbox rule that makes it writable means the two can't drift apart.

If `MEDIA_DIR` points somewhere unwritable, the server fails to start rather than accepting uploads it can't keep: the directory is created at plugin-registration time, before `app.listen()`, so `Type=notify` never sees `READY=1` and systemd restarts on a loop. Check `journalctl -u mindblown-api` for an `EACCES`/`EROFS` on the media path before suspecting Postgres.

### Why the directory is outside the checkout

A release is `git pull && pnpm build`, and the build rewrites `packages/mindmap/dist` in full. Anything stored under the checkout is a deploy away from being gone.

### Who can read an uploaded file

**Anyone with the link.** Uploading requires a login; playback does not. The URL carries 160 bits of randomness and that is the whole of the access control — a `<video src=…>` cannot send an `Authorization` header, and the app keeps its JWT in localStorage rather than a cookie, so the alternatives are an expiring signed URL (which rots inside the `verification_video_url` column) or buffering the clip as a blob (which loses seeking).

On a public host like `mind.project.li` that means an uploaded clip is one leaked URL away from being public. It is the right trade for demo recordings of a feature; it is the wrong trade for anything with customer data in it, and the UI does not stop a user from uploading the latter. If that changes, the route stays and gains a per-request signature — the URLs get re-rendered at view time rather than stored.

### Housekeeping

Files are not deleted when the node referencing them is. Node deletion is a soft delete with a restore path and a 30-day GC, so removing the file eagerly would break restore; and a URL, once pasted, can be referenced from more than one place. Orphaned files therefore accumulate — slowly, at clip scale, on a 16 GB rootfs. Watch `du -sh /var/lib/mindblown/media` rather than assuming; a sweep tied to the existing trash GC is the obvious follow-up if it ever matters.
