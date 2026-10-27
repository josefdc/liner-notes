#!/usr/bin/env bash
# Checks a running stack of deploy/compose.prod.yml through Caddy, on this machine and with no
# Cloudflare network (CI runs it too: .github/workflows/docker.yml).
#
#   deploy/check-stack.sh              the production stack: every service healthy, no port but
#                                      Caddy's, the API refusing a stream without a run token,
#                                      the security headers and cache rules, /api/* only going to
#                                      the API, forged client addresses ignored and Cloudflare's
#                                      used from a trusted peer, the site's origin accepted from a
#                                      browser that sends no Sec-Fetch-Site and another refused,
#                                      the typed text and the run token kept out of Caddy's logs,
#                                      over HTTP and over HTTPS with its redirect
#   deploy/check-stack.sh long-stream  the development stack (deploy/compose.dev.yml, whose API
#                                      issues run tokens without Turnstile and holds replayed
#                                      streams for SSE_HOLD_MS=130000): a stream the visitor
#                                      leaves leaves no token, query or full address in any of
#                                      Caddy's log lines, and a stream held 130 s passes through
#                                      Caddy and ends with "done"
#
# COMPOSE is the compose command of the stack, default "docker compose -f deploy/compose.prod.yml"
# (long-stream: with "-f deploy/compose.dev.yml" added). The API must have LOG_IP_SALT set, so
# the address hashes in its log can be checked, and CORS_ORIGINS must list the site's local
# origin (http://<the published address>). The address and HTTPS checks start a second Caddy
# from the web image for a few seconds (no published port); the running services are not
# restarted.
set -euo pipefail

mode=${1:-production}
default_compose="docker compose -f deploy/compose.prod.yml"
[ "$mode" = long-stream ] && default_compose="$default_compose -f deploy/compose.dev.yml"
read -r -a compose <<<"${COMPOSE:-$default_compose}"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# Where Caddy's port 80 is published.
published=$("${compose[@]}" port web 80 || true)
[ -n "$published" ] && [ "${published##*:}" != 0 ] || fail "web publishes no port (is the stack up?)"
base="http://$published"

# The response headers of a GET, lower-cased names.
headers() {
  local line name
  curl -sS -D - -o /dev/null "$@" | tr -d '\r' | while IFS= read -r line; do
    name=${line%%:*}
    if [ "$name" = "$line" ]; then
      printf '%s\n' "$line"
    else
      printf '%s:%s\n' "$(tr '[:upper:]' '[:lower:]' <<<"$name")" "${line#*:}"
    fi
  done
}

# The value of one header in `headers` output.
header() {
  sed -n "s/^$1: //p"
}

# The API's request lines for /api/replays (the API logs the path, never the query).
replay_lines() {
  local logs
  logs=$("${compose[@]}" logs --no-color --no-log-prefix api)
  grep '"path":"/api/replays"' <<<"$logs" || true
}

# Runs `request` (a command that asks for /api/replays once), waits for its line in the API's
# log, and prints the address hash on it.
hash_of() {
  local before after
  before=$(replay_lines | wc -l)
  "$@" >/dev/null
  for _ in $(seq 1 50); do
    after=$(replay_lines | wc -l)
    [ "$after" -gt "$before" ] && break
    sleep 0.2
  done
  [ "$after" -gt "$before" ] || fail "no API log line for the request"
  replay_lines | tail -1 | sed -n 's/.*"ipHash":"\([0-9a-f]*\)".*/\1/p'
}

# The hash the API's log gives an address, with the API's own LOG_IP_SALT.
expected_hash() {
  "${compose[@]}" exec -T api node -e \
    'const salt = process.env.LOG_IP_SALT; if (!salt) process.exit(2); console.log(require("node:crypto").createHmac("sha256", salt).update(process.argv[1]).digest("hex").slice(0, 16))' \
    "$1" || fail "the API has no LOG_IP_SALT; set it for these checks"
}

# A run token from the development API (POST /api/runs with the development bypass).
mint() {
  local token
  token=$(curl -sS -X POST -H 'content-type: application/json' \
    -d '{"turnstileToken":"dev-bypass"}' "$base/api/runs" | jq -r .runToken)
  [ -n "$token" ] && [ "$token" != null ] || fail "POST /api/runs gave no run token"
  echo "$token"
}

