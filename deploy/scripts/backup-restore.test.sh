#!/usr/bin/env bash
# Checks deploy/scripts/backup.sh and restore.sh against a throwaway project: an API container
# from the API image (no network, recorded runs only) on volumes of its own, removed at the end
# with everything else this test created. CI runs it after building the images
# (.github/workflows/docker.yml).
#
#   deploy/scripts/backup-restore.test.sh     API_IMAGE: the image (default liner-notes-api:latest)
#
# Backups: written with their checksum while the API runs; "latest" is the newest of two, never
# a pre-restore copy or another project's file; a spend log with a blank line is kept, one caught
# mid-append is read again, one with a malformed line and a database that fails integrity_check
# are refused with no archive kept; KEEP removes the oldest only. Restores: a dry run verifies
# and changes nothing; a changed byte, a damaged archive, a missing --yes off a terminal, another
# project's backup without --project, a held or unreadable lock, and a container that is not a
# service of the project are refused with nothing changed; a one-off container is never taken
# for the API; the volumes are copied first, -wal included, also with no API running; a -wal
# left beside a damaged database is not applied to the restored one; spend logs are merged. Every
# container the scripts start has no network, no capabilities and a read-only image filesystem.
set -euo pipefail
export LC_ALL=C

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
image=${API_IMAGE:-liner-notes-api:latest}
project=ln-backup-test-$$
container=$project-api
data=${project}_sonic-data
spend=${project}_llm-spend
work=$(mktemp -d)
export COMPOSE_PROJECT_NAME=$project BACKUP_DIR=$work/backups API_IMAGE=$image HEALTH_TIMEOUT=120
mkdir "$BACKUP_DIR"
holder=

cleanup() {
  [ -z "$holder" ] || kill "$holder" 2>/dev/null || true
  docker rm -f "$container" "$project-oneoff" "$project-intruder" >/dev/null 2>&1 || true
  docker volume rm -f "$data" "$spend" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# The scripts run with a docker that logs the arguments of every `docker run`.
mkdir "$work/bin"
# shellcheck disable=SC2016 # the shim's own variables
printf '#!/bin/sh\n[ "$1" = run ] && printf "%%s\\n" "$*" >>"%s"\nexec %s "$@"\n' \
  "$work/docker-runs.log" "$(command -v docker)" >"$work/bin/docker"
chmod +x "$work/bin/docker"
backup() { PATH="$work/bin:$PATH" "$here/backup.sh"; }
restore() { PATH="$work/bin:$PATH" "$here/restore.sh" "$@"; }

# The API of the throwaway project, labelled as compose labels a service container, on its
# volumes (created when missing), checked every 2 s; returns once it is healthy.
start_api() {
  docker run -d --name "$container" --pull never --network none \
    --label "com.docker.compose.project=$project" --label com.docker.compose.service=api \
    --label com.docker.compose.oneoff=False --health-interval 2s --health-start-period 60s \
    -e REPLAY_MODE=only -e RUN_TOKEN_SECRET=test-only-run-token-secret-not-for-any-deployment \
    -e TURNSTILE_SECRET_KEY=test-only-turnstile-secret \
    -v "$data:/app/data" -v "$spend:/app/spend" "$image" >/dev/null
  wait_healthy
}
wait_healthy() {
  for _ in $(seq 1 60); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$container")" = healthy ] && return
    sleep 1
  done
  docker logs "$container" >&2
  fail "the API did not turn healthy"
}
started() { docker inspect -f '{{.State.StartedAt}}' "$container"; }

# Node in a throwaway container on the volumes (the API's user): vol_node <script> [arg...].
vol_node() {
  docker run --rm --pull never --network none -v "$data:/app/data" -v "$spend:/app/spend" \
    --entrypoint node "$image" -e "const D = require('node:module').createRequire('/app/apps/api/package.json')('better-sqlite3'); const fs = require('node:fs'); $1" "${@:2}"
}

# SQL against the database: sql <statement> [parameter...] (through the API container).
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

spend_line() { printf '{"ts":"2026-01-01T00:00:00.000Z","deployment":"test","in":1,"out":1,"usd_est":%s,"unit":"dev"}' "$1"; }
spend_append() {
  docker run --rm -i --pull never --network none -v "$spend:/app/spend" --entrypoint sh "$image" \
    -c 'cat >>/app/spend/llm-spend.jsonl'
}
spend_records() {
  docker run --rm --pull never --network none -v "$spend:/app/spend" --entrypoint sh "$image" -c \
    'if [ -f /app/spend/llm-spend.jsonl ]; then grep -c . /app/spend/llm-spend.jsonl || true; else echo none; fi'
}

