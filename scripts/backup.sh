#!/usr/bin/env bash
#
# Dumps the mindblown Postgres database to ./backups/mindblown-<timestamp>.sql.gz
# and, when there are uploaded files, tars MEDIA_DIR next to it as
# ./backups/mindblown-<timestamp>.media.tar.gz.
#
# Two files because state lives in two places: everything except uploads is
# in Postgres; the uploads themselves (files hung on nodes, POST /api/media)
# sit on disk under MEDIA_DIR and the dump only holds their URLs.
#
# Usage:
#   ./scripts/backup.sh [output-dir]
#
# Environment:
#   MINDBLOWN_DB_CONTAINER  Name of the running Postgres container.
#                           Defaults to 'mindblown-db'.
#   MEDIA_DIR               Where the API stores uploads. Defaults to
#                           packages/server/.media — the API's own default
#                           for a local checkout. Production sets it in the
#                           systemd unit (see deploy/mindblown-api.service).
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

OUT_DIR="${1:-$REPO_ROOT/backups}"
mkdir -p "$OUT_DIR"

CONTAINER="${MINDBLOWN_DB_CONTAINER:-mindblown-db}"
MEDIA_DIR="${MEDIA_DIR:-$REPO_ROOT/packages/server/.media}"

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
MEDIA_FILE="$OUT_DIR/mindblown-$TIMESTAMP.media.tar.gz"

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

# The tarball is relative to MEDIA_DIR (one directory per upload at the top
# level), so restore.sh can unpack it into whatever MEDIA_DIR the target uses.
if [[ -d "$MEDIA_DIR" ]] && [[ -n "$(ls -A "$MEDIA_DIR")" ]]; then
  echo "[backup] media dir: $MEDIA_DIR"
  echo "[backup] archiving uploads -> $MEDIA_FILE"
  tar -C "$MEDIA_DIR" -czf "$MEDIA_FILE" .
  SIZE="$(du -h "$MEDIA_FILE" | cut -f1)"
  echo "[backup] done: $MEDIA_FILE ($SIZE)"
else
  echo "[backup] no uploads in $MEDIA_DIR — no media archive written"
fi
