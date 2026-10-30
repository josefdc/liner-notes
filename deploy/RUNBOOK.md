# Deploy runbook

Liner Notes on one server behind Cloudflare. The README ("Deploying") explains the stack; this page
is the order of operations. Commands run from the checkout on the server (`/srv/liner-notes` here)
as the deploy user, after `alias dc='docker compose -f deploy/compose.prod.yml'`.

## Two guards

1. **Firewall the origin to the Cloudflare ranges.** Ports 80 and 443 accept only the Cloudflare
   ranges (https://www.cloudflare.com/ips-v4 and /ips-v6), SSH only the operators' addresses. Use
   the Hetzner Cloud Firewall, outside the host: ports Docker publishes bypass `ufw`.
2. **Do not expose the app publicly until the repository is public or a written source offer
   exists.** The audio service links Essentia (AGPL-3.0-only); under AGPL §13 everyone who uses the
   app over a network must be offered its source, which the footer's "Source" link
   (`VITE_SOURCE_URL`) points to. Until then keep `PROXY_BIND` at 127.0.0.1 (the default).

## First deploy (Hetzner, Cloudflare)

1. **Server.** A Hetzner Cloud x86_64 server (the audio image is `linux/amd64` only) with 4 GB of
   memory or more (the containers' limits add up to 3.25 GB), Ubuntu LTS, SSH keys only, Docker
   Engine and its compose plugin, and a `deploy` user in the `docker` group (root-equivalent).
2. **Code and settings.** `git clone https://github.com/josefdc/liner-notes /srv/liner-notes`,
   `git checkout <release commit>`, then the settings below.
3. **Cloudflare.** Proxied DNS records for the hostname; SSL/TLS mode "Full (strict)"; the origin
   certificate as in README, "Certificates" (ACME over HTTP with `/.well-known/acme-challenge/`
   exempt from "Always Use HTTPS", or an Origin CA certificate in `deploy/site.d`); HSTS on, under
   Edge Certificates (Caddy does not send it); Rocket Loader, Web Analytics' automatic setup and
   Bot Fight Mode's JavaScript detections off (the Content-Security-Policy blocks them); a
   Turnstile widget for the hostname. Before each deploy, compare Cloudflare's ranges with
   `trusted_proxies` in `apps/web/Caddyfile`.
4. **Start** with `REPLAY_MODE=only` (recorded runs) until the Azure limits below are in place:
   ```bash
   dc up -d --build && dc ps                   # every service turns healthy
   dc exec api node -e "fetch('http://127.0.0.1:3001/api/ready').then(r => r.text()).then(console.log)"
   ```
5. **Live analysis.** With the Azure limits set, create the spend log once (the API refuses every
   model call until it exists), set `REPLAY_MODE=fallback` and switch as under "Replay switch":
   ```bash
   dc exec api node -e "require('fs').closeSync(require('fs').openSync('/app/spend/llm-spend.jsonl', 'wx'))"
   ```

## Secrets

`deploy/.env`, next to the compose file, holds every setting (compose reads it; a shell cannot
source it): `cp deploy/.env.example deploy/.env && chmod 600 deploy/.env`, owned by the deploy
user, never committed (`.gitignore`) or printed. After a change, `dc up -d` recreates the
containers whose settings changed.

- Required: `RUN_TOKEN_SECRET` (`openssl rand -base64 48`), `AUDIO_SERVICE_TOKEN`
  (`openssl rand -hex 32`), `TURNSTILE_SECRET_KEY`, `CORS_ORIGINS` (`https://<hostname>`),
  `VITE_TURNSTILE_SITE_KEY` (public).
- The site: `SITE_ADDRESS` (the hostname), `PROXY_BIND=0.0.0.0`, `PROXY_PORT=80`,
  `PROXY_TLS_PORT=443`, `TURNSTILE_EXPECTED_HOSTNAME`, `LOG_IP_SALT` (secret), `REPLAY_MODE`, and
  `IMAGE_TAG`, the release's `git rev-parse --short HEAD`.
- Live analysis (secret): `AZURE_OPENAI_API_KEY` with `AZURE_OPENAI_ENDPOINT` and the
  `AZURE_OPENAI_DEPLOYMENT_*` names, `SPOTIFY_CLIENT_ID` with `SPOTIFY_CLIENT_SECRET`,
  `TAVILY_API_KEY`, `LASTFM_API_KEY`, `DISCOGS_TOKEN`, `SHS_API_KEY`, `GENIUS_ACCESS_TOKEN`.
- Outside the file: an Origin CA key in `deploy/site.d` (mode 600, owned by uid 10001, README),
  and the backups, which hold what visitors looked up (`deploy/backups`, readable by its owner).

## Azure: quota, budget alert, the app's cap

- **TPM quota.** In Azure AI Foundry, give each `AZURE_OPENAI_DEPLOYMENT_*` deployment a
  tokens-per-minute limit just above what `LLM_CONCURRENCY` (default 2) calls at once need.
- **Budget alert.** Cost Management, Budgets: a monthly budget on the resource group, alerts at
  50, 80 and 100 % to the owner. Azure only alerts; it never stops spending.
- **The app's cap.** Before each call the API reserves its worst-case cost in the spend log and
  refuses calls past `BUDGET_DAILY_USD` (per UTC day, default 13.5) or `BUDGET_TOTAL_USD` (the
  log's whole life, default 25); with `REPLAY_MODE=fallback` visitors then get recorded runs. The
  log prices calls at the app's table prices, an estimate: set the Azure budget at or just above
  `BUDGET_TOTAL_USD`, so an alert means the estimate drifted or something else uses the key.
  Compare `dc exec api node dist/report.js --days 30` with Azure's cost analysis weekly. A lost
  spend log restarts the count at zero: backups carry it; a restore never replaces one in place.

## Backups and restore drill

```bash
deploy/scripts/backup.sh                     # deploy/backups/liner-notes-<UTC time>.tar.gz + .sha256
deploy/scripts/restore.sh --dry-run latest   # checksum and integrity_check; changes nothing
deploy/scripts/restore.sh latest             # asks; backs up, stops the API, restores, restarts it
```

`backup.sh` copies the database with `VACUUM INTO` while the API runs, and the spend log, in a
throwaway container of the API image; it keeps the newest `KEEP` (14) in `BACKUP_DIR`. Run it from
the deploy user's crontab, and before every deploy:
`17 3 * * * /srv/liner-notes/deploy/scripts/backup.sh 2>&1 | logger -t liner-notes-backup`.
Copy `deploy/backups` off the server (a Hetzner Storage Box over SSH): a backup on the same disk
is no backup. Each month, restore the newest off-site copy into a scratch project:

```bash
export COMPOSE_PROJECT_NAME=ln-drill   # never the deployment's project, liner-notes
SITE_ADDRESS=:80 PROXY_BIND=127.0.0.1 PROXY_PORT=3480 PROXY_TLS_PORT=3481 REPLAY_MODE=only \
  AUDIO_FETCH_MODELS=0 docker compose -p ln-drill -f deploy/compose.prod.yml up -d --no-build --wait
deploy/scripts/restore.sh --yes /path/to/liner-notes-<UTC time>.tar.gz
docker compose -p ln-drill -f deploy/compose.prod.yml exec api node dist/report.js --days 30
docker compose -p ln-drill -f deploy/compose.prod.yml down -v && unset COMPOSE_PROJECT_NAME
```

## Replay switch

`REPLAY_MODE` in `deploy/.env`: `fallback` (the compose default) analyses live while keys, spend
log and budget allow and serves the recorded runs otherwise; `only` serves recorded runs and calls
no live service (no model, Spotify or source call, no key needed); `off` is live only. To stop all
model spending at once, set `REPLAY_MODE=only` and run `dc up -d api`: it recreates the API with
the new setting, and `/api/ready` (as under "First deploy") then shows the provider `not_needed`.

## Rollback

Images are tagged `IMAGE_TAG`, so each release keeps its own; `dc images` shows the running tag.
Back up, then go back to the previous release, web and API together (README, "Order"):

```bash
git checkout <previous commit>    # then IMAGE_TAG=<previous tag> in deploy/.env
dc up -d --no-build               # its images are still here; if they were removed, --build
```

Migrations only go forward: an older API refuses a database a newer release migrated ("Database
schema version N is newer than this code supports" in `dc logs api`); then restore the backup taken
before the deploy, `deploy/scripts/restore.sh deploy/backups/liner-notes-<UTC time>.tar.gz`, losing
the runs since. Never `dc down -v` a deployment: it deletes its volumes, database and spend log.