if [ "$mode" = long-stream ]; then
  # A visitor leaves a held stream: Caddy logs the cut response (a warning with the request), and
  # that line must hold no more than the access line does.
  token=$(mint)
  sleep 1
  since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  curl -sN --max-time 4 "$base/api/analyze/stream?query=One%20More%20Time%20Daft%20Punk&runToken=$token" \
    >/dev/null || true
  sleep 2
  web=$("${compose[@]}" ps -q web)
  gateway=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}' "$web")
  recent=$("${compose[@]}" logs --no-color --no-log-prefix --since "$since" web)
  grep -q 'incomplete response' <<<"$recent" ||
    fail "Caddy logged no cut stream for this request (is SSE_HOLD_MS set?)"
  logs=$("${compose[@]}" logs --no-color --no-log-prefix web)
  for secret in "$token" "Daft" "\"$gateway\""; do
    if grep -qF -- "$secret" <<<"$logs"; then
      fail "Caddy's log holds ${secret:0:12}… after a stream was cut"
    fi
  done
  echo "ok: a cut stream leaves no run token, query or full address in Caddy's log"

  token=$(mint)
  out=$(mktemp)
  trap 'rm -f "$out"' EXIT
  start=$(date +%s)
  curl -sN --max-time 140 \
    "$base/api/analyze/stream?query=One%20More%20Time%20Daft%20Punk&runToken=$token" >"$out" ||
    fail "the stream ended with curl exit $? after $(($(date +%s) - start)) s"
  took=$(($(date +%s) - start))
  types=$(sed -n 's/^data: //p' "$out" | jq -r .type)
  heartbeats=$(grep -c '^heartbeat$' <<<"$types" || true)
  echo "stream: $took s, $heartbeats heartbeats, last event $(tail -1 <<<"$types")"
  [ "$took" -ge 130 ] || fail "the stream was not held (SSE_HOLD_MS=130000 on the API?)"
  [ "$heartbeats" -ge 8 ] || fail "expected a heartbeat every 15 s while the stream was held"
  [ "$(tail -1 <<<"$types")" = "done" ] || fail "the stream did not end with done"
  echo "ok: a stream held 130 s passed through Caddy"
  exit 0
fi

# Every service healthy (the audio service may still be fetching its models). Stopped
# containers count too (ps -a).
for _ in $(seq 1 60); do
  states=$("${compose[@]}" ps -a --format '{{.Service}} {{.State}} {{.Health}}')
  unhealthy=$(grep -v ' running healthy$' <<<"$states" || true)
  [ -z "$unhealthy" ] && [ "$(wc -l <<<"$states")" -ge 3 ] && break
  sleep 5
done
echo "$states"
[ -z "$unhealthy" ] || fail "not healthy: $(tr '\n' ';' <<<"$unhealthy")"
[ "$(wc -l <<<"$states")" -ge 3 ] || fail "expected the web, api and audio services"

# Only Caddy publishes a port.
for service in api audio; do
  bindings=$(docker inspect -f '{{json .HostConfig.PortBindings}}' "$("${compose[@]}" ps -q "$service")")
  [ "$bindings" = "{}" ] || fail "$service publishes $bindings"
done
echo "ok: the API and the audio service publish no port"

# A stream without a run token is refused.
status=$(curl -s -o /dev/null -w '%{http_code}' "$base/api/analyze/stream?query=x")
[ "$status" = 401 ] || fail "a stream without a run token answered $status"
echo "ok: no run token, 401"

