# Deployment

The full stack with live analysis, on your own server. For the replay-only demo on a static host, see
[the static demo](static-demo.md).

`deploy/compose.prod.yml` runs the three images: `web` (Caddy, which serves the built app and
forwards `/api/*` to the API, `apps/web/Caddyfile`), `api` and `audio`. Only Caddy publishes a
port; browsers reach the API through it, and only the API calls the audio service. This is the
one Docker setup: for development, use `npm run dev` ([Development](development.md)). The host must be x86_64
(`linux/amd64`): the audio service's Essentia wheels exist for no other Linux platform.

```bash
cp deploy/.env.example deploy/.env && chmod 600 deploy/.env   # then fill it in
docker compose -f deploy/compose.prod.yml up -d --build
docker compose -f deploy/compose.prod.yml ps                  # every service turns healthy
```

`deploy/.env.example` lists every setting the containers receive. Compose stops, naming the
variable, while `RUN_TOKEN_SECRET`, `TURNSTILE_SECRET_KEY`, `AUDIO_SERVICE_TOKEN`, `CORS_ORIGINS`
or `VITE_TURNSTILE_SITE_KEY` is empty. `CORS_ORIGINS` is the site's own origin
(`https://liner-notes.example`; locally `http://127.0.0.1:3180,http://localhost:3180`): a
browser that does not mark its requests as same-origin (no `Sec-Fetch-Site`, such as Safari
before 16.4) is refused on the analysis and on `POST /api/runs` unless its origin is listed. By
default the site is plain HTTP on http://127.0.0.1:3180. On a server, set `SITE_ADDRESS` to the
site's hostname (Caddy then serves HTTPS on 443 and redirects port 80 to it) and publish the
standard ports with `PROXY_BIND=0.0.0.0`, `PROXY_PORT=80` and `PROXY_TLS_PORT=443`. The images
are named `liner-notes-web`, `-api` and `-audio`, tagged `IMAGE_TAG` (default `latest`): a tag
per release lets a deploy go back to the previous images.

**Certificates.** With a hostname in `SITE_ADDRESS`, Caddy asks Let's Encrypt (or ZeroSSL) for
a certificate and stores it on the `caddy-data` volume. Behind Cloudflare's proxy, pick one of:

- **ACME over HTTP (the default).** It works when Cloudflare forwards plain-HTTP requests for
  `/.well-known/acme-challenge/` to port 80 of the server: "Always Use HTTPS" must not redirect
  them (turn it off, or exempt that path), also for the renewals every 60 days. The TLS-ALPN
  challenge does not pass the proxy; Caddy tries the HTTP challenge as well.
- **A Cloudflare Origin CA certificate** (SSL/TLS mode "Full (strict)"). With `SITE_ADDRESS`
  set to the hostname, copy `deploy/site.d/origin-ca.caddy.example` to
  `deploy/site.d/origin-ca.caddy` and put the certificate and key next to it, as that file says;
  compose mounts `deploy/site.d` read-only and Caddy reads its `*.caddy` files into the site. The
  web container runs as uid 10001 and must read them: the directory stays 755, `origin-ca.caddy`
  and `origin.pem` 644, and only the key goes to that user (`chmod 600 origin.key && sudo chown
  10001 origin.key`); on an SELinux host the mount also needs `:Z`. The container stops at start,
  naming the file, when it cannot read one. Then confirm that Caddy serves this certificate and
  asks no certificate authority:
  `docker compose -f deploy/compose.prod.yml logs web | grep 'skipping automatic certificate management'`.
  The certificate is trusted by Cloudflare only, so the site is reachable through the proxy only.
- **A DNS challenge.** It needs a web image built with Caddy's Cloudflare DNS module, which the
  shipped image does not have, and an API token for the zone: not set up here.

The runbook, `deploy/RUNBOOK.md`, has the Cloudflare side. Caddy serves HTTP/1.1 and HTTP/2
only: behind Cloudflare a visitor's HTTP/3 ends at Cloudflare's edge, which reaches the server
over TCP. Strict-Transport-Security is not sent here; it is set at Cloudflare (runbook).

