#!/usr/bin/env bash
# Checks deploy/scripts/backup.sh and restore.sh against a throwaway project: an API container
# from the API image (no network, recorded runs only) on volumes of its own, removed at the end
# with everything this test created. CI runs it after building the images
# (.github/workflows/docker.yml).
#
#   deploy/scripts/backup-restore.test.sh     API_IMAGE: the image (default liner-notes-api:latest)
#
# A backup is written with its checksum while the API runs, a dry run verifies it and changes
# nothing, a changed byte or a damaged database is refused, a restore without --yes off a
# terminal is refused, a restore into fresh volumes brings back the database and the spend log
# as they were at the backup and the API turns healthy again, a later restore keeps a spend log
# already on the volume, and KEEP prunes the oldest backups.
set -euo pipefail
export LC_ALL=C

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
image=${API_IMAGE:-liner-notes-api:latest}
project=ln-backup-test-$$
container=$project-api
work=$(mktemp -d)
export COMPOSE_PROJECT_NAME=$project BACKUP_DIR=$work/backups API_IMAGE=$image HEALTH_TIMEOUT=120

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker volume rm -f "${project}_sonic-data" "${project}_llm-spend" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# The API of the throwaway project, labelled as compose labels it, on its volumes (created when
# missing), checked every 2 s; returns once it is healthy.
start_api() {
  docker run -d --name "$container" --pull never --network none \
    --label "com.docker.compose.project=$project" --label com.docker.compose.service=api \
    --health-interval 2s --health-start-period 60s \
    -e REPLAY_MODE=only -e RUN_TOKEN_SECRET=test-only-run-token-secret-not-for-any-deployment \
    -e TURNSTILE_SECRET_KEY=test-only-turnstile-secret \
    -v "${project}_sonic-data:/app/data" -v "${project}_llm-spend:/app/spend" "$image" >/dev/null
  for _ in $(seq 1 60); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$container")" = healthy ] && return
    sleep 1
  done
  docker logs "$container" >&2
  fail "the API did not turn healthy"
}

# Runs SQL in the API container against its database: sql <statement> [parameter...].
sql() {
  docker exec "$container" node -e '
    const Database = require("node:module").createRequire("/app/apps/api/package.json")("better-sqlite3");
    const db = new Database("/app/data/sonic-agent.db", { fileMustExist: true, timeout: 15000 });
    const statement = db.prepare(process.argv[1]);
    const params = process.argv.slice(2);
    if (statement.reader) for (const row of statement.all(...params)) console.log(Object.values(row).join("|"));
    else statement.run(...params);
    db.close();
  ' "$@"
}

put_marker() {
  sql "INSERT INTO store_items (namespace, key, value, created_at, updated_at)
       VALUES ('[\"backup-test\"]', ?, '{}', datetime('now'), datetime('now'))" "$1"
}

markers() {
  sql "SELECT group_concat(key, ',') FROM (SELECT key FROM store_items
       WHERE namespace = '[\"backup-test\"]' ORDER BY key)"
}

spend_lines() {
  docker exec "$container" sh -c 'if [ -f /app/spend/llm-spend.jsonl ]; then wc -l </app/spend/llm-spend.jsonl; else echo none; fi'
}

add_spend_line() {
  docker exec "$container" sh -c "printf '%s\n' '{\"ts\":\"2026-01-01T00:00:00.000Z\",\"deployment\":\"test\",\"in\":1,\"out\":1,\"usd_est\":0.01,\"unit\":\"dev\"}' >>/app/spend/llm-spend.jsonl"
}

start_api
put_marker before-backup
add_spend_line

# A backup while the API runs.
file=$("$here/backup.sh")
[ -f "$file" ] || fail "backup.sh wrote no backup ($file)"
[ -f "$file.sha256" ] || fail "backup.sh wrote no checksum ($file.sha256)"
[ "$(stat -c %a "$file")" = 600 ] || fail "the backup is not readable by its owner only"
(cd "$BACKUP_DIR" && sha256sum -c --status "$(basename "$file").sha256") || fail "the checksum does not match"
listing=$(tar -tzf "$file" | sort | tr '\n' ' ')
[ "$listing" = "llm-spend.jsonl sonic-agent.db " ] || fail "the backup holds: $listing"
echo "ok: backup.sh wrote $(basename "$file") and its checksum while the API ran"

put_marker after-backup
api_id=$(docker inspect -f '{{.Id}} {{.State.StartedAt}}' "$container")

