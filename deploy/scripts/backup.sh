#!/usr/bin/env bash
# Backs up a deployment of deploy/compose.prod.yml: the database on its sonic-data volume and the
# spend log on its llm-spend volume, while the API runs (deploy/RUNBOOK.md, "Backups").
#
#   deploy/scripts/backup.sh       prints the path of the new backup on stdout
#
# Each backup is <BACKUP_DIR>/<project>-<YYYYMMDDTHHMMSSZ>.tar.gz (sonic-agent.db, and
# llm-spend.jsonl when the volume has one) with its checksum in <file>.sha256, both readable by
# their owner only. The database is copied with VACUUM INTO, one consistent snapshot, in a
# throwaway container of the API image: no network, no capabilities, the image's files read-only,
# the data volume mounted read-write (SQLite needs that to read a database the API has open).
# The archive is then checked as restore.sh checks it (integrity_check, and the spend log by the
# API's rules); one that fails is never kept, and the run exits non-zero.
#
# A spend log that breaks the API's rules (its last line cut by a crash, say) does not stop the
# database's backup: it goes into the archive as llm-spend.jsonl.invalid, which no restore
# applies, nothing is pruned, and the run exits 3 so cron reports it. The API refuses model calls
# on such a log too; deploy/scripts/spend-log.sh repair-tail fixes a cut last line.
#
# Safe from cron: runs never overlap (a lock in BACKUP_DIR), a backup is flushed to disk and
# renamed into place only when complete, and only the newest KEEP backups of the project stay
# (restore.sh's pre-restore copies are neither counted nor removed).
#
# Settings (environment):
#   COMPOSE_PROJECT_NAME  the compose project (default liner-notes, compose.prod.yml's name)
#   BACKUP_DIR            where backups go (default deploy/backups, next to the compose file)
#   KEEP                  backups of the project to keep (default 14; 0 keeps every one)
#   API_IMAGE             the image the copy runs in (default: the project's API container's
#                         image, else ${IMAGE_PREFIX:-liner-notes}-api:${IMAGE_TAG:-latest})
#   LOCK_TIMEOUT          seconds to wait for a backup or restore already running (default 600)
set -euo pipefail

fail() {
  echo "backup: $*" >&2
  exit 1
}
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

keep=$(whole_number KEEP "${KEEP:-14}" 0)
docker volume inspect "$data_volume" >/dev/null 2>&1 ||
  fail "no volume $data_volume (is COMPOSE_PROJECT_NAME right? has the stack started once?)"
spend_mount=()
if docker volume inspect "$spend_volume" >/dev/null 2>&1; then
  spend_mount=(-v "$spend_volume:/app/spend:ro")
fi
use_api_image

mkdir -p "$backup_dir"
backup_dir=$(cd "$backup_dir" && pwd)
take_lock "no backup was written"

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
ops_container -v "$data_volume:/app/data" "${spend_mount[@]}" -- \
  'node /ops/backup-ops.cjs snapshot /tmp/out >&2 && cd /tmp/out && tar -czf - *' \
  >"$partial" </dev/null || fail "the copy failed; no backup was written"
[ -s "$partial" ] || fail "the copy is empty; no backup was written"
echo "backup: checking the archive as restore.sh will" >&2
verify_archive <"$partial" || fail "the archive did not pass restore.sh's checks; no backup was written"

write_checksum "$partial" "$name"
mv "$partial" "$backup_dir/$name"
mv "$partial.sha256" "$backup_dir/$name.sha256"
sync "$backup_dir"
echo "backup: $name, $(du -h "$backup_dir/$name" | cut -f1)" >&2
if tar -tzf "$backup_dir/$name" | grep -x llm-spend.jsonl.invalid >/dev/null; then
  echo "$backup_dir/$name"
  echo "backup: FAILED for the spend log: $name holds the database, but the spend log broke the" \
    "API's rules (above) and is in it as llm-spend.jsonl.invalid, which no restore applies;" \
    "no backup was pruned. A cut last line: stop the API, run deploy/scripts/spend-log.sh" \
    "repair-tail, start it, back up again (deploy/RUNBOOK.md, \"Backups\")" >&2
  exit 3
fi

# The newest KEEP backups of this project stay.
if [ "$keep" -gt 0 ]; then
  mapfile -t backups < <(project_backups)
  if [ "${#backups[@]}" -gt "$keep" ]; then
    for old in "${backups[@]:0:${#backups[@]}-keep}"; do
      rm -f "$old" "$old.sha256"
      echo "backup: removed $(basename "$old")" >&2
    done
    sync "$backup_dir"
  fi
fi

echo "$backup_dir/$name"
