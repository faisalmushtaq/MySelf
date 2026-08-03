#!/bin/sh
# Nightly backup.
#
# A dump on the same disk as the database is not a backup — it dies with the
# box. This writes locally, copies off-site, and prunes. Put it in cron:
#
#   0 2 * * *  /opt/myself/infra/backup.sh >> /var/log/myself-backup.log 2>&1
#
# The restore drill is in docs/12. Run it once before the first fieldwork and
# once a term after that: an untested backup is a hope, not a backup.

set -eu

cd "$(dirname "$0")"
. ./.env

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
FILE="backups/myself_${STAMP}.sql.gz"

mkdir -p backups

# --clean --if-exists makes the dump safe to restore over an existing database.
docker compose exec -T db pg_dump \
	--username "${POSTGRES_USER:-myself}" \
	--dbname "${POSTGRES_DB:-myself}" \
	--clean --if-exists \
	| gzip -9 > "$FILE"

SIZE=$(wc -c < "$FILE")
if [ "$SIZE" -lt 4096 ]; then
	# A dump that came out suspiciously small usually means the command failed
	# and wrote an error into the file. Fail loudly rather than pruning good
	# backups in favour of a broken one.
	echo "backup looks wrong: $FILE is only ${SIZE} bytes" >&2
	exit 1
fi

if [ -n "${BACKUP_REMOTE:-}" ]; then
	rclone copy "$FILE" "$BACKUP_REMOTE"
else
	echo "BACKUP_REMOTE is not set — this backup exists only on this machine" >&2
fi

# Keep a month locally; off-site retention is set on the remote.
find backups -name 'myself_*.sql.gz' -mtime +30 -delete

echo "backed up ${FILE} (${SIZE} bytes)"