# The dry run verifies, and changes nothing.
out=$("$here/restore.sh" --dry-run latest 2>&1) || fail "the dry run failed: $out"
grep -q 'checksum ok' <<<"$out" || fail "the dry run checked no checksum: $out"
grep -q 'database: integrity ok' <<<"$out" || fail "the dry run checked no integrity: $out"
grep -q 'spend log: 1 lines, all valid' <<<"$out" || fail "the dry run checked no spend log: $out"
[ "$(markers)" = "after-backup,before-backup" ] || fail "the dry run changed the database"
[ "$(docker inspect -f '{{.Id}} {{.State.StartedAt}}' "$container")" = "$api_id" ] ||
  fail "the dry run restarted the API"
echo "ok: restore.sh --dry-run latest verified the backup and changed nothing"

# A changed byte fails the checksum.
mkdir "$work/changed"
cp "$file" "$file.sha256" "$work/changed/"
changed="$work/changed/$(basename "$file")"
printf 'x' | dd of="$changed" bs=1 seek=100 conv=notrunc status=none
if out=$("$here/restore.sh" --dry-run "$changed" 2>&1); then fail "a changed backup passed: $out"; fi
grep -q 'checksum mismatch' <<<"$out" || fail "a changed backup failed for another reason: $out"
echo "ok: a changed backup is refused (checksum)"

# A damaged database with a matching checksum fails the integrity check.
mkdir "$work/damaged" "$work/damaged/in"
tar -xzf "$file" -C "$work/damaged/in"
pages=$(($(stat -c %s "$work/damaged/in/sonic-agent.db") / 4096))
[ "$pages" -gt 2 ] || fail "the database is too small to damage ($pages pages)"
head -c 4096 /dev/urandom | dd of="$work/damaged/in/sonic-agent.db" bs=4096 seek=$((pages - 1)) conv=notrunc status=none
damaged="$work/damaged/$(basename "$file")"
tar -czf "$damaged" -C "$work/damaged/in" sonic-agent.db llm-spend.jsonl
printf '%s  %s\n' "$(sha256sum <"$damaged" | cut -d' ' -f1)" "$(basename "$damaged")" >"$damaged.sha256"
if out=$("$here/restore.sh" --dry-run "$damaged" 2>&1); then fail "a damaged database passed: $out"; fi
grep -q 'checksum ok' <<<"$out" || fail "a damaged database failed its checksum: $out"
grep -q 'did not pass its checks' <<<"$out" || fail "a damaged database failed for another reason: $out"
echo "ok: a damaged database is refused (integrity_check)"

# Off a terminal, a restore needs --yes.
if out=$("$here/restore.sh" latest 2>&1 </dev/null); then fail "a restore ran unconfirmed: $out"; fi
grep -q 'pass --yes' <<<"$out" || fail "an unconfirmed restore failed for another reason: $out"
[ "$(markers)" = "after-backup,before-backup" ] || fail "an unconfirmed restore changed the database"
echo "ok: a restore without --yes off a terminal is refused, nothing changed"

# Fresh volumes: a new, empty database and no spend log.
docker rm -f "$container" >/dev/null
docker volume rm "${project}_sonic-data" "${project}_llm-spend" >/dev/null
start_api
[ -z "$(markers)" ] || fail "the fresh database holds markers: $(markers)"
[ "$(spend_lines)" = none ] || fail "the fresh spend volume holds a spend log"
out=$("$here/restore.sh" --yes "$file" 2>&1) || fail "the restore failed: $out"
grep -q 'the API is healthy' <<<"$out" || fail "the restore did not wait for a healthy API: $out"
[ "$(markers)" = "before-backup" ] || fail "restored markers: $(markers)"
[ "$(spend_lines)" = 1 ] || fail "restored spend log lines: $(spend_lines)"
[ "$(find "$BACKUP_DIR" -name "$project-*.tar.gz" | wc -l)" = 2 ] ||
  fail "the restore did not back up the database it replaced"
echo "ok: restore.sh --yes into fresh volumes brought back the database and the spend log; the API is healthy"

# A spend log already on the volume stays: the restore never rolls spending back.
add_spend_line
out=$("$here/restore.sh" --yes "$file" 2>&1) || fail "the second restore failed: $out"
grep -q 'spend log: kept the one on the volume' <<<"$out" || fail "the spend log was not kept: $out"
[ "$(spend_lines)" = 2 ] || fail "spend log lines after the second restore: $(spend_lines)"
[ "$(markers)" = "before-backup" ] || fail "markers after the second restore: $(markers)"
echo "ok: a second restore kept the newer spend log on the volume"

# KEEP prunes the oldest backups of the project.
sleep 1
KEEP=1 "$here/backup.sh" >/dev/null
[ "$(find "$BACKUP_DIR" -name "$project-*.tar.gz*" | wc -l)" = 2 ] || fail "KEEP=1 left: $(ls "$BACKUP_DIR")"
echo "ok: KEEP=1 left the newest backup and its checksum"

echo "all backup and restore checks passed"
