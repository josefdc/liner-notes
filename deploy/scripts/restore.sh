#!/usr/bin/env bash
# Restores a backup made by deploy/scripts/backup.sh (deploy/RUNBOOK.md, "Backups").
#
#   deploy/scripts/restore.sh --dry-run <file|latest>                  checks it, changes nothing
#   deploy/scripts/restore.sh [--yes] [--project <name>] <file|latest>  restores it
#
# Both check the backup first: its checksum (<file>.sha256) and, in a throwaway container of the
# API image with no volume, PRAGMA integrity_check on a copy of its database and every line of its
# spend log by the API's rules. "latest" is the newest <project>-<YYYYMMDDTHHMMSSZ>.tar.gz in
# BACKUP_DIR (never a pre-restore copy, never another project's backup).
#
# A restore asks for the project's name, or takes --yes. A backup of another project (by its
# file name) is restored only with --project naming the target. Then, holding the backup lock:
#   1. stops every running container that uses the project's sonic-data or llm-spend volume;
#      each must be a service container of the project (not a `compose run` one-off), or the
#      restore stops there and changes nothing;
#   2. copies the volumes' files as they are (database, -wal, -shm, spend log) to
#      <project>-pre-restore-<time>.tar.gz (restore.sh restores it by its path when it holds a
#      database);
#   3. replaces the database, after the old one took in its -wal; the spend logs are merged
#      (every record of both), so a restore never lowers what the API counts as spent;
#   4. starts the containers it stopped and waits for each to turn healthy.
#
# Settings (environment): COMPOSE_PROJECT_NAME, BACKUP_DIR, API_IMAGE and LOCK_TIMEOUT as in
# backup.sh; HEALTH_TIMEOUT, the seconds to wait for a container to turn healthy (default 180).
set -euo pipefail

fail() {
  echo "restore: $*" >&2
  exit 1
}
usage() {
  echo "usage: $0 [--dry-run] [--yes] [--project <name>] <backup file|latest>" >&2
  exit 2
}

dry_run=false
yes=false
target_given=false
target=
while [ $# -gt 0 ]; do
  case $1 in
    --dry-run) dry_run=true ;;
    --yes) yes=true ;;
    --project)
      if [ $# -lt 2 ] || [ -z "$2" ]; then usage; fi
      export COMPOSE_PROJECT_NAME=$2
      target_given=true
      shift
      ;;
    -*) usage ;;
    *)
      [ -z "$target" ] || usage
      target=$1
      ;;
  esac
  shift
done
[ -n "$target" ] || usage

# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
health_timeout=${HEALTH_TIMEOUT:-180}

if [ "$target" = latest ]; then
  mapfile -t backups < <(project_backups)
  [ "${#backups[@]}" -gt 0 ] || fail "no backup of $project in $backup_dir"
  file=${backups[-1]}
else
  file=$target
fi
[ -f "$file" ] || fail "no file $file"
file=$(cd "$(dirname "$file")" && pwd)/$(basename "$file")
name=$(basename "$file")
echo "restore: $file" >&2

# The project the backup was taken from, by its name.
from=
if [[ $name =~ ^(.+)-pre-restore-[0-9]{8}T[0-9]{6}Z\.tar\.gz$ ]] ||
  [[ $name =~ ^(.+)-[0-9]{8}T[0-9]{6}Z\.tar\.gz$ ]]; then
  from=${BASH_REMATCH[1]}
fi

# The checksum, against the name it was written for.
[ -f "$file.sha256" ] || fail "no checksum $file.sha256"
read -r expected recorded <"$file.sha256" || true
[ "$recorded" = "$name" ] || fail "$file.sha256 is the checksum of \"$recorded\""
actual=$(sha256sum <"$file" | cut -d' ' -f1)
[ "$actual" = "$expected" ] || fail "checksum mismatch: $file is not the file backup.sh wrote"
echo "restore: checksum ok ($actual)" >&2

image=$(api_image)
verify_archive <"$file" || fail "the backup did not pass its checks"
if $dry_run; then
  echo "restore: dry run, nothing changed" >&2
  exit 0
fi