# The project's backups (exact names), oldest first.
backups() { find "$BACKUP_DIR" -maxdepth 1 -type f | sed 's|.*/||' | grep -E "^$project-[0-9]{8}T[0-9]{6}Z\.tar\.gz$" | sort || true; }
pre_restores() { find "$BACKUP_DIR" -maxdepth 1 -type f -name "$project-pre-restore-*.tar.gz" | sort; }

start_api
put_marker m1-first
{ spend_line 0.01; printf '\n\n'; spend_line 0.02; printf '\n'; } | spend_append

# A backup while the API runs; a blank line in the spend log is kept, as the API keeps it.
b1=$(backup)
[ -f "$b1" ] || fail "backup.sh wrote no backup ($b1)"
[ -f "$b1.sha256" ] || fail "backup.sh wrote no checksum ($b1.sha256)"
[ "$(stat -c %a "$b1")" = 600 ] || fail "the backup is not readable by its owner only"
(cd "$BACKUP_DIR" && sha256sum -c --status "$(basename "$b1").sha256") || fail "the checksum does not match"
listing=$(tar -tzf "$b1" | sort | tr '\n' ' ')
[ "$listing" = "llm-spend.jsonl sonic-agent.db " ] || fail "the backup holds: $listing"
echo "ok: backup.sh wrote $(basename "$b1") and its checksum while the API ran"

# "latest" is the newest backup of the project, not another project's or a pre-restore copy.
sleep 1
put_marker m2-second
b2=$(backup)
for decoy in "$project-2-20991231T235959Z.tar.gz" "$project-pre-restore-20991231T235959Z.tar.gz"; do
  cp "$b1" "$BACKUP_DIR/$decoy"
  printf '%s  %s\n' "$(sha256sum <"$b1" | cut -d' ' -f1)" "$decoy" >"$BACKUP_DIR/$decoy.sha256"
done
put_marker m3-after-backups
before=$(started)
out=$(restore --dry-run latest 2>&1) || fail "the dry run failed: $out"
grep -qx "restore: $b2" <<<"$out" || fail "latest was not the newest backup $b2: $out"
grep -q 'checksum ok' <<<"$out" || fail "the dry run checked no checksum: $out"
grep -q 'database: integrity ok' <<<"$out" || fail "the dry run checked no integrity: $out"
grep -q 'spend log: 2 records, USD 0.0300 counted, all valid' <<<"$out" ||
  fail "the dry run did not read the spend log with its blank line: $out"
[ "$(markers)" = "m1-first,m2-second,m3-after-backups" ] || fail "the dry run changed the database"
[ "$(started)" = "$before" ] || fail "the dry run restarted the API"
echo "ok: restore.sh --dry-run latest verified the newest of two backups and changed nothing"

# A changed byte fails the checksum.
mkdir "$work/changed"
cp "$b2" "$b2.sha256" "$work/changed/"
changed="$work/changed/$(basename "$b2")"
printf 'x' | dd of="$changed" bs=1 seek=100 conv=notrunc status=none
if out=$(restore --dry-run "$changed" 2>&1); then fail "a changed backup passed: $out"; fi
grep -q 'checksum mismatch' <<<"$out" || fail "a changed backup failed for another reason: $out"
echo "ok: a changed backup is refused (checksum)"

# A damaged database with a matching checksum fails the integrity check.
mkdir -p "$work/damaged/in"
tar -xzf "$b2" -C "$work/damaged/in"
pages=$(($(stat -c %s "$work/damaged/in/sonic-agent.db") / 4096))
head -c 4096 /dev/urandom | dd of="$work/damaged/in/sonic-agent.db" bs=4096 seek=$((pages - 1)) conv=notrunc status=none
damaged="$work/damaged/$(basename "$b2")"
tar -czf "$damaged" -C "$work/damaged/in" sonic-agent.db llm-spend.jsonl
printf '%s  %s\n' "$(sha256sum <"$damaged" | cut -d' ' -f1)" "$(basename "$damaged")" >"$damaged.sha256"
if out=$(restore --dry-run "$damaged" 2>&1); then fail "a damaged database passed: $out"; fi
grep -q 'checksum ok' <<<"$out" || fail "a damaged database failed its checksum: $out"
grep -q 'did not pass its checks' <<<"$out" || fail "a damaged database failed for another reason: $out"
echo "ok: a damaged database is refused (integrity_check)"