| Service | Reached at | Notes |
|---------|------------|-------|
| `web`   | `PROXY_BIND:PROXY_PORT` (default 127.0.0.1:3180) and `PROXY_TLS_PORT` | Caddy; security headers and a Content-Security-Policy on every response but Caddy's own redirect from HTTP to HTTPS (a 308 with no body) |
| `api`   | `/api/*` through Caddy only | `NODE_ENV=production`, `TRUST_PROXY=1`, `REPLAY_MODE=fallback` by default; database on the `sonic-data` volume (`/app/data/sonic-agent.db`), spend log on `llm-spend` |
| `audio` | the API only | `linux/amd64`; models on the `audio-models` volume, fetched at the first start (up to 90 s) |

The database file keeps its name, `sonic-agent.db`, on the volume `liner-notes_sonic-data` (compose
prefixes the volume `sonic-data` with the project name, `liner-notes`). The earlier root
`docker-compose.yml` named its volume after the checkout's directory (`<directory>_sonic-data`),
so a database from it carries over by itself only from a checkout named `liner-notes`; otherwise
copy it once, with both stacks stopped:

```bash
docker run --rm -v <directory>_sonic-data:/from:ro -v liner-notes_sonic-data:/to \
  node:24-slim cp -a /from/. /to/
```

**Upgrading from the root `docker-compose.yml`.** Its containers (`sonic-web`, `sonic-server`,
`sonic-analysis`) keep their fixed names and port 80: remove them before the first start. When
the old stack ran as the project `liner-notes` (from a checkout of that name),
`docker compose -f deploy/compose.prod.yml up -d --remove-orphans` does it; otherwise
`docker rm -f sonic-web sonic-server sonic-analysis`. Never take a deployment down with
`down -v`: it deletes the volumes, the database and the spend log with them.

Live model calls need the spend log, which is never created by itself; create it once:

```bash
docker compose -f deploy/compose.prod.yml exec api node -e "require('fs').closeSync(require('fs').openSync('/app/spend/llm-spend.jsonl', 'wx'))"
```

**Turnstile.** The web image takes the widget's site key as a build setting
(`VITE_TURNSTILE_SITE_KEY` in `deploy/.env`, public); the API takes its secret key
(`TURNSTILE_SECRET_KEY`) and the site's hostname (`TURNSTILE_EXPECTED_HOSTNAME`). Cloudflare's
test keys (site key `1x00000000000000000000AA`, secret `1x0000000000000000000000000000000AA`)
always pass, which is how to try the production stack with a real check; leave
`TURNSTILE_EXPECTED_HOSTNAME` empty with them (Cloudflare reports their checks for
`example.com`).

**Without Cloudflare.** `deploy/compose.dev.yml` runs the production API and audio images as a
project of its own, `liner-notes-dev`, with its own containers, volumes and database, on
http://127.0.0.1:3182 (`DEV_PROXY_PORT`): starting it never touches the `liner-notes` project
(do not rename it to that with `-p`). It uses the API and audio images as they are, never
building, pulling or retagging them, so build them with the production file first; `--build`
builds only its web image (`liner-notes-web-dev`), which has no site key,
so the page sends the development bypass, which its API, in development, accepts; only recorded
runs are served by default (`DEV_REPLAY_MODE`). `deploy/check-stack.sh` checks a running stack
through Caddy, as CI does (`.github/workflows/docker.yml`). Its checks need `LOG_IP_SALT`, set
here for the run, and the local origin in `CORS_ORIGINS` (`http://127.0.0.1:3180`):

```bash
LOG_IP_SALT=check-stack docker compose -f deploy/compose.prod.yml up -d --build   # builds all three
deploy/check-stack.sh
LOG_IP_SALT=check-stack SSE_HOLD_MS=130000 \
  docker compose -f deploy/compose.prod.yml -f deploy/compose.dev.yml up -d --build
deploy/check-stack.sh long-stream   # a cut stream, then a stream held 130 s, through Caddy
docker compose -f deploy/compose.prod.yml -f deploy/compose.dev.yml down -v   # the dev project only
```

**Client addresses.** Caddy takes the visitor's address from `CF-Connecting-IP` only when the
request comes from one of Cloudflare's ranges, listed in `apps/web/Caddyfile` (`trusted_proxies`);
from any other peer the header is ignored. It sends the API that one address in
`X-Forwarded-For`, which the API trusts from one proxy (`TRUST_PROXY=1`) for its rate limits and
its hashed log addresses. Caddy's logs leave out the typed text and the run token: the access
log writes the query's `runToken` nowhere and `query`, `q`, `trackId`, `selectedTrackId`,
`trackTitle` and `trackArtist` as `REDACTED`, and Caddy's other lines (such as a stream the
visitor left) keep only the path. Ids stay, in Caddy's log and the API's: `threadId` and `runId`
in queries, and any in a path (`/t/<id>`, `/api/runs/<id>`, `/api/runs/by-track/<id>`).
No request headers or redirect targets are written, and addresses are shortened to their network.

