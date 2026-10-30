# Deploy runbook

Liner Notes on one server behind Cloudflare. The README ("Deploying") explains the stack; this page
is the order of operations. Commands run from the checkout on the server (`/srv/liner-notes` here)
as the deploy user, after `alias dc='docker compose -f deploy/compose.prod.yml'`.

## Two guards

1. **Firewall the origin to the Cloudflare ranges.** Ports 80 and 443 accept only the Cloudflare
   ranges (https://www.cloudflare.com/ips-v4 and /ips-v6), SSH only the operators' addresses. Use
   the Hetzner Cloud Firewall, outside the host: ports Docker publishes bypass `ufw`.
2. **Do not expose the app publicly until the repository is public with its licence, or a written
   source offer exists.** The audio service links Essentia (AGPL-3.0-only): under AGPL §13 every
   network user must be offered the source (the footer's "Source" link). Publishing the repository
   is the owner's call; until then the site stays on 127.0.0.1 (`PROXY_BIND`'s default).

## First deploy (Hetzner, private)

1. **Server.** A Hetzner Cloud x86_64 server (the audio image is `linux/amd64` only) with 4 GB of
   memory or more (the containers' limits add up to 3.25 GB), Ubuntu LTS, SSH keys only, Docker
   Engine and its compose plugin, a `deploy` user in the `docker` group (root-equivalent); attach
   the firewall first.
2. **Code and settings.** `git clone git@github.com:josefdc/liner-notes.git /srv/liner-notes`
   (with the deploy key, below), `git checkout <release commit>`, then the settings below with
   `REPLAY_MODE=only`, `CORS_ORIGINS=http://127.0.0.1:3180` and Cloudflare's Turnstile test keys
   (README, "Turnstile").
3. **Start** (`ssh -L 3180:127.0.0.1:3180` shows the site on your machine) and check readiness:
   ```bash
   dc up -d --build && dc ps                   # every service turns healthy
   dc exec api node -e "fetch('http://127.0.0.1:3001/api/ready').then(r => r.text()).then(console.log)"
   ```
4. **Live analysis**, once the Azure limits below are set: create the spend log (the API refuses
   every model call until it exists), set `REPLAY_MODE=fallback` and run `dc up -d api`:
   ```bash
   dc exec api node -e "require('fs').closeSync(require('fs').openSync('/app/spend/llm-spend.jsonl', 'wx'))"
   ```

## Go public (only under Guard 2)

1. **Cloudflare.** A proxied **A** record only (compose publishes on IPv4); SSL/TLS "Full (strict)"
   with the origin certificate of README, "Certificates" (Origin CA in `deploy/site.d`, or ACME
   over HTTP with `/.well-known/acme-challenge/` exempt from "Always Use HTTPS"); HSTS on (Caddy
   sends none); Rocket Loader, Web Analytics' automatic setup and Bot Fight Mode's JavaScript
   detections off (the CSP blocks them); a Turnstile widget for the hostname.
2. **Publish.** In `deploy/.env`: `SITE_ADDRESS` (the hostname), `PROXY_BIND=0.0.0.0`,
   `PROXY_PORT=80`, `PROXY_TLS_PORT=443`, `CORS_ORIGINS=https://<hostname>`, the widget's keys,
   `TURNSTILE_EXPECTED_HOSTNAME`, and `VITE_SOURCE_URL` when the source offer is not the public
   repository (empty points the footer there). Then `dc up -d --build`.
3. **Check the lock-down** from a machine outside Cloudflare: `curl -m 5 http://<server IP>/` must
   time out, while `https://<hostname>/` answers.

## Deploy a new release

```bash
deploy/scripts/backup.sh                         # first: a rollback needs it
git fetch && git checkout <release commit>       # then IMAGE_TAG=<its short hash> in deploy/.env
dc up -d --build && dc ps                        # then /api/ready, as above
```

Before each deploy, compare Cloudflare's ranges with `trusted_proxies` in `apps/web/Caddyfile`;
when they differ, update that list (README, "Cloudflare's addresses") and the Hetzner firewall.

## Secrets

`deploy/.env`, next to the compose file, holds every setting (compose reads it; a shell cannot
source it): `cp deploy/.env.example deploy/.env && chmod 600 deploy/.env`, owned by the deploy
user, never committed or printed (nor `dc config`'s output, which holds it). After a change,
`dc up -d` recreates what changed; `VITE_*` are built into the web image: `dc up -d --build web`.

- Required: `RUN_TOKEN_SECRET` (`openssl rand -base64 48`), `AUDIO_SERVICE_TOKEN`
  (`openssl rand -hex 32`), `TURNSTILE_SECRET_KEY`, `CORS_ORIGINS`, `VITE_TURNSTILE_SITE_KEY`.
- The site: `SITE_ADDRESS`, `PROXY_*`, `VITE_SOURCE_URL`, `TURNSTILE_EXPECTED_HOSTNAME`,
  `LOG_IP_SALT` (secret), `REPLAY_MODE`, `IMAGE_TAG` (the release's `git rev-parse --short HEAD`).
- Live analysis (secret): `AZURE_OPENAI_*` (key, endpoint, deployment names), `SPOTIFY_CLIENT_*`,
  `TAVILY_API_KEY`, `LASTFM_API_KEY`, `DISCOGS_TOKEN`, `SHS_API_KEY`, `GENIUS_ACCESS_TOKEN`.
- Outside the file: a read-only GitHub deploy key (`~deploy/.ssh`, mode 600), an Origin CA key in
  `deploy/site.d` (mode 600, owned by uid 10001, README), and the backups, which hold what
  visitors looked up (`deploy/backups`, readable by its owner).

## Azure: quota, budget alert, the app's cap

- **The app's cap.** The API reserves each call's worst-case cost in the spend log first. Visitors'
  runs (purpose "dev") stop at `BUDGET_TOTAL_USD` − `BUDGET_EVAL_FLOOR_USD` over the log's whole
  life: $5 with the defaults (25 − 20), so `BUDGET_DAILY_USD` (13.5 per UTC day) never binds them.
  The floor is kept for evaluations; a server that runs none can set `BUDGET_EVAL_FLOOR_USD=0`.
  Past the cap, `REPLAY_MODE=fallback` serves only the showcase tracks' recorded runs.
- **Budget alert.** Cost Management, Budgets: the resource group at `BUDGET_TOTAL_USD` (all the log
  can allow), alerts at 50, 80, 100 %. Azure only alerts; one ahead of the log means its estimates
  (table prices) drift, or another client uses the key.
- **TPM quota.** Tokens per minute is a rate limit, not a cost limit: give each
  `AZURE_OPENAI_DEPLOYMENT_*` deployment the peak the site needs (`LLM_CONCURRENCY` calls at once,
  default 2) and no more, so a burst is refused (429). The spend log is the cap.
- **Watching it.** `dc exec api node dist/report.js --days 30`: calls and estimated USD per day,
  from the database (retention prunes it). The spend log's all-time total, as the API counts it:
  `dc exec api node -e "const l=require('fs').readFileSync('/app/spend/llm-spend.jsonl','utf8').split('\n').filter(s=>s.trim()).map(JSON.parse),s=new Set(l.filter(x=>x.kind==='settle').map(x=>x.id));console.log('USD',l.filter(x=>!(x.kind==='reserve'&&s.has(x.id))).reduce((a,x)=>a+x.usd_est,0).toFixed(4))"`

## Backups and restore drill

```bash
deploy/scripts/backup.sh                     # deploy/backups/liner-notes-<UTC time>.tar.gz + .sha256
deploy/scripts/restore.sh --dry-run latest   # checksum and integrity_check; changes nothing
deploy/scripts/restore.sh latest             # asks, stops the API, saves, restores, restarts it
```

`backup.sh` copies the database with `VACUUM INTO` while the API runs, and the spend log, checks
the archive as a restore would, and keeps the newest `KEEP` (14). A restore first saves the
volumes as they are (`<project>-pre-restore-<time>.tar.gz`, never "latest") and merges the spend
logs (every record of both): it never lowers what the API counts as spent. Cron mails the echo
only when a run fails (set `MAILTO` and a mail relay, or point it at your alerting):
`17 3 * * * /srv/liner-notes/deploy/scripts/backup.sh >>/srv/liner-notes/deploy/backups/backup.log 2>&1 || echo "liner-notes backup failed"`.
Copy `deploy/backups` off the server encrypted (`restic` to a Storage Box, say), each `.sha256`
beside its archive. Monthly, restore the newest off-site copy into a scratch project (another
Docker host, or a quiet hour) with test settings, never `deploy/.env`: the five required ones,
`IMAGE_TAG`, `REPLAY_MODE=only`, `AUDIO_FETCH_MODELS=0`, `PROXY_PORT=3480`, `PROXY_TLS_PORT=3481`.

```bash
alias drill='docker compose -p ln-drill --env-file /tmp/drill.env -f deploy/compose.prod.yml'
drill up -d --no-build --wait
BACKUP_DIR=/tmp/ln-drill-backups deploy/scripts/restore.sh --yes --project ln-drill /path/to/liner-notes-<UTC time>.tar.gz
drill exec api node dist/report.js --days 30
drill down -v                                # the scratch project only
```

## Replay switch

`REPLAY_MODE`: `fallback` (the compose default) analyses live while keys, spend log and budget
allow, and otherwise serves only the showcase tracks' recorded runs; `only` serves recorded runs
and calls no live service (no key needed); `off` is live only. To stop all spending, set
`REPLAY_MODE=only` and `dc up -d api`: `/api/ready` then shows the provider `not_needed`.

## Rollback

Each release keeps its images (tagged `IMAGE_TAG`; `dc images` shows the running one). Go back
with web and API together (README, "Order"):

```bash
git checkout <previous commit>    # then IMAGE_TAG=<previous tag> in deploy/.env
dc up -d --no-build               # its images are still here; if they were removed, --build
```

Migrations only go forward: an older API refuses a database a newer one migrated ("schema version
N is newer than this code supports" in `dc logs api`). Then restore the pre-deploy backup with the
previous image (losing the runs since), and bring web up on the same release; check `/api/ready`:

```bash
API_IMAGE=liner-notes-api:<previous tag> deploy/scripts/restore.sh deploy/backups/liner-notes-<UTC time>.tar.gz
dc up -d --no-build
```

Never `dc down -v` a deployment: it deletes its volumes, database and spend log.
