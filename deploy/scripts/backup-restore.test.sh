#!/usr/bin/env bash
# Checks deploy/scripts/backup.sh and restore.sh against a throwaway project: an API container
# from the API image (no network, recorded runs only) on volumes of its own, removed at the end
# with everything else this test created. CI runs it after building the images
# (.github/workflows/docker.yml).
#
#   deploy/scripts/backup-restore.test.sh     API_IMAGE: the image (default liner-notes-api:latest)
#
# Backups: written with their checksum while the API runs, in the API container's image when
# API_IMAGE is unset (a missing image is refused); "latest" is the newest of two, never a
# pre-restore copy or another project's file; a spend log with a blank line is kept, one caught
# mid-append is read again; one with a line cut by a crash or a malformed line leaves the
# database backed up and the log aside, with exit 3, and spend-log.sh repair-tail (refused while
# the API runs) moves a cut last line aside as the API does; a database that fails
# integrity_check is refused with no archive kept; KEEP removes the oldest only. Restores: a dry
# run verifies and changes nothing; a changed byte, a checksum written for another file, a
# damaged archive, a missing --yes off a terminal, another project's backup without --project, a
# held or unreadable lock, and a container that is not a service of the project (a one-off
# included) are refused with nothing changed; a restore that fails after stopping the API, or
# gets SIGTERM, starts it again with the data unchanged; a ^C to the job during the swap lets the
# swap finish, then starts the API (exit 130); a one-off container is never taken for the API;
# the volumes are copied first, -wal included, also with no API running; a -wal left beside a
# damaged or lost database is not applied to the restored one; spend logs are merged; a backup
# with no valid spend log is refused before any stop into a volume with none, until
# spend-log.sh place puts the backup's log there. Two backups, or two restores, in one second
# each read the volumes and write an archive of their own, never over the first; a clock that
# does not move fails the backup, and fails the restore with the API started again.
# Every container the scripts start has no network, no capabilities and a read-only image
# filesystem.
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
  docker rm -f "$container" "$project-oneoff" "$project-intruder" "$project-runner" >/dev/null 2>&1 || true
  docker volume rm -f "$data" "$spend" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# The scripts run with a docker that logs the session and the arguments of every `docker run`.
mkdir "$work/bin"
# shellcheck disable=SC2016 # the shim's own variables
printf '#!/bin/sh\n[ "$1" = run ] && printf "session %%s %%s\\n" "$(ps -o sid= -p $$ | tr -d " ")" "$*" >>"%s"\nexec %s "$@"\n' \
  "$work/docker-runs.log" "$(command -v docker)" >"$work/bin/docker"
chmod +x "$work/bin/docker"
# ... and a date that, while $work/same-second holds "<stamp> <n>", gives <stamp> to the next n
# calls for a file's time, then the real time: two runs start in one second, however long each
# takes.
real_date=$(command -v date)
cat >"$work/bin/date" <<SH
#!/bin/sh
f="$work/same-second"
if [ "\$*" = "-u +%Y%m%dT%H%M%SZ" ] && [ -s "\$f" ]; then
  read -r stamp n <"\$f"
  if [ "\$n" -gt 0 ]; then
    echo "\$stamp \$((n - 1))" >"\$f"
    echo "\$stamp"
    exit 0
  fi
fi
exec $real_date "\$@"
SH
chmod +x "$work/bin/date"
backup() { PATH="$work/bin:$PATH" "$here/backup.sh"; }
restore() { PATH="$work/bin:$PATH" "$here/restore.sh" "$@"; }
spend_log() { PATH="$work/bin:$PATH" "$here/spend-log.sh" "$@"; }

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
health() { docker inspect -f '{{.State.Health.Status}}' "$container"; }

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

# The markers in the database of an archive: archive_markers <file>.
archive_markers_js='
  const D = require("node:module").createRequire("/app/apps/api/package.json")("better-sqlite3");
  const db = new D("/tmp/in/sonic-agent.db");
  const rows = db.prepare("SELECT key FROM store_items WHERE namespace = ? ORDER BY key").all("[\"backup-test\"]");
  console.log(rows.map((row) => row.key).join(","));'
