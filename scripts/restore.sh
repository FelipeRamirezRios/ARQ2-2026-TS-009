#!/usr/bin/env sh
set -eu
BACKUP_FILE="${1:?Usage: scripts/restore.sh <backup.dump>}"
test -f "$BACKUP_FILE" || { echo "Backup file not found: $BACKUP_FILE" >&2; exit 1; }
printf 'This overwrites booking_db. Type RESTORE to continue: '
read CONFIRM
[ "$CONFIRM" = "RESTORE" ] || { echo 'Restore cancelled'; exit 1; }
docker compose stop auth-service search-service booking-service airline-connector audit-service kong frontend
docker compose exec -T postgres pg_restore -U aerobooking -d booking_db --clean --if-exists < "$BACKUP_FILE"
docker compose up -d
printf 'Restore completed; verify docker compose ps and application health.\n'