# A spend log caught mid-append is read again; the backup holds the whole line.
printf '%s' "$(spend_line 0.04)" | head -c 40 | spend_append
backup >"$work/b-append.out" 2>"$work/b-append.err" &
pid=$!
for _ in $(seq 1 150); do
  grep -q 'append was in progress' "$work/b-append.err" && break
  sleep 0.1
done
grep -q 'append was in progress' "$work/b-append.err" || { kill "$pid" 2>/dev/null; fail "the torn line was not noticed: $(cat "$work/b-append.err")"; }
spend_line 0.04 | tail -c +41 | spend_append
echo | spend_append
wait "$pid" || fail "the backup during an append failed: $(cat "$work/b-append.err")"
b3=$(cat "$work/b-append.out")
tar -xzOf "$b3" llm-spend.jsonl | grep -q '"usd_est":0.04,' || fail "the backup lacks the appended line"
echo "ok: a spend log caught mid-append was read again; the backup holds the whole line"

# A malformed spend line is refused: no archive, a non-zero exit.
n=$(backups | wc -l)
echo '{"ts":"not a date","usd_est":1}' | spend_append
spend_line 0.05 | spend_append && echo | spend_append
if out=$(backup 2>&1); then fail "a malformed spend log was backed up: $out"; fi
grep -q 'malformed line' <<<"$out" || fail "a malformed spend log failed for another reason: $out"
[ "$(backups | wc -l)" = "$n" ] || fail "a backup was kept for a malformed spend log"
vol_node 'const f = "/app/spend/llm-spend.jsonl"; fs.writeFileSync(f, fs.readFileSync(f, "utf8").split("\n").filter((l) => !l.includes("not a date")).join("\n"));'
echo "ok: a malformed spend log is refused, no backup kept"

# The lock: a backup or restore running holds it; one that cannot open it says so.
before=$(started)
flock "$BACKUP_DIR/.lock" sleep 60 &
holder=$!
sleep 0.5
if out=$(LOCK_TIMEOUT=1 backup 2>&1); then fail "a backup ran while the lock was held: $out"; fi
grep -q 'has held' <<<"$out" || fail "a held lock failed the backup for another reason: $out"
if out=$(LOCK_TIMEOUT=1 restore --yes latest 2>&1); then fail "a restore ran while the lock was held: $out"; fi
grep -q 'has held' <<<"$out" || fail "a held lock failed the restore for another reason: $out"
kill "$holder"
wait "$holder" 2>/dev/null || true
holder=
[ "$(started)" = "$before" ] || fail "a refused restore stopped the API"
chmod 000 "$BACKUP_DIR/.lock"
if out=$(backup 2>&1); then fail "a backup ran with an unreadable lock: $out"; fi
grep -q 'cannot open the lock' <<<"$out" || fail "an unreadable lock failed for another reason: $out"
chmod 600 "$BACKUP_DIR/.lock"
echo "ok: a held lock and an unreadable lock are refused"

# Off a terminal, a restore needs --yes; another project's backup needs --project.
if out=$(restore latest 2>&1 </dev/null); then fail "a restore ran unconfirmed: $out"; fi
grep -q 'pass --yes' <<<"$out" || fail "an unconfirmed restore failed for another reason: $out"
other="$work/other-20261001T000000Z.tar.gz"
cp "$b2" "$other"
printf '%s  %s\n' "$(sha256sum <"$other" | cut -d' ' -f1)" "$(basename "$other")" >"$other.sha256"
if out=$(restore --yes "$other" 2>&1); then fail "another project's backup was restored: $out"; fi
grep -q "pass --project $project" <<<"$out" || fail "another project's backup failed for another reason: $out"
[ "$(markers)" = "m1-first,m2-second,m3-after-backups" ] || fail "a refused restore changed the database"
if pre_restores | grep -qv 20991231; then fail "a refused restore wrote a pre-restore copy"; fi
echo "ok: no --yes off a terminal, and another project's backup without --project, are refused"

# A running container on the volumes that is not a service of the project stops the restore.
docker run -d --name "$project-intruder" --pull never --network none -v "$data:/x:ro" \
  --entrypoint sleep "$image" 300 >/dev/null
if out=$(restore --yes latest 2>&1); then fail "a restore ran beside another container: $out"; fi
grep -q "$project-intruder uses the volumes of $project but is not one of its service containers" <<<"$out" ||
  fail "the other container failed it for another reason: $out"
