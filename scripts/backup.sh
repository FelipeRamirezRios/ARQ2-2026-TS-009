#!/usr/bin/env sh
set -eu
OUT_DIR="${1:-./backups}"
mkdir -p "$OUT_DIR"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
FILE="$OUT_DIR/aerobooking-$STAMP.dump"
docker compose exec -T postgres pg_dump -U aerobooking -d booking_db -Fc > "$FILE"
test -s "$FILE"
sha256sum "$FILE" > "$FILE.sha256"
printf 'Backup created: %s\n' "$FILE"