# The site's origin is accepted from a browser that sends Origin but no Sec-Fetch-Site (Safari
# before 16.4) on POST /api/runs; another origin is refused. An empty body gets 400 once the
# origin check passes, so Turnstile is never asked.
runs_status() {
  curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' \
    -H "Origin: $1" -d '{}' "$base/api/runs"
}
status=$(runs_status "$base")
[ "$status" = 400 ] || fail "POST /api/runs from the site's origin $base answered $status (is it in CORS_ORIGINS?)"
status=$(runs_status https://unlisted.example)
[ "$status" = 403 ] || fail "POST /api/runs from an unlisted origin answered $status"
echo "ok: the site's origin accepted without Sec-Fetch-Site, another origin refused"

# The security headers on a page, a hashed asset, an API answer and an error.
page=$(curl -sS "$base/")
asset=$(grep -oE '/assets/[^"]+\.js' <<<"$page" | head -1 || true)
[ -n "$asset" ] || fail "no script under /assets/ in the page"
for path in / "$asset" /api/health /assets/missing.js; do
  got=$(headers "$base$path")
  csp=$(header content-security-policy <<<"$got")
  grep -q "default-src 'self'" <<<"$csp" || fail "$path: no Content-Security-Policy"
  grep -q "frame-ancestors 'self'" <<<"$csp" || fail "$path: the policy lacks frame-ancestors"
  [ "$(header x-content-type-options <<<"$got")" = nosniff ] || fail "$path: no nosniff"
  [ -n "$(header referrer-policy <<<"$got")" ] || fail "$path: no Referrer-Policy"
  [ -z "$(header x-xss-protection <<<"$got")" ] || fail "$path: X-XSS-Protection is obsolete"
  [ -z "$(header server <<<"$got")" ] || fail "$path: the Server header is sent"
done
echo "ok: security headers on /, $asset, /api/health and a 404"

# Cache rules: hashed assets for a year, public/ files for a day, the page revalidated, and a
# missing static file a 404 that is never cached (never the app's page).
[ "$(headers "$base$asset" | header cache-control)" = "public, max-age=31536000, immutable" ] ||
  fail "$asset is not cached as immutable"
[ "$(headers "$base/fonts/OFL.txt" | header cache-control)" = "public, max-age=86400" ] ||
  fail "/fonts/OFL.txt is not cached for a day"
[ "$(headers "$base/" | header cache-control)" = no-cache ] || fail "/ is not revalidated"
for path in /assets/missing.js /fonts/missing.woff2; do
  got=$(headers "$base$path")
  [ "$(head -1 <<<"$got" | cut -d' ' -f2)" = 404 ] || fail "$path: $(head -1 <<<"$got")"
  [ "$(header cache-control <<<"$got")" = no-store ] || fail "$path: a 404 that may be cached"
done
echo "ok: cache rules"

# Only /api/... goes to the API: /apifoo and /api are the app's page.
for path in /apifoo /api; do
  got=$(headers "$base$path")
  type=$(header content-type <<<"$got")
  [ "${type%%;*}" = text/html ] || fail "$path answered $type, not the app's page"
done
echo "ok: /apifoo and /api are not proxied"

# Client addresses. From a peer outside Cloudflare's ranges (this machine, through the published
# port), CF-Connecting-IP and X-Forwarded-For leave the address the API sees, and logs as a hash,
# unchanged.
plain=$(hash_of curl -s "$base/api/replays")
cf=$(hash_of curl -s -H 'CF-Connecting-IP: 203.0.113.7' "$base/api/replays")
xff=$(hash_of curl -s -H 'X-Forwarded-For: 198.51.100.9' "$base/api/replays")
forged=$(expected_hash 203.0.113.7)
echo "untrusted peer: plain $plain, CF-Connecting-IP $cf, X-Forwarded-For $xff (203.0.113.7: $forged)"
[ -n "$plain" ] && [ "$plain" = "$cf" ] && [ "$plain" = "$xff" ] && [ "$cf" != "$forged" ] ||
  fail "a forged client address reached the API"
echo "ok: forged client addresses ignored"

# The probes below are second Caddys from the running web image, each with its own temporary
# state and no site.d, so they leave the stack's volumes and settings alone.
web=$("${compose[@]}" ps -q web)
image=$(docker inspect -f '{{.Config.Image}}' "$web")
network=$(docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{end}}' "$web")
run_probe() {
  docker run -d --rm --read-only --cap-drop ALL --security-opt no-new-privileges \
    --tmpfs /data:uid=10001,gid=10001 --tmpfs /config:uid=10001,gid=10001 --tmpfs /tmp "$@" "$image"
}

# From a trusted peer (a probe on the stack's network that trusts its own loopback, asked from
# inside its container), CF-Connecting-IP is the address the API sees; X-Forwarded-For still is
# not.
probe=$(run_probe --network "$network" -e SITE_ADDRESS=:80 -e TRUSTED_PROXIES=127.0.0.1/32)
trap 'docker rm -f "$probe" >/dev/null 2>&1 || true' EXIT
for _ in $(seq 1 25); do
  docker exec "$probe" wget -q -O /dev/null http://127.0.0.1:2020/health 2>/dev/null && break
  sleep 0.2
done
via_probe() {
  docker exec "$probe" wget -q -O /dev/null "$@" http://127.0.0.1:80/api/replays
}
trusted=$(hash_of via_probe --header 'CF-Connecting-IP: 203.0.113.7')
trusted_xff=$(hash_of via_probe --header 'X-Forwarded-For: 198.51.100.9')
loopback=$(expected_hash 127.0.0.1)
docker rm -f "$probe" >/dev/null
echo "trusted peer: CF-Connecting-IP $trusted (203.0.113.7: $forged), X-Forwarded-For $trusted_xff (the peer 127.0.0.1: $loopback)"
[ "$trusted" = "$forged" ] || fail "CF-Connecting-IP from a trusted peer was not used"
[ "$trusted_xff" = "$loopback" ] || fail "X-Forwarded-For from a trusted peer was used"
echo "ok: CF-Connecting-IP used from a trusted peer only"

# What a visitor looked up, and the run token, stay out of Caddy's access log.
curl -s -o /dev/null "$base/api/analyze/stream?query=check-stack-typed&runToken=check-stack-token&threadId=check-stack-thread"
curl -s -o /dev/null "$base/t/check-stack-track?q=check-stack-typed"
curl -s -o /dev/null "$base/api/factoids?trackTitle=check-stack-typed&trackArtist=check-stack-typed&trackId=check-stack-track"
sleep 1
access=$("${compose[@]}" logs --no-color --no-log-prefix web)
for secret in check-stack-token check-stack-typed; do
  if grep -q "$secret" <<<"$access"; then
    fail "Caddy's log holds $secret"
  fi
done
grep -q '"uri":"/api/analyze/stream?query=REDACTED&threadId=check-stack-thread"' <<<"$access" ||
  fail "no access line for the stream request (or the thread id is gone)"
grep -q '"uri":"/t/check-stack-track?q=REDACTED"' <<<"$access" || fail "no access line for the /t/ page"
grep -q '"uri":"/api/factoids?trackArtist=REDACTED&trackId=REDACTED&trackTitle=REDACTED"' <<<"$access" ||
  fail "the factoid request's track fields are not REDACTED"
echo "ok: the typed text and the run token are kept out of Caddy's access log"

# Over HTTPS (SITE_ADDRESS=localhost: Caddy's own local certificate), from inside a probe:
# neither the redirect from HTTP (whose Location repeats the query) nor the HTTPS request's
# access line nor any other line writes the typed text or the run token.
https_probe=$(run_probe -e SITE_ADDRESS=localhost)
trap 'docker rm -f "$https_probe" >/dev/null 2>&1 || true' EXIT
for _ in $(seq 1 50); do
  docker exec "$https_probe" wget -q -O /dev/null http://127.0.0.1:2020/health 2>/dev/null && break
  sleep 0.2
done
sleep 1
for url in "http://localhost/t/check-https-track?q=check-https-typed&runToken=check-https-token" \
  "http://127.0.0.1/api/analyze/stream?query=check-https-typed&runToken=check-https-token" \
  "https://localhost/api/analyze/stream?query=check-https-typed&runToken=check-https-token"; do
  docker exec "$https_probe" wget -q -O /dev/null --no-check-certificate "$url" 2>/dev/null || true
done
sleep 1
https_logs=$(docker logs "$https_probe" 2>&1)
docker rm -f "$https_probe" >/dev/null
grep -q '"status":308' <<<"$https_logs" || fail "no redirect to HTTPS was logged"
grep -q '"tls":{' <<<"$https_logs" || fail "no access line for the HTTPS request"
for secret in check-https-token check-https-typed; do
  if grep -q "$secret" <<<"$https_logs"; then
    fail "Caddy's log over HTTPS holds $secret"
  fi
done
echo "ok: over HTTPS and its redirect, the typed text and the run token stay out of Caddy's log"

echo "all checks passed"
