#!/usr/bin/env bash
# Backs up a deployment of deploy/compose.prod.yml: the database on its sonic-data volume and the
# spend log on its llm-spend volume, while the API runs (deploy/RUNBOOK.md, "Backups").
#
#   deploy/scripts/backup.sh       prints the path of the new backup on stdout
#
# Each backup is <BACKUP_DIR>/<project>-<UTC time>.tar.gz (sonic-agent.db, and llm-spend.jsonl
# when the volume has one) with its checksum in <file>.sha256, both readable by their owner only.
# The database is copied with VACUUM INTO, one consistent snapshot, in a throwaway container of
# the API image (no network, read-only, as the API's user); it must pass PRAGMA integrity_check
# before the backup is kept. Safe from cron: runs never overlap (a lock in BACKUP_DIR), a backup
# is renamed into place only when complete, and only the newest KEEP backups of the project stay.
#
# Settings (environment):
#   COMPOSE_PROJECT_NAME  the compose project (default liner-notes, compose.prod.yml's name)
#   BACKUP_DIR            where backups go (default deploy/backups, next to the compose file)
#   KEEP                  backups of the project to keep (default 14; 0 keeps every one)
#   API_IMAGE             the image the copy runs in (default: the project's API container's
#                         image, else ${IMAGE_PREFIX:-liner-notes}-api:${IMAGE_TAG:-latest})
set -euo pipefail
export LC_ALL=C
umask 077

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
project=${COMPOSE_PROJECT_NAME:-liner-notes}
backup_dir=${BACKUP_DIR:-$here/../backups}
keep=${KEEP:-14}

fail() {
  echo "backup: $*" >&2
  exit 1
}

case $keep in '' | *[!0-9]*) fail "KEEP must be a whole number, not \"$keep\"" ;; esac
docker volume inspect "${project}_sonic-data" >/dev/null 2>&1 ||
  fail "no volume ${project}_sonic-data (is COMPOSE_PROJECT_NAME right? has the stack started once?)"
spend_mount=()
if docker volume inspect "${project}_llm-spend" >/dev/null 2>&1; then
  spend_mount=(-v "${project}_llm-spend:/app/spend:ro")
fi

api=$(docker ps -aq --filter "label=com.docker.compose.project=$project" \
  --filter "label=com.docker.compose.service=api" | head -1)
image=${API_IMAGE:-}
if [ -z "$image" ] && [ -n "$api" ]; then
  image=$(docker inspect -f '{{.Config.Image}}' "$api")
fi
image=${image:-${IMAGE_PREFIX:-liner-notes}-api:${IMAGE_TAG:-latest}}

mkdir -p "$backup_dir"
backup_dir=$(cd "$backup_dir" && pwd)
exec 9>"$backup_dir/.lock"
flock -w 600 9 || fail "another backup or restore has held $backup_dir/.lock for 10 minutes"

stamp=$(date -u +%Y%m%dT%H%M%SZ)
name="$project-$stamp.tar.gz"
if [ -e "$backup_dir/$name" ]; then
  # A run in the same second already wrote it.
  echo "$backup_dir/$name"
  exit 0
fi
partial="$backup_dir/.$name.partial"
trap 'rm -f "$partial" "$partial.sha256"' EXIT

# The archive comes out on stdout; the container's messages on stderr.
docker run --rm --pull never --network none --read-only --tmpfs /tmp \
  --cap-drop ALL --security-opt no-new-privileges \
  -v "${project}_sonic-data:/app/data" "${spend_mount[@]}" \
  -v "$here/backup-ops.cjs:/ops/backup-ops.cjs:ro" \
  --entrypoint sh "$image" -c \
  'node /ops/backup-ops.cjs snapshot /tmp/out >&2 && cd /tmp/out && tar -czf - *' \
  >"$partial" </dev/null || fail "the copy failed; no backup was written"
[ -s "$partial" ] || fail "the copy is empty; no backup was written"

hash=$(sha256sum <"$partial" | cut -d' ' -f1)
printf '%s  %s\n' "$hash" "$name" >"$partial.sha256"
mv "$partial" "$backup_dir/$name"
mv "$partial.sha256" "$backup_dir/$name.sha256"
echo "backup: $name, $(du -h "$backup_dir/$name" | cut -f1)" >&2

# The newest KEEP backups of this project stay (the names sort by time).
if [ "$keep" -gt 0 ]; then
  backups=("$backup_dir/$project"-[0-9]*Z.tar.gz)
  if [ "${#backups[@]}" -gt "$keep" ]; then
    for old in "${backups[@]:0:${#backups[@]}-keep}"; do
      rm -f "$old" "$old.sha256"
      echo "backup: removed $(basename "$old")" >&2
    done
  fi
fi

echo "$backup_dir/$name"