archive_markers() {
  # shellcheck disable=SC2016 # expanded in the container
  docker run --rm -i --pull never --network none -e "JS=$archive_markers_js" --entrypoint sh "$image" -c \
    'mkdir /tmp/in && tar -xzf - -C /tmp/in && node -e "$JS"' <"$1"
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
runs=$(wc -l <"$work/docker-runs.log")
b2=$(
  unset API_IMAGE
  backup
)
api_id=$(docker inspect -f '{{.Image}}' "$container")
new_runs=$(tail -n +$((runs + 1)) "$work/docker-runs.log")
if [ -z "$new_runs" ] || grep -vF " $api_id " <<<"$new_runs" >/dev/null; then
  fail "with API_IMAGE unset, the backup did not run in the API container's image $api_id"
fi
if out=$(API_IMAGE=$project-missing:none backup 2>&1); then fail "a missing image was used: $out"; fi
grep -q "no image $project-missing:none on this host" <<<"$out" || fail "a missing image failed for another reason: $out"
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
renamed="$work/changed/$project-20260101T000000Z.tar.gz"
cp "$b2" "$renamed"
cp "$b2.sha256" "$renamed.sha256"
if out=$(restore --dry-run "$renamed" 2>&1); then fail "a checksum written for another file passed: $out"; fi
grep -q "is the checksum of \"$(basename "$b2")\"" <<<"$out" || fail "the renamed backup failed for another reason: $out"
echo "ok: a changed backup, and a checksum written for another file, are refused"

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
for _ in $(seq 1 600); do
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

# A last spend line cut by a crash (never finished): the database is backed up, the log kept
# aside under a name no restore applies, exit 3, nothing pruned. repair-tail is refused while the
# API runs; with it stopped, it moves the line to llm-spend.jsonl.torn as the API does.
n=$(backups | wc -l)
printf '%s' "$(spend_line 0.06)" | head -c 40 | spend_append
code=0
out=$(backup 2>&1) || code=$?
[ "$code" = 3 ] || fail "a cut last spend line gave exit $code: $out"
grep -q "FAILED for the spend log" <<<"$out" || fail "a cut last spend line failed for another reason: $out"
grep -q "the last one, cut short" <<<"$out" || fail "the cut last spend line was not named: $out"
[ "$(backups | wc -l)" = $((n + 1)) ] || fail "the database was not backed up beside a cut spend line"
bt="$BACKUP_DIR/$(backups | tail -1)"
[ "$(tar -tzf "$bt" | sort | tr '\n' ' ')" = "llm-spend.jsonl.invalid sonic-agent.db " ] ||
  fail "the backup beside a cut spend line holds: $(tar -tzf "$bt" | tr '\n' ' ')"
out=$(restore --dry-run "$bt" 2>&1) || fail "the backup beside a cut spend line does not verify: $out"
grep -q 'not in this backup (one that broke' <<<"$out" || fail "the dry run did not flag the log: $out"
if out=$(spend_log repair-tail 2>&1); then fail "repair-tail ran beside the API: $out"; fi
grep -q "$container uses $spend: stop it first" <<<"$out" || fail "repair-tail failed for another reason: $out"
docker stop "$container" >/dev/null
out=$(spend_log repair-tail 2>&1) || fail "repair-tail failed: $out"
grep -q 'moved the last line (40 bytes)' <<<"$out" || fail "repair-tail moved nothing: $out"
vol_node '
  const torn = fs.readFileSync("/app/spend/llm-spend.jsonl.torn", "utf8").split("\n");
  const log = fs.readFileSync("/app/spend/llm-spend.jsonl", "utf8");
  const head = /^# \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z last line \(40 bytes\) moved from the spend log by hand$/;
  process.exit(head.test(torn[0]) && torn[1] === process.argv[1] && torn.length === 3 && log.endsWith("}\n") ? 0 : 1);' \
  "$(spend_line 0.06 | head -c 40)" || fail "repair-tail did not move the line as the API does"
docker start "$container" >/dev/null
wait_healthy
echo "ok: a cut last spend line: database backed up, log kept aside, exit 3; repair-tail fixed it"

# A malformed line further up: the same. A restore over it fails after stopping the API, which
# is started again with the data unchanged.
echo '{"ts":"not a date","usd_est":1}' | spend_append
spend_line 0.05 | spend_append && echo | spend_append
code=0
out=$(backup 2>&1) || code=$?
[ "$code" = 3 ] || fail "a malformed spend line gave exit $code: $out"
grep -Eq 'spend log: INVALID: line [0-9]+ \(ts is not a date\) breaks' <<<"$out" || fail "a malformed spend line failed for another reason: $out"
before=$(started)
lines=$(spend_records)
if out=$(restore --yes "$b3" 2>&1); then fail "a restore over a malformed spend log passed: $out"; fi
grep -Eq 'the spend log on the volume has a malformed line [0-9]+ \(ts is not a date\)' <<<"$out" || fail "the restore failed for another reason: $out"
grep -q "$container is healthy" <<<"$out" || fail "the failed restore did not start the API again: $out"
if [ "$(started)" = "$before" ] || [ "$(health)" != healthy ]; then
  fail "the API is not running again after a failed restore"
fi
[ "$(markers)" = "m1-first,m2-second,m3-after-backups" ] || fail "a failed restore changed the database: $(markers)"
[ "$(spend_records)" = "$lines" ] || fail "a failed restore changed the spend log"
vol_node 'const f = "/app/spend/llm-spend.jsonl"; fs.writeFileSync(f, fs.readFileSync(f, "utf8").split("\n").filter((l) => !l.includes("not a date")).join("\n"));'
sleep 1
b4=$(backup)
out=$(spend_log total 2>&1) || fail "spend-log.sh total failed: $out"
grep -qx 'spend log: 4 records, USD 0.1200 counted' <<<"$out" || fail "spend-log.sh total printed: $out"
echo "ok: a malformed spend line: exit 3; a restore failing after the stop started the API again, nothing changed"

# SIGTERM once the API is stopped: the restore ends (130) and starts the API again.
put_marker m5-signal
PATH="$work/bin:$PATH" "$here/restore.sh" --yes "$b4" 2>"$work/signal.err" &
pid=$!
for _ in $(seq 1 600); do
  grep -q "stopping $container" "$work/signal.err" && break
  sleep 0.1
done
kill -TERM "$pid"
code=0
wait "$pid" || code=$?
[ "$code" = 130 ] || fail "the restore that got SIGTERM gave exit $code: $(cat "$work/signal.err")"
grep -q "$container is healthy" "$work/signal.err" || fail "SIGTERM left the API stopped: $(cat "$work/signal.err")"
[ "$(health)" = healthy ] || fail "the API is not running after SIGTERM"
[ "$(markers)" = "m1-first,m2-second,m3-after-backups,m5-signal" ] || fail "SIGTERM changed the database: $(markers)"
sql "DELETE FROM store_items WHERE key = 'm5-signal'"
echo "ok: SIGTERM during a restore started the API again, nothing changed"

# A terminal's ^C (SIGINT to the job's process group) during the swap: the swap finishes, its
# output is shown, the API starts, exit 130.
put_marker m6-before-swap
swap_log="$BACKUP_DIR/.$project-restore-swap.log"
# A job started in the background of a shell without job control inherits SIGINT as ignored, and
# bash cannot trap a signal ignored on entry; a terminal's job gets SIGINT at its default, so this
# one does too.
set -m
PATH="$work/bin:$PATH" env --default-signal=INT "$here/restore.sh" --yes "$b4" 2>"$work/sigint.err" &
pid=$!
set +m
for _ in $(seq 1 1200); do
  grep -q 'database: integrity ok' "$swap_log" 2>/dev/null && break
  sleep 0.05
done
grep -q 'database: integrity ok' "$swap_log" 2>/dev/null || fail "the swap was not seen running: $(cat "$work/sigint.err")"
kill -INT -- -"$pid"
code=0
wait "$pid" || code=$?
[ "$code" = 130 ] || fail "the restore that got ^C during the swap gave exit $code: $(cat "$work/sigint.err")"
grep -q 'database: restored to' "$work/sigint.err" || fail "^C cut the swap short: $(cat "$work/sigint.err")"
wait_healthy
[ "$(markers)" = "m1-first,m2-second,m3-after-backups" ] || fail "markers after ^C during the swap: $(markers)"
swap_session=$(grep -F -- "--name $project-restore-swap " "$work/docker-runs.log" | tail -1 | cut -d' ' -f2)
if [ -z "$swap_session" ] || [ "$swap_session" = "$(ps -o sid= -p $$ | tr -d ' ')" ]; then
  fail "the swap did not run in a session of its own (session ${swap_session:-none})"
fi
echo "ok: ^C during the swap let it finish in its own session, showed its output and started the API (exit 130)"

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
# (root opens any file: the check needs another user)
if [ "$(id -u)" != 0 ]; then
  chmod 000 "$BACKUP_DIR/.lock"
  if out=$(backup 2>&1); then fail "a backup ran with an unreadable lock: $out"; fi
  grep -q 'cannot open the lock' <<<"$out" || fail "an unreadable lock failed for another reason: $out"
  chmod 600 "$BACKUP_DIR/.lock"
fi
echo "ok: a held lock and an unreadable lock are refused"

# Off a terminal, a restore needs --yes; another project's backup needs --project.
n=$(pre_restores | wc -l)
if out=$(restore latest 2>&1 </dev/null); then fail "a restore ran unconfirmed: $out"; fi
grep -q 'pass --yes' <<<"$out" || fail "an unconfirmed restore failed for another reason: $out"
other="$work/other-20261001T000000Z.tar.gz"
cp "$b2" "$other"
printf '%s  %s\n' "$(sha256sum <"$other" | cut -d' ' -f1)" "$(basename "$other")" >"$other.sha256"
if out=$(restore --yes "$other" 2>&1); then fail "another project's backup was restored: $out"; fi
grep -q "pass --project $project" <<<"$out" || fail "another project's backup failed for another reason: $out"
[ "$(markers)" = "m1-first,m2-second,m3-after-backups" ] || fail "a refused restore changed the database"
[ "$(pre_restores | wc -l)" = "$n" ] || fail "a refused restore wrote a pre-restore copy"
echo "ok: no --yes off a terminal, and another project's backup without --project, are refused"

# A running container on the volumes that is not a service of the project stops the restore: one
# of another project, and a running one-off of this project (`compose run api ...`).
docker run -d --name "$project-intruder" --pull never --network none -v "$data:/x:ro" \
  --entrypoint sleep "$image" 300 >/dev/null
if out=$(restore --yes latest 2>&1); then fail "a restore ran beside another container: $out"; fi
grep -q "$project-intruder uses the volumes of $project but is not one of its service containers" <<<"$out" ||
  fail "the other container failed it for another reason: $out"
docker rm -f "$project-intruder" >/dev/null
docker run -d --name "$project-runner" --pull never --network none \
  --label "com.docker.compose.project=$project" --label com.docker.compose.service=api \
  --label com.docker.compose.oneoff=True -v "$data:/x:ro" --entrypoint sleep "$image" 300 >/dev/null
if out=$(restore --yes latest 2>&1); then fail "a restore ran beside a running one-off: $out"; fi
grep -q "$project-runner uses the volumes of $project but is not one of its service containers" <<<"$out" ||
  fail "the running one-off failed it for another reason: $out"
docker rm -f "$project-runner" >/dev/null
[ "$(started)" = "$before" ] || fail "a refused restore stopped the API"
[ "$(pre_restores | wc -l)" = "$n" ] || fail "a refused restore wrote a pre-restore copy"
echo "ok: a container that is not a service of the project, a running one-off included, stops the restore"

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

# A -wal of another database (only its second page) left beside the database: it must never be
# applied to the restored one. foreign_wal writes it; the old database is then either damaged
# (its first page overwritten: the checkpoint before the swap fails) or gone (lost, or moved
# aside: there is nothing to checkpoint, so only the removal before the swap keeps the -wal out).
# shellcheck disable=SC2016 # JavaScript template strings
foreign_wal='
  const other = new D("/app/data/other.db");
  other.pragma("journal_mode = WAL");
  other.pragma("wal_autocheckpoint = 0");
  other.exec("CREATE TABLE other (x); INSERT INTO other VALUES (1)");
  other.pragma("wal_checkpoint(TRUNCATE)");
  other.exec("INSERT INTO other VALUES (2)");
  fs.copyFileSync("/app/data/other.db-wal", "/app/data/sonic-agent.db-wal");
  for (const f of ["other.db", "other.db-wal", "other.db-shm"]) fs.rmSync(`/app/data/${f}`, { force: true });'
docker stop "$container" >/dev/null
vol_node "$foreign_wal"'
  const fd = fs.openSync("/app/data/sonic-agent.db", "r+");
  fs.writeSync(fd, Buffer.alloc(4096, 0x5a), 0, 4096, 0);
  fs.closeSync(fd);
  process.exit(0);'
out=$(restore --yes latest 2>&1) || fail "the restore over a damaged database failed: $out"
grep -q 'old database could not be checkpointed' <<<"$out" || fail "the old database was readable: $out"
docker start "$container" >/dev/null
wait_healthy
[ "$(markers)" = "m1-first,m2-second,m3-after-backups" ] || fail "markers after the restore over a damaged database: $(markers)"
docker stop "$container" >/dev/null
vol_node "$foreign_wal"'
  fs.rmSync("/app/data/sonic-agent.db");
  process.exit(0);'
out=$(restore --yes latest 2>&1) || fail "the restore over a lost database failed: $out"
copy=$(pre_restores | grep -v 20991231 | tail -1)
[ "$(tar -tzf "$copy" | sort | tr '\n' ' ')" = "llm-spend.jsonl sonic-agent.db-wal " ] ||
  fail "the pre-restore copy of a lost database holds: $(tar -tzf "$copy" | tr '\n' ' ')"
docker start "$container" >/dev/null
wait_healthy
[ "$(markers)" = "m1-first,m2-second,m3-after-backups" ] || fail "markers after the restore over a lost database: $(markers)"
echo "ok: a -wal left beside a damaged or a lost database is copied first and never applied to the restored one"

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

# A backup with no valid spend log (exit 3), into a volume with none: refused before any stop,
# naming the recovery; spend-log.sh place puts the backup's log there (its cut line moved aside).
docker stop "$container" >/dev/null
vol_node 'fs.rmSync("/app/spend/llm-spend.jsonl")'
docker start "$container" >/dev/null
wait_healthy
before=$(started)
n=$(pre_restores | wc -l)
if out=$(restore --yes "$bt" 2>&1); then fail "a backup with no valid spend log was restored into a volume with none: $out"; fi
if ! grep -q 'holds no valid spend log' <<<"$out" || ! grep -q 'spend-log.sh place llm-spend.jsonl.invalid' <<<"$out"; then
  fail "the restore with no spend log failed for another reason: $out"
fi
[ "$(started)" = "$before" ] || fail "the refused restore stopped the API"
[ "$(pre_restores | wc -l)" = "$n" ] || fail "the refused restore wrote a pre-restore copy"
(cd "$work" && tar -xzf "$bt" llm-spend.jsonl.invalid)
if out=$(spend_log place "$work/llm-spend.jsonl.invalid" 2>&1); then fail "place ran beside the API: $out"; fi
docker stop "$container" >/dev/null
out=$(spend_log place "$work/llm-spend.jsonl.invalid" 2>&1) || fail "place failed: $out"
if ! grep -q 'moved the last line (40 bytes)' <<<"$out" || ! grep -q 'placed at /app/spend/llm-spend.jsonl, 3 records' <<<"$out"; then
  fail "place printed: $out"
fi
if out=$(spend_log place "$work/llm-spend.jsonl.invalid" 2>&1); then fail "place wrote over a spend log: $out"; fi
docker start "$container" >/dev/null
wait_healthy
out=$(restore --yes "$bt" 2>&1) || fail "the restore after place failed: $out"
[ "$(spend_records)" = 3 ] || fail "spend records after place and the restore: $(spend_records)"
echo "ok: a backup with no valid spend log is refused into a volume with none; place recovers it"

# KEEP removes the oldest backups of the project only.
sleep 1
KEEP=2 backup >/dev/null
mapfile -t left < <(backups)
if [ "${#left[@]}" != 2 ] || [ "${left[0]}" != "$(basename "$b4")" ]; then
  fail "KEEP=2 left: ${left[*]} (expected $(basename "$b4") and the new one)"
fi
for old in "$b1" "$b1.sha256" "$b2" "$b2.sha256" "$b3" "$bt"; do
  [ ! -e "$old" ] || fail "KEEP=2 kept $(basename "$old")"
done
for decoy in "$project-2-20991231T235959Z.tar.gz" "$project-pre-restore-20991231T235959Z.tar.gz"; do
  [ -e "$BACKUP_DIR/$decoy" ] || fail "KEEP=2 removed $decoy"
done
[ "$(pre_restores | wc -l)" -ge 5 ] || fail "KEEP=2 removed pre-restore copies"
echo "ok: KEEP=2 left the two newest backups, and no other project's file or pre-restore copy"

# Two restores in one second (the clock held there for the copies' names): the second copies the
# volumes as they are then, under a name of its own, and leaves the first copy as it was.
n=$(pre_restores | wc -l)
stamp=$("$real_date" -u +%Y%m%dT%H%M%SZ)
echo "$stamp 2" >"$work/same-second"
out=$(restore --yes "$b4" 2>&1) || fail "the first restore in one second failed: $out"
p1="$BACKUP_DIR/$project-pre-restore-$stamp.tar.gz"
grep -qx "restore: the volumes as they were are in $p1" <<<"$out" || fail "the first restore in one second did not copy to $p1: $out"
sum1=$(sha256sum <"$p1")
put_marker m7-between-restores
out=$(restore --yes "$b4" 2>&1) || fail "the second restore in one second failed: $out"
[ "$(cut -d' ' -f2 "$work/same-second")" = 0 ] || fail "the second restore did not start in the first one's second"
p2=$(sed -n 's/^restore: the volumes as they were are in //p' <<<"$out")
if [ -z "$p2" ] || [ "$p2" = "$p1" ] || [ ! -f "$p2" ]; then
  fail "the second restore in one second wrote no pre-restore copy of its own (${p2:-none}): $out"
fi
[ "$(pre_restores | wc -l)" = $((n + 2)) ] || fail "two restores in one second left $(($(pre_restores | wc -l) - n)) new pre-restore copies"
[ "$(sha256sum <"$p1")" = "$sum1" ] || fail "the second restore in one second wrote over the first one's copy"
(cd "$BACKUP_DIR" && sha256sum -c --status "$(basename "$p1").sha256") || fail "the first pre-restore copy's checksum no longer matches"
[ "$(archive_markers "$p1")" = "m1-first,m2-second,m3-after-backups" ] || fail "the first pre-restore copy holds: $(archive_markers "$p1")"
[ "$(archive_markers "$p2")" = "m1-first,m2-second,m3-after-backups,m7-between-restores" ] ||
  fail "the second pre-restore copy holds: $(archive_markers "$p2")"
[ "$(markers)" = "m1-first,m2-second,m3-after-backups" ] || fail "markers after two restores in one second: $(markers)"
echo "ok: two restores in one second wrote two pre-restore copies, each of the volumes as they were"

# A clock that does not move, on the name of a pre-restore copy that exists (a file of its own):
# the restore fails within 10 s of stopping the API, writes no copy, changes nothing and starts
# the API again.
stuck=20000101T000000Z
: >"$BACKUP_DIR/$project-pre-restore-$stuck.tar.gz"
n=$(pre_restores | wc -l)
before=$(started)
lines=$(spend_records)
echo "$stuck 1000" >"$work/same-second"
t0=$SECONDS
if out=$(restore --yes "$b4" 2>&1); then fail "a restore ran on a clock that did not move: $out"; fi
took=$((SECONDS - t0))
grep -q "clock has not moved on from $stuck in 10 s; nothing changed" <<<"$out" ||
  fail "a clock that did not move failed the restore for another reason: $out"
grep -q "stopping $container" <<<"$out" || fail "the restore on a clock that did not move stopped no API: $out"
grep -q "$container is healthy" <<<"$out" || fail "the restore on a clock that did not move did not start the API again: $out"
[ "$took" -le 60 ] || fail "the restore on a clock that did not move took $took s"
if [ "$(started)" = "$before" ] || [ "$(health)" != healthy ]; then
  fail "the API is not running again after a restore on a clock that did not move"
fi
[ "$(pre_restores | wc -l)" = "$n" ] || fail "a restore on a clock that did not move wrote a pre-restore copy"
if find "$BACKUP_DIR" -maxdepth 1 -name '*.partial*' | grep -q .; then fail "a restore on a clock that did not move left a partial copy"; fi
[ "$(markers)" = "m1-first,m2-second,m3-after-backups" ] || fail "a restore on a clock that did not move changed the database: $(markers)"
[ "$(spend_records)" = "$lines" ] || fail "a restore on a clock that did not move changed the spend log"
rm "$work/same-second" "$BACKUP_DIR/$project-pre-restore-$stuck.tar.gz"
echo "ok: a restore on a clock that does not move fails in $took s, changes nothing and starts the API again"

# Two backups in one second: the second reads the volumes again (a marker and a cut spend line
# added since the first), writes an archive of its own and exits 3 for its own spend log.
stamp=$("$real_date" -u +%Y%m%dT%H%M%SZ)
echo "$stamp 2" >"$work/same-second"
s1=$(backup 2>"$work/s1.err") || fail "the first backup in one second failed: $(cat "$work/s1.err")"
[ "$s1" = "$BACKUP_DIR/$project-$stamp.tar.gz" ] || fail "the first backup in one second is $s1, not of $stamp"
sum1=$(sha256sum <"$s1")
put_marker m8-between-backups
printf '%s' "$(spend_line 0.08)" | head -c 40 | spend_append
code=0
s2=$(backup 2>"$work/s2.err") || code=$?
[ "$(cut -d' ' -f2 "$work/same-second")" = 0 ] || fail "the second backup did not start in the first one's second"
[ "$code" = 3 ] || fail "the second backup in one second, over a cut spend line, gave exit $code: $s2 $(cat "$work/s2.err")"
if [ "$s2" = "$s1" ] || [ ! -f "$s2" ] || [ ! -f "$s2.sha256" ]; then
  fail "the second backup in one second wrote no archive of its own: $s2"
fi
[ "$(tar -tzf "$s2" | sort | tr '\n' ' ')" = "llm-spend.jsonl.invalid sonic-agent.db " ] ||
  fail "the second backup in one second holds: $(tar -tzf "$s2" | tr '\n' ' ')"
[ "$(archive_markers "$s2")" = "m1-first,m2-second,m3-after-backups,m8-between-backups" ] ||
  fail "the second backup in one second holds the markers: $(archive_markers "$s2")"
[ "$(sha256sum <"$s1")" = "$sum1" ] || fail "the second backup in one second changed the first one's archive"
echo "ok: two backups in one second wrote two archives; the second read the volumes again and gave exit 3"

# A clock that does not move, on the name of a backup that exists (a file of its own): the
# backup fails within 10 s with no archive written.
stuck=20000101T000000Z
: >"$BACKUP_DIR/$project-$stuck.tar.gz"
n=$(backups | wc -l)
echo "$stuck 1000" >"$work/same-second"
if out=$(backup 2>&1); then fail "a backup ran on a clock that did not move: $out"; fi
grep -q "clock has not moved on from $stuck in 10 s; no backup was written" <<<"$out" ||
  fail "a clock that did not move failed the backup for another reason: $out"
[ "$(backups | wc -l)" = "$n" ] || fail "a backup on a clock that did not move left an archive"
rm "$work/same-second" "$BACKUP_DIR/$project-$stuck.tar.gz"
echo "ok: a backup on a clock that does not move fails within 10 s and writes nothing"

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
