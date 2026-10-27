#!/usr/bin/env bash
# Checks a running stack of deploy/compose.prod.yml through Caddy, on this machine and with no
# Cloudflare network (CI runs it too: .github/workflows/docker.yml).
#
#   deploy/check-stack.sh              the production stack: every service healthy, no port but
#                                      Caddy's, the API refusing a stream without a run token,
#                                      the security headers and cache rules, /api/* only going to
#                                      the API, forged client addresses ignored, the run token
#                                      kept out of Caddy's log
#   deploy/check-stack.sh long-stream  a replayed stream held 130 s (SSE_HOLD_MS=130000) passes
#                                      through Caddy and ends with "done". Needs the API in
#                                      development (deploy/compose.dev.yml), which issues run
#                                      tokens without Turnstile.
#
# COMPOSE is the compose command of the stack (default: docker compose -f deploy/compose.prod.yml)
# and PROXY_PORT the port Caddy is published on (default 3180).
set -euo pipefail

read -r -a compose <<<"${COMPOSE:-docker compose -f deploy/compose.prod.yml}"
base="http://127.0.0.1:${PROXY_PORT:-3180}"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# The response headers of a GET, lower-cased names.
headers() {
  curl -sS -D - -o /dev/null "$@" | tr -d '\r' | sed 's/^\([^:]*\):/\L\1:/'
}

# The value of one header in `headers` output.
header() {
  sed -n "s/^$1: //p"
}

# The address hash of the last API request line for `path` (the API logs no query string).
last_hash() {
  "${compose[@]}" logs --no-color --no-log-prefix --since 60s api |
    grep "\"path\":\"$1\"" | tail -1 | sed -n 's/.*"ipHash":"\([0-9a-f]*\)".*/\1/p' || true
}

if [ "${1:-}" = "long-stream" ]; then
  token=$(curl -sS -X POST -H 'content-type: application/json' \
    -d '{"turnstileToken":"dev-bypass"}' "$base/api/runs" | jq -r .runToken)
  [ -n "$token" ] && [ "$token" != null ] || fail "POST /api/runs gave no run token"
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

# Every service healthy (the audio service may still be fetching its models).
for _ in $(seq 1 60); do
  unhealthy=$("${compose[@]}" ps --format '{{.Service}} {{.Health}}' | grep -vc ' healthy$' || true)
  [ "$unhealthy" -eq 0 ] && break
  sleep 5
done
"${compose[@]}" ps --format '{{.Service}} {{.Health}}'
[ "$unhealthy" -eq 0 ] || fail "not every service is healthy"

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

# Cache rules: hashed assets for a year, the page revalidated, an error never cached.
[ "$(headers "$base$asset" | header cache-control)" = "public, max-age=31536000, immutable" ] ||
  fail "$asset is not cached as immutable"
[ "$(headers "$base/" | header cache-control)" = no-cache ] || fail "/ is not revalidated"
[ "$(headers "$base/assets/missing.js" | header cache-control)" = no-store ] ||
  fail "a missing asset may be cached"
echo "ok: cache rules"

# Only /api/... goes to the API: /apifoo and /api are the app's page.
for path in /apifoo /api; do
  got=$(headers "$base$path")
  type=$(header content-type <<<"$got")
  [ "${type%%;*}" = text/html ] || fail "$path answered $type, not the app's page"
done
echo "ok: /apifoo and /api are not proxied"

# Forged client addresses are ignored: from a peer outside Cloudflare's ranges, CF-Connecting-IP
# (and any X-Forwarded-For) leaves the address the API sees, and logs as a hash, unchanged.
curl -s -o /dev/null "$base/api/replays"
plain=$(last_hash /api/replays)
curl -s -o /dev/null -H 'CF-Connecting-IP: 203.0.113.7' "$base/api/replays"
cf=$(last_hash /api/replays)
curl -s -o /dev/null -H 'X-Forwarded-For: 198.51.100.9' "$base/api/replays"
xff=$(last_hash /api/replays)
forged=$("${compose[@]}" exec -T api node -e \
  'const salt = process.env.LOG_IP_SALT; if (!salt) process.exit(2); console.log(require("node:crypto").createHmac("sha256", salt).update("203.0.113.7").digest("hex").slice(0, 16))') ||
  fail "set LOG_IP_SALT for this check"
echo "address hashes: plain $plain, forged CF-Connecting-IP $cf, forged X-Forwarded-For $xff (203.0.113.7 would be $forged)"
[ -n "$plain" ] && [ "$plain" = "$cf" ] && [ "$plain" = "$xff" ] && [ "$cf" != "$forged" ] ||
  fail "a forged client address reached the API"
echo "ok: forged client addresses ignored"

# The run token never reaches Caddy's log.
curl -s -o /dev/null "$base/api/analyze/stream?query=x&runToken=check-stack-token-value"
sleep 1
access=$("${compose[@]}" logs --no-color --no-log-prefix web)
if grep -q check-stack-token-value <<<"$access"; then
  fail "the run token is in Caddy's log"
fi
grep -q '"uri":"/api/analyze/stream?query=REDACTED"' <<<"$access" ||
  fail "no access log line for the stream request"
echo "ok: the run token is kept out of Caddy's log"

echo "all checks passed"