docker volume inspect "$data_volume" >/dev/null 2>&1 ||
  fail "no volume $data_volume: start the stack once (docker compose up -d) so compose creates it"
spend_ro=()
spend_rw=()
if docker volume inspect "$spend_volume" >/dev/null 2>&1; then
  spend_ro=(-v "$spend_volume:/app/spend:ro")
  spend_rw=(-v "$spend_volume:/app/spend")
fi

if [ "$from" != "$project" ]; then
  echo "restore: $name is a backup of project \"${from:-unknown}\", not of $project" >&2
  if $yes && ! $target_given; then
    fail "pass --project $project to restore it into $project; nothing changed"
  fi
fi
if ! $yes; then
  [ -t 0 ] || fail "not a terminal: pass --yes to replace the database of $project"
  read -r -p "Replace the database of project $project with $name? Type the project name: " answer
  [ "$answer" = "$project" ] || fail "not confirmed; nothing changed"
fi

mkdir -p "$backup_dir"
backup_dir=$(cd "$backup_dir" && pwd)
take_lock "nothing changed"

# Every running container that uses the volumes; each must be a service container of the
# project, so that the ones stopped here are the ones compose would start again.
mapfile -t holders < <({
  docker ps -q --no-trunc --filter "volume=$data_volume"
  docker ps -q --no-trunc --filter "volume=$spend_volume"
} | sort -u)
for id in "${holders[@]}"; do
  labels=$(docker inspect -f \
    '{{.Name}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.oneoff"}}' "$id")
  IFS='|' read -r cname owner oneoff <<<"$labels"
  if [ "$owner" != "$project" ] || [ "$oneoff" != False ]; then
    fail "${cname#/} uses the volumes of $project but is not one of its service containers; stop it first; nothing changed"
  fi
done

restart() {
  local id
  for id in "${holders[@]}"; do docker start "$id" >/dev/null || true; done
}
for id in "${holders[@]}"; do
  echo "restore: stopping $(docker inspect -f '{{.Name}}' "$id" | cut -c2-)" >&2
  docker stop "$id" >/dev/null
done

# The volumes as they are now, in case this restore was a mistake.
stamp=$(date -u +%Y%m%dT%H%M%SZ)
safety="$backup_dir/$project-pre-restore-$stamp.tar.gz"
partial="$backup_dir/.$(basename "$safety").partial"
trap 'rm -f "$partial" "$partial.sha256"' EXIT
# shellcheck disable=SC2016 # expanded in the container
if ! ops_container -v "$data_volume:/app/data:ro" "${spend_ro[@]}" -- \
  'node /ops/backup-ops.cjs copy /tmp/out >&2 && cd /tmp/out && if [ -n "$(ls)" ]; then tar -czf - *; fi' \
  >"$partial" </dev/null; then
  restart
  fail "could not copy the volumes before the restore; nothing changed"
fi
if [ -s "$partial" ]; then
  write_checksum "$partial" "$(basename "$safety")"
  mv "$partial" "$safety"
  mv "$partial.sha256" "$safety.sha256"
  sync "$backup_dir"
  echo "restore: the volumes as they were are in $safety" >&2
fi

if ! ops_container -v "$data_volume:/app/data" "${spend_rw[@]}" -- \
  'mkdir /tmp/in && tar -xzf - -C /tmp/in && node /ops/backup-ops.cjs install /tmp/in' <"$file"; then
  restart
  fail "the restore failed; the volumes as they were are in ${safety##*/} (if it was written)"
fi

if [ "${#holders[@]}" -eq 0 ]; then
  echo "restore: done; no running container of $project used the volumes, none started" >&2
  exit 0
fi
for id in "${holders[@]}"; do
  cname=$(docker inspect -f '{{.Name}}' "$id" | cut -c2-)
  echo "restore: starting $cname" >&2
  docker start "$id" >/dev/null
  status=
  for _ in $(seq 1 "$health_timeout"); do
    status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id")
    case $status in healthy | running | unhealthy | exited | dead) break ;; esac
    sleep 1
  done
  case $status in
    healthy | running) echo "restore: $cname is $status" >&2 ;;
    *) fail "$cname is $status after the restore: see docker logs $cname" ;;
  esac
done
echo "restore: done" >&2
