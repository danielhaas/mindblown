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

# Optional — transactional email (share invitations). If RESEND_API_KEY
# is unset, invitations are silently skipped (server logs a "dev mode"
# line per attempt).
# RESEND_API_KEY=re_xxx
# MAIL_FROM=MindBlown <noreply@example.com>
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

## What's NOT in the LXC backup

Proxmox container snapshots cover the whole rootfs (code, configs, Postgres data). The systemd timer also dumps the DB nightly to `/var/backups/mindblown/`. The dumps are kept for 30 days; copy them off-host periodically if you care about disaster recovery beyond a single Proxmox node.

Nothing in MindBlown writes to disk outside of Postgres — no upload directories, no local caches.
