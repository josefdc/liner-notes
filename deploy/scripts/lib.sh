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
stamp_glob='[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z'
# shellcheck disable=SC2034 # used by the scripts that source this file
data_volume=${project}_sonic-data
# shellcheck disable=SC2034
spend_volume=${project}_llm-spend

# whole_number <name> <value> <least>: prints the value in base 10 (KEEP=08 is 8), or fails;
# at most 9 digits.
whole_number() {
  case $2 in '' | *[!0-9]*) fail "$1 must be a whole number, not \"$2\"" ;; esac
  [ "${#2}" -le 9 ] || fail "$1 must have at most 9 digits, not ${#2}"
  [ "$((10#$2))" -ge "$3" ] || fail "$1 must be $3 or more, not $2"
  echo "$((10#$2))"
}
lock_timeout=$(whole_number LOCK_TIMEOUT "${LOCK_TIMEOUT:-600}" 0)

# The project's backups (not its pre-restore copies), oldest first: the names sort by time.
project_backups() {
  local file
  shopt -s nullglob
  for file in "$backup_dir/$project"-$stamp_glob.tar.gz; do printf '%s\n' "$file"; done
  shopt -u nullglob
}

# Sets `image`, the image the throwaway containers run: API_IMAGE, else the image the project's
# API service container was created from (by its ID; never a one-off `compose run` container),
# else ${IMAGE_PREFIX:-liner-notes}-api:${IMAGE_TAG:-latest}. Fails unless it is on this host.
use_api_image() {
  local api
  image=${API_IMAGE:-}
  if [ -z "$image" ]; then
    api=$(docker ps -aq --filter "label=com.docker.compose.project=$project" \
      --filter label=com.docker.compose.service=api --filter label=com.docker.compose.oneoff=False |
      head -1)
    if [ -n "$api" ]; then
      image=$(docker inspect -f '{{.Image}}' "$api")
    else
      image=${IMAGE_PREFIX:-liner-notes}-api:${IMAGE_TAG:-latest}
    fi
  fi
  docker image inspect "$image" >/dev/null 2>&1 ||
    fail "no image $image on this host: build it (docker compose -f deploy/compose.prod.yml build api) or set API_IMAGE"
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

# new_stamp <prefix> <message>: prints the current UTC second (YYYYMMDDTHHMMSSZ) for a new
# <prefix><stamp>.tar.gz in BACKUP_DIR. When a run earlier in the same second has that name, it
# waits for the next second (the caller holds the lock, so no other run takes the name meanwhile):
# a file is never reused or replaced. It fails, adding $2, if the name is still taken after 50
# waits of 0.2 s, about 10 s (a clock that does not move: counted in sleeps, not read from the
# clock, which bash's SECONDS is), or if the clock cannot be read. It runs in a command
# substitution, where set -e is off, so it checks each step itself.
new_stamp() {
  local stamp tries=0
  while :; do
    stamp=$(date -u +%Y%m%dT%H%M%SZ) || fail "cannot read the clock; $2"
    [[ $stamp =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || fail "the clock gave \"$stamp\", not a UTC time; $2"
    [ -e "$backup_dir/$1$stamp.tar.gz" ] || break
    ((++tries <= 50)) ||
      fail "$1$stamp.tar.gz exists, and the clock has not moved on from $stamp in 10 s; $2"
    sleep 0.2
  done
  echo "$stamp"
}

# Runs backup-ops.cjs in a throwaway container of the API image: no network, no capabilities,
# no new privileges, the image's own files read-only; scratch space in /tmp. Volumes come as
# extra docker arguments before `--`, then the shell command run in the container. The caller
# sets `image` (use_api_image). With ops_session=own, docker runs in a session of its own, so a
# terminal's ^C reaches the script only (which takes it when the container is done), and no
# signal is passed on to the container.
# shellcheck disable=SC2154
ops_container() {
  local args=() wrap=()
  while [ "$1" != -- ]; do
    args+=("$1")
    shift
  done
  shift
  if [ "${ops_session:-}" = own ]; then wrap=(setsid -w); fi
  "${wrap[@]}" docker run --rm -i --sig-proxy=false --pull never \
    --network none --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
    "${args[@]}" \
    -v "$here/backup-ops.cjs:/ops/backup-ops.cjs:ro" \
    --entrypoint sh "$image" -c "$1"
}

# Checks an archive on stdin: its database (integrity_check) and spend log (the API's rules).
verify_archive() {
  ops_container -- 'mkdir /tmp/in && tar -xzf - -C /tmp/in && node /ops/backup-ops.cjs verify /tmp/in'
}

# Writes the checksum of $1 for the name $2 into $1.sha256, then flushes both to disk.
write_checksum() {
  local sum
  sum=$(sha256sum <"$1" | cut -d' ' -f1)
  [[ $sum =~ ^[0-9a-f]{64}$ ]] || fail "could not compute the checksum of $1"
  printf '%s  %s\n' "$sum" "$2" >"$1.sha256"
  sync "$1" "$1.sha256"
}

# Every running container that uses the volume $1, by ID.
volume_users() {
  docker ps -q --no-trunc --filter "volume=$1"
}
