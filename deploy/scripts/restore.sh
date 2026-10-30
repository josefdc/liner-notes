#!/usr/bin/env bash
# Restores a backup made by deploy/scripts/backup.sh (deploy/RUNBOOK.md, "Backups").
#
#   deploy/scripts/restore.sh --dry-run <file|latest>   checks a backup, changes nothing
#   deploy/scripts/restore.sh [--yes] <file|latest>     replaces the deployment's database
#
# Both check the backup first: its checksum (<file>.sha256) and, in a throwaway container of the
# API image with no volume, PRAGMA integrity_check on a copy of its database and every line of
# its spend log. "latest" is the newest backup of the project in BACKUP_DIR.
#
# Without --dry-run it asks for the project's name (or takes --yes), backs up the current
# database (backup.sh), stops the API, replaces the database on the sonic-data volume, and starts
# the API again, waiting for it to turn healthy. The spend log is restored only when the
# llm-spend volume has none: an older log would undercount what was spent.
#
# Settings (environment): COMPOSE_PROJECT_NAME, BACKUP_DIR and API_IMAGE as in backup.sh;
# HEALTH_TIMEOUT, the seconds to wait for the API to turn healthy (default 180).
set -euo pipefail
export LC_ALL=C
umask 077

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
project=${COMPOSE_PROJECT_NAME:-liner-notes}
backup_dir=${BACKUP_DIR:-$here/../backups}
health_timeout=${HEALTH_TIMEOUT:-180}

fail() {
  echo "restore: $*" >&2
  exit 1
}
usage() {
  echo "usage: $0 [--dry-run] [--yes] <backup file|latest>" >&2
  exit 2
}

dry_run=false
yes=false
target=
for arg in "$@"; do
  case $arg in
    --dry-run) dry_run=true ;;
    --yes) yes=true ;;
    -*) usage ;;
    *) [ -z "$target" ] || usage; target=$arg ;;
  esac
done
[ -n "$target" ] || usage

if [ "$target" = latest ]; then
  [ -d "$backup_dir" ] || fail "no backup directory $backup_dir"
  shopt -s nullglob
  backups=("$backup_dir/$project"-[0-9]*Z.tar.gz)
  shopt -u nullglob
  [ "${#backups[@]}" -gt 0 ] || fail "no backup of $project in $backup_dir"
  file=${backups[-1]}
else
  file=$target
fi
[ -f "$file" ] || fail "no file $file"
file=$(cd "$(dirname "$file")" && pwd)/$(basename "$file")
echo "restore: $file" >&2

# The checksum, against the name it was written for.
[ -f "$file.sha256" ] || fail "no checksum $file.sha256"
read -r expected recorded <"$file.sha256" || true
[ "$recorded" = "$(basename "$file")" ] || fail "$file.sha256 is the checksum of \"$recorded\""
actual=$(sha256sum <"$file" | cut -d' ' -f1)
[ "$actual" = "$expected" ] || fail "checksum mismatch: $file is not the file backup.sh wrote"
echo "restore: checksum ok ($actual)" >&2

api=$(docker ps -aq --filter "label=com.docker.compose.project=$project" \
  --filter "label=com.docker.compose.service=api" | head -1)
image=${API_IMAGE:-}
if [ -z "$image" ] && [ -n "$api" ]; then
  image=$(docker inspect -f '{{.Config.Image}}' "$api")
fi
image=${image:-${IMAGE_PREFIX:-liner-notes}-api:${IMAGE_TAG:-latest}}

# Runs backup-ops.cjs on the archive (stdin), unpacked in the container's own /tmp.
ops() {
  local command=$1
  shift
  docker run --rm -i --pull never --network none --read-only --tmpfs /tmp \
    --cap-drop ALL --security-opt no-new-privileges "$@" \
    -v "$here/backup-ops.cjs:/ops/backup-ops.cjs:ro" \
    --entrypoint sh "$image" -c \
    "mkdir /tmp/in && tar -xzf - -C /tmp/in && node /ops/backup-ops.cjs $command /tmp/in" \
    <"$file"
}

ops verify || fail "the backup did not pass its checks"
if $dry_run; then
  echo "restore: dry run, nothing changed" >&2
  exit 0
fi

docker volume inspect "${project}_sonic-data" >/dev/null 2>&1 ||
  fail "no volume ${project}_sonic-data: start the stack once (docker compose up -d) so compose creates it"
spend_mount=()
if docker volume inspect "${project}_llm-spend" >/dev/null 2>&1; then
  spend_mount=(-v "${project}_llm-spend:/app/spend")
fi

if ! $yes; then
  [ -t 0 ] || fail "not a terminal: pass --yes to replace the database of $project"
  read -r -p "Replace the database of project $project with $(basename "$file")? Type the project name: " answer
  [ "$answer" = "$project" ] || fail "not confirmed; nothing changed"
fi

# The database as it is now, in case this restore was a mistake.
if [ -n "$api" ]; then
  echo "restore: backing up the current database first" >&2
  COMPOSE_PROJECT_NAME=$project BACKUP_DIR=$backup_dir KEEP=0 API_IMAGE=$image \
    "$here/backup.sh" >/dev/null || fail "could not back up the current database; nothing changed"
fi

exec 9>"$backup_dir/.lock"
flock -w 600 9 || fail "a backup has held $backup_dir/.lock for 10 minutes; nothing changed"

if [ -n "$api" ]; then
  echo "restore: stopping the API ($api)" >&2
  docker stop "$api" >/dev/null
fi
ops install -v "${project}_sonic-data:/app/data" "${spend_mount[@]}" ||
  fail "the restore failed${api:+; the API is stopped (docker start $api)}"
if [ -z "$api" ]; then
  echo "restore: done; no API container of $project to start" >&2
  exit 0
fi

echo "restore: starting the API" >&2
docker start "$api" >/dev/null
status=
for _ in $(seq 1 "$health_timeout"); do
  status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$api")
  case $status in healthy | running) break ;; unhealthy | exited | dead) break ;; esac
  sleep 1
done
case $status in
  healthy | running) echo "restore: done; the API is $status" >&2 ;;
  *) fail "the API is $status after the restore: see docker logs $api" ;;
esac
