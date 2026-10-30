#!/usr/bin/env bash
# The spend log on a deployment's llm-spend volume (deploy/RUNBOOK.md, "Azure" and "Backups").
#
#   deploy/scripts/spend-log.sh total        its records and USD total, as the API counts them
#   deploy/scripts/spend-log.sh repair-tail  with the API stopped: moves the last line to
#                                            llm-spend.jsonl.torn when it is not a valid record
#
# A crash during an append can leave the last line cut short; the API then refuses every model
# call, and backup.sh keeps the log aside. repair-tail does what the API's own repairTornTail does
# (one line moved, with a dated note, to <log>.torn); an earlier malformed line is left for a
# person to fix. It refuses while any container uses the volume.
#
# Both run in a throwaway container of the API image, as backup.sh does. Settings (environment):
# COMPOSE_PROJECT_NAME, BACKUP_DIR, API_IMAGE and LOCK_TIMEOUT as in backup.sh.
set -euo pipefail

fail() {
  echo "spend-log: $*" >&2
  exit 1
}
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

command=${1:-}
case $command in
  total | repair-tail) ;;
  *) fail "usage: $0 total|repair-tail" ;;
esac
docker volume inspect "$spend_volume" >/dev/null 2>&1 ||
  fail "no volume $spend_volume (is COMPOSE_PROJECT_NAME right? has the stack started once?)"
use_api_image

if [ "$command" = total ]; then
  ops_container -v "$spend_volume:/app/spend:ro" -- \
    'node /ops/backup-ops.cjs total /app/spend/llm-spend.jsonl' </dev/null
  exit
fi

mkdir -p "$backup_dir"
take_lock "nothing changed"
users=$(volume_users "$spend_volume")
if [ -n "$users" ]; then
  fail "$(docker inspect -f '{{.Name}}' "$(head -1 <<<"$users")" | cut -c2-) uses $spend_volume:" \
    "stop it first (docker compose -f deploy/compose.prod.yml stop api); nothing changed"
fi
ops_container -v "$spend_volume:/app/spend" -- \
  'node /ops/backup-ops.cjs repair-tail /app/spend/llm-spend.jsonl' </dev/null