**Content-Security-Policy.** The policy allows scripts from the site and Turnstile only. Cloudflare
features that add scripts to the page (Rocket Loader, the Web Analytics beacon, Bot Fight Mode's
JavaScript detections) are blocked by it: keep them off for the site, or extend the policy in
`apps/web/Caddyfile` (`deploy/RUNBOOK.md`).

**Cloudflare's addresses.** Cloudflare publishes its ranges at https://www.cloudflare.com/ips-v4
and https://www.cloudflare.com/ips-v6. Before each deploy, compare them with the list in
`apps/web/Caddyfile`; when they differ, update the list and its date, rebuild the web image, and
update the origin's firewall to match (`deploy/RUNBOOK.md`).

**Order.** Deploy the API before the web: a web build reads the event types of its own API
version, not an older API's. Roll both back together. The server, DNS, Cloudflare and Turnstile
settings, and backups are in the runbook, `deploy/RUNBOOK.md`.

`GET /api/health` is the liveness probe the containers' health checks use. `GET /api/ready`
answers 200 when the API can serve what it is set up to serve and 503 otherwise, listing each
check (database and migrations, audio service and its models, model provider, budget state).
While live analysis is not served (`REPLAY_MODE=only`, or `fallback` with live analysis off or
the budget spent) the audio service and the provider are not needed; with `REPLAY_MODE=off` a
spent budget answers 503. The answer is public and limited per address like search; it shows
check names and states (and the schema version), never a key, host, amount, provider name or
variable name: what the provider lacks is written to the API's log. See `apps/api/.env.example`.

The run report prints, per UTC day: runs by live, replay (a recording served again, or model
answers replayed from stored answers) and cached result and by outcome; p50/p95 duration of
completed live runs, with the time spent waiting at the track picker left out; the fallback rate;
and, by the day of the call, model calls sent to the provider, their tokens and estimated USD
from the database's usage rows. Days before the cutoff retention last applied (recorded in the
database) are shown as pruned; on a database migrated from before cutoffs were recorded, the
days an earlier prune may have emptied are marked unknown. It never prints what anyone typed or
a run id; the spend log (`LLM_SPEND_LOG`) stays the authoritative record of spend.

```bash
npm run report -w apps/api -- --days 14            # a checkout's database (SQLITE_DB_PATH)
docker compose -f deploy/compose.prod.yml exec api node dist/report.js --days 14 --json   # the deployment's
```

It writes nothing when the database has both its `-wal` and `-shm` files (the API has it open: it
is opened read-only) or no `-wal` (the API is stopped: a file of up to 1 GiB is read into memory,
about 2.3 times its size at peak, and kept only if it did not change meanwhile). Otherwise it is
opened read-only and SQLite creates the missing `-wal` or `-shm`, so run it as the API's user
(`docker compose exec` runs it as that user, against the `sonic-data` volume).

The analysis, resume and factoid requests carry a run token (the `runToken` query parameter),
which `POST /api/runs` issues once a visitor has passed Cloudflare Turnstile. The web app runs the
Turnstile widget before each analysis when it is built with `VITE_TURNSTILE_SITE_KEY` (see
`apps/web/.env.example`; the web image takes it as a build argument,
`--build-arg VITE_TURNSTILE_SITE_KEY=...`); the widget shows only when Cloudflare asks for an
interaction. Without a site key it sends the development bypass's token instead. The API image runs
with `NODE_ENV=production` and does not start without `RUN_TOKEN_SECRET` (32 bytes or more, for
example `openssl rand -base64 48`) and `TURNSTILE_SECRET_KEY` (`deploy/.env` for the compose stack);
`TURNSTILE_EXPECTED_HOSTNAME` limits the check to the site's hostname. Only in development
(`NODE_ENV` set to `development` or `test`, or unset under `npm run dev` or `smoke:llm`) can the
API start without them: with no Turnstile secret the Turnstile token `dev-bypass` passes
(`TURNSTILE_BYPASS=0` turns that off) and tokens are signed with a key of the process's own. Any
other `NODE_ENV`, unset included, needs both secrets.
