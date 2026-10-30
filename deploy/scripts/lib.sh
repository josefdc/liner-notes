# Shared by backup.sh and restore.sh (sourced, not run).
#
# A backup is <project>-<YYYYMMDDTHHMMSSZ>.tar.gz; the copy restore.sh takes before it replaces
# anything is <project>-pre-restore-<YYYYMMDDTHHMMSSZ>.tar.gz, which "latest" and KEEP never
# match. Each has its checksum in <file>.sha256.
# shellcheck shell=bash

export LC_ALL=C
umask 077

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
project=${COMPOSE_PROJECT_NAME:-liner-notes}
backup_dir=${BACKUP_DIR:-$here/../backups}
lock_timeout=${LOCK_TIMEOUT:-600}
stamp_glob='[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z'
# shellcheck disable=SC2034 # used by the scripts that source this file
data_volume=${project}_sonic-data
# shellcheck disable=SC2034
spend_volume=${project}_llm-spend

case $lock_timeout in '' | *[!0-9]*) fail "LOCK_TIMEOUT must be a whole number of seconds" ;; esac

# The project's backups (not its pre-restore copies), oldest first: the names sort by time.
project_backups() {
  local file
  shopt -s nullglob
  for file in "$backup_dir/$project"-$stamp_glob.tar.gz; do printf '%s\n' "$file"; done
  shopt -u nullglob
}

# The API image: API_IMAGE, else the image of the project's API service container (never a
# one-off `compose run` container), else ${IMAGE_PREFIX:-liner-notes}-api:${IMAGE_TAG:-latest}.
api_image() {
  local api
  if [ -n "${API_IMAGE:-}" ]; then
    echo "$API_IMAGE"
    return
  fi
  api=$(docker ps -aq --filter "label=com.docker.compose.project=$project" \
    --filter label=com.docker.compose.service=api --filter label=com.docker.compose.oneoff=False |
    head -1)
  if [ -n "$api" ]; then
    docker inspect -f '{{.Config.Image}}' "$api"
  else
    echo "${IMAGE_PREFIX:-liner-notes}-api:${IMAGE_TAG:-latest}"
  fi
}

# Takes the lock that keeps backups and restores of BACKUP_DIR from overlapping (fd 9); $1 is
# added to the message when it cannot.
take_lock() {
  local lock=$backup_dir/.lock
  if ! { exec 9>>"$lock"; } 2>/dev/null; then
    fail "cannot open the lock $lock: run this as the user who owns $backup_dir; $1"
  fi
  flock -w "$lock_timeout" 9 ||
    fail "another backup or restore has held $lock for $lock_timeout s; $1"
}

# Runs backup-ops.cjs in a throwaway container of the API image: no network, no capabilities,
# no new privileges, the image's own files read-only; scratch space in /tmp. Volumes come as
# extra docker arguments before `--`, then the shell command run in the container. The caller
# sets `image` (api_image).
# shellcheck disable=SC2154
ops_container() {
  local args=()
  while [ "$1" != -- ]; do
    args+=("$1")
    shift
  done
  shift
  docker run --rm -i --pull never --network none --read-only --tmpfs /tmp \
    --cap-drop ALL --security-opt no-new-privileges "${args[@]}" \
    -v "$here/backup-ops.cjs:/ops/backup-ops.cjs:ro" \
    --entrypoint sh "$image" -c "$1"
}

# Checks an archive on stdin: its database (integrity_check) and spend log (the API's rules).
verify_archive() {
  ops_container -- 'mkdir /tmp/in && tar -xzf - -C /tmp/in && node /ops/backup-ops.cjs verify /tmp/in'
}

# Writes the checksum of $1 for the name $2 into $1.sha256, then flushes both to disk.
write_checksum() {
  printf '%s  %s\n' "$(sha256sum <"$1" | cut -d' ' -f1)" "$2" >"$1.sha256"
  sync "$1" "$1.sha256"
}