[ "$(started)" = "$before" ] || fail "a refused restore stopped the API"
docker rm -f "$project-intruder" >/dev/null
echo "ok: a container that is not a service of the project stops the restore, nothing changed"

# A newer, exited one-off container of the service is never taken for the API.
docker run --name "$project-oneoff" --pull never --network none \
  --label "com.docker.compose.project=$project" --label com.docker.compose.service=api \
  --label com.docker.compose.oneoff=True -v "$data:/app/data" --entrypoint true "$image"
out=$(restore --yes --project "$project" "$other" 2>&1) || fail "the restore failed: $out"
grep -q "stopping $container" <<<"$out" || fail "the API was not stopped: $out"
grep -q "$container is healthy" <<<"$out" || fail "the API did not turn healthy again: $out"
[ "$(markers)" = "m1-first,m2-second" ] || fail "restored markers: $(markers)"
[ "$(docker inspect -f '{{.State.Status}}' "$project-oneoff")" = exited ] || fail "the one-off was started"
docker rm -f "$project-oneoff" >/dev/null
echo "ok: --project restored another project's backup, stopping and starting the API, not the one-off"

# With no API running and a -wal left by a crash, the volumes are still copied first, -wal
# included, and that copy can be restored by its path.
put_marker m4-in-wal
docker kill "$container" >/dev/null
docker wait "$container" >/dev/null
vol_node 'process.exit(fs.statSync("/app/data/sonic-agent.db-wal").size > 0 ? 0 : 1)' ||
  fail "the crash left no -wal"
n=$(pre_restores | wc -l)
out=$(restore --yes latest 2>&1) || fail "the restore with no API running failed: $out"
grep -q 'none started' <<<"$out" || fail "the restore started a container: $out"
[ "$(pre_restores | wc -l)" = $((n + 1)) ] || fail "no pre-restore copy with no API running: $out"
copy=$(pre_restores | grep -v 20991231 | tail -1)
tar -tzf "$copy" | grep -qx sonic-agent.db-wal || fail "the pre-restore copy has no -wal"
out=$(restore --dry-run "$copy" 2>&1) || fail "the pre-restore copy does not verify: $out"
docker run --rm -i --pull never --network none --entrypoint sh "$image" -c \
  'mkdir /tmp/in && tar -xzf - -C /tmp/in && node -e "const D = require(\"node:module\").createRequire(\"/app/apps/api/package.json\")(\"better-sqlite3\"); const db = new D(\"/tmp/in/sonic-agent.db\"); process.exit(db.prepare(\"SELECT count(*) AS n FROM store_items WHERE key = ?\").get(\"m4-in-wal\").n === 1 ? 0 : 1)"' \
  <"$copy" || fail "the pre-restore copy lost the row in the -wal"
docker start "$container" >/dev/null
wait_healthy
[ "$(markers)" = "m1-first,m2-second,m3-after-backups" ] || fail "markers after the restore with no API: $(markers)"
echo "ok: with no API running, the volumes (and the -wal) were copied first; the copy restores"

# A damaged database (its first page overwritten) with a -wal of another database beside it that
# cannot be checkpointed into it: the -wal is not applied to the restored database.
docker stop "$container" >/dev/null
# shellcheck disable=SC2016 # a JavaScript template string
vol_node '
  const other = new D("/app/data/other.db");
  other.pragma("journal_mode = WAL");
  other.pragma("wal_autocheckpoint = 0");
  other.exec("CREATE TABLE other (x); INSERT INTO other VALUES (1)");
  other.pragma("wal_checkpoint(TRUNCATE)");
  other.exec("INSERT INTO other VALUES (2)");
  fs.copyFileSync("/app/data/other.db-wal", "/app/data/sonic-agent.db-wal");
  for (const f of ["other.db", "other.db-wal", "other.db-shm"]) fs.rmSync(`/app/data/${f}`, { force: true });
  const fd = fs.openSync("/app/data/sonic-agent.db", "r+");
  fs.writeSync(fd, Buffer.alloc(4096, 0x5a), 0, 4096, 0);
  fs.closeSync(fd);
  process.exit(0);'
out=$(restore --yes latest 2>&1) || fail "the restore over a damaged database failed: $out"
grep -q 'old database could not be checkpointed' <<<"$out" || fail "the old database was readable: $out"
docker start "$container" >/dev/null
wait_healthy
[ "$(markers)" = "m1-first,m2-second,m3-after-backups" ] || fail "markers after the restore over a damaged database: $(markers)"
echo "ok: a -wal left beside a damaged database is not applied to the restored one"

