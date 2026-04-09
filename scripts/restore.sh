#!/usr/bin/env bash
#
# Restores a mindblown Postgres database from a gzipped SQL dump produced by
# ./scripts/backup.sh. DESTRUCTIVE: drops and recreates the public schema.
#
# Usage:
#   ./scripts/restore.sh <backup-file.sql.gz> [--yes]
#
# Environment:
#   MINDBLOWN_DB_CONTAINER  Name of the running Postgres container.
#                           Defaults to 'mindblown-db'.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <backup-file.sql.gz> [--yes]" >&2
  exit 2
fi

BACKUP_FILE="$1"
ASSUME_YES="${2:-}"

if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "error: backup file not found: $BACKUP_FILE" >&2
  exit 1
fi

CONTAINER="${MINDBLOWN_DB_CONTAINER:-mindblown-db}"

if ! command -v docker >/dev/null 2>&1; then
  echo "error: 'docker' is not available on PATH" >&2
  exit 1
fi

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "error: container '$CONTAINER' is not running." >&2
  echo "       Set MINDBLOWN_DB_CONTAINER to override, or start it first." >&2
  exit 1
fi

echo "[restore] container: $CONTAINER"
echo "[restore] source:    $BACKUP_FILE"
echo "[restore] WARNING: this will DROP and recreate the public schema in the 'mindblown' database."

if [[ "$ASSUME_YES" != "--yes" ]]; then
  read -r -p "Type 'restore' to continue: " CONFIRM
  if [[ "$CONFIRM" != "restore" ]]; then
    echo "[restore] aborted."
    exit 1
  fi
fi

# Terminate other sessions on the target DB so DROP SCHEMA won't block.
echo "[restore] terminating other connections..."
docker exec -i "$CONTAINER" psql --username=mindblown --dbname=mindblown -v ON_ERROR_STOP=1 <<'SQL'
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = 'mindblown' AND pid <> pg_backend_pid();
SQL

echo "[restore] dropping and recreating public schema..."
docker exec -i "$CONTAINER" psql --username=mindblown --dbname=mindblown -v ON_ERROR_STOP=1 <<'SQL'
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO mindblown;
GRANT ALL ON SCHEMA public TO public;
SQL

echo "[restore] streaming dump into psql..."
gunzip -c "$BACKUP_FILE" \
  | docker exec -i "$CONTAINER" psql --username=mindblown --dbname=mindblown -v ON_ERROR_STOP=1

echo "[restore] done."
