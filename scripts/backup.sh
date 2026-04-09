#!/usr/bin/env bash
#
# Dumps the mindblown Postgres database to ./backups/mindblown-<timestamp>.sql.gz
#
# All MindBlown state lives in Postgres, so this single dump is a complete backup.
#
# Usage:
#   ./scripts/backup.sh [output-dir]
#
# Environment:
#   MINDBLOWN_DB_CONTAINER  Name of the running Postgres container.
#                           Defaults to 'mindblown-db'.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

OUT_DIR="${1:-$REPO_ROOT/backups}"
mkdir -p "$OUT_DIR"

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

TIMESTAMP="$(date -u +%Y%m%d-%H%M%SZ)"
OUT_FILE="$OUT_DIR/mindblown-$TIMESTAMP.sql.gz"

echo "[backup] container: $CONTAINER"
echo "[backup] dumping mindblown database -> $OUT_FILE"

# --clean --if-exists makes the dump restorable onto a non-empty DB.
# --no-owner / --no-privileges keeps it portable across hosts with different role setups.
docker exec -i "$CONTAINER" pg_dump \
  --username=mindblown \
  --dbname=mindblown \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  | gzip -9 > "$OUT_FILE"

SIZE="$(du -h "$OUT_FILE" | cut -f1)"
echo "[backup] done: $OUT_FILE ($SIZE)"