# A database that fails integrity_check on the volume is not backed up.
docker stop "$container" >/dev/null
vol_node '
  const f = "/app/data/sonic-agent.db";
  const buf = fs.readFileSync(f);
  let off = -1;
  let hit = false;
  while ((off = buf.indexOf("m2-second", off + 1)) !== -1) {
    const page = Math.floor(off / 4096);
    if (buf[page * 4096 + (page === 0 ? 100 : 0)] === 0x0a) { buf[off] = 0x7a; hit = true; }
  }
  fs.writeFileSync(f, buf);
  process.exit(hit ? 0 : 1);' || fail "no index page to damage"
n=$(backups | wc -l)
if out=$(backup 2>&1); then fail "a database that fails integrity_check was backed up: $out"; fi
grep -q 'integrity_check' <<<"$out" || fail "the damaged database failed for another reason: $out"
[ "$(backups | wc -l)" = "$n" ] || fail "a backup of a damaged database was kept"
echo "ok: a database that fails integrity_check is not backed up, no archive kept"

# Fresh volumes: a new, empty database and no spend log; the restore brings both back.
docker rm -f "$container" >/dev/null
docker volume rm "$data" "$spend" >/dev/null
start_api
[ -z "$(markers)" ] || fail "the fresh database holds markers: $(markers)"
[ "$(spend_records)" = none ] || fail "the fresh spend volume holds a spend log"
out=$(restore --yes "$b2" 2>&1) || fail "the restore into fresh volumes failed: $out"
grep -q "$container is healthy" <<<"$out" || fail "the restore did not wait for a healthy API: $out"
[ "$(markers)" = "m1-first,m2-second" ] || fail "restored markers: $(markers)"
[ "$(spend_records)" = 2 ] || fail "restored spend log records: $(spend_records)"
echo "ok: restore.sh --yes into fresh volumes brought back the database and the spend log"

# Spend logs are merged: a log on the volume that lacks the backup's records gets them, and keeps
# its own.
vol_node 'fs.writeFileSync("/app/spend/llm-spend.jsonl", process.argv[1] + "\n");' "$(spend_line 0.5)"
out=$(restore --yes "$b2" 2>&1) || fail "the merging restore failed: $out"
grep -q 'spend log: merged, 2 records' <<<"$out" || fail "the spend logs were not merged: $out"
[ "$(spend_records)" = 3 ] || fail "spend records after the merge: $(spend_records)"
out=$(restore --yes "$b2" 2>&1) || fail "the second restore failed: $out"
grep -q 'holds every record' <<<"$out" || fail "a second restore changed the spend log: $out"
[ "$(spend_records)" = 3 ] || fail "spend records after the second restore: $(spend_records)"
echo "ok: the spend logs were merged, never shortened"

# KEEP removes the oldest backups of the project only.
sleep 1
KEEP=2 backup >/dev/null
mapfile -t left < <(backups)
if [ "${#left[@]}" != 2 ] || [ "${left[0]}" != "$(basename "$b3")" ]; then
  fail "KEEP=2 left: ${left[*]} (expected $(basename "$b3") and the new one)"
fi
for old in "$b1" "$b1.sha256" "$b2" "$b2.sha256"; do
  [ ! -e "$old" ] || fail "KEEP=2 kept $(basename "$old")"
done
for decoy in "$project-2-20991231T235959Z.tar.gz" "$project-pre-restore-20991231T235959Z.tar.gz"; do
  [ -e "$BACKUP_DIR/$decoy" ] || fail "KEEP=2 removed $decoy"
done
[ "$(pre_restores | wc -l)" -ge 5 ] || fail "KEEP=2 removed pre-restore copies"
echo "ok: KEEP=2 left the two newest backups, and no other project's file or pre-restore copy"

# Every container the scripts ran: no network, no capabilities, no new privileges, read-only.
runs=$(wc -l <"$work/docker-runs.log")
[ "$runs" -ge 20 ] || fail "only $runs docker runs were logged"
while IFS= read -r line; do
  for flag in '--network none' '--read-only' '--cap-drop ALL' '--security-opt no-new-privileges'; do
    grep -qF -- "$flag" <<<"$line" || fail "a docker run without $flag: $line"
  done
done <"$work/docker-runs.log"
echo "ok: all $runs containers the scripts ran had no network, no capabilities and a read-only image"

echo "all backup and restore checks passed"
