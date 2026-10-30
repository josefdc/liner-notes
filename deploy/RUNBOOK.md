# Deploy runbook

Liner Notes on one server behind Cloudflare. The README ("Deploying") explains the stack; this page
is the order of operations. Commands run from the checkout on the server (`/srv/liner-notes` here)
as the deploy user, after `alias dc='docker compose -f deploy/compose.prod.yml'`. Never
`dc down -v` a deployment: it deletes its volumes, database and spend log.

## Two guards

1. **Firewall the origin to the Cloudflare ranges.** Ports 80 and 443 accept only the Cloudflare
   ranges (https://www.cloudflare.com/ips-v4 and /ips-v6), SSH only the operators' addresses. Use
   the Hetzner Cloud Firewall, outside the host: ports Docker publishes bypass `ufw`.
2. **Do not expose the app publicly until the repository is public with its licence, or a written
   source offer exists.** The audio service links Essentia (AGPL-3.0-only): under AGPL §13 every
   network user must be offered the source (the footer's "Source" link). Publishing the repository
   is the owner's call; until then the site stays on 127.0.0.1 (`PROXY_BIND`'s default).

## First deploy (Hetzner, private)

1. **Server.** Hetzner Cloud, x86_64 (the audio image is `linux/amd64` only), 4 GB of memory or
   more (the limits add up to 3.25 GB), Ubuntu LTS, SSH keys only, Docker Engine with compose, a
   `deploy` user in the `docker` group (root-equivalent); attach the firewall first.
2. **Code and settings.** `git clone git@github.com:josefdc/liner-notes.git /srv/liner-notes`
   (with the deploy key, below), `git checkout <release commit>`, then `deploy/.env` (below) with
   `REPLAY_MODE=only`, `CORS_ORIGINS=http://127.0.0.1:3180` and Cloudflare's Turnstile test keys.
3. **Start** (`ssh -L 3180:127.0.0.1:3180` shows the site on your machine) and check readiness:
   ```bash
   dc up -d --build && dc ps                   # every service turns healthy
   dc exec api node -e "fetch('http://127.0.0.1:3001/api/ready').then(r => r.text()).then(console.log)"
   ```
4. **Live analysis**, once the Azure limits below are set: create the spend log, which the API
   needs for any model call (`dc exec api node -e "require('fs').writeFileSync('/app/spend/llm-spend.jsonl', '', { flag: 'wx' })"`),
   set `REPLAY_MODE=fallback` and run `dc up -d api`.

## Go public (only under Guard 2)

1. **Cloudflare.** A proxied **A** record only (compose publishes on IPv4); "Full (strict)" with
   README's "Certificates"; HSTS on; Rocket Loader, Web Analytics' automatic setup and Bot Fight
   Mode's JavaScript detections off (the CSP blocks them); a Turnstile widget for the hostname.
2. **Publish.** In `deploy/.env`: `SITE_ADDRESS` (the hostname), `PROXY_BIND=0.0.0.0`,
   `PROXY_PORT=80`, `PROXY_TLS_PORT=443`, `CORS_ORIGINS=https://<hostname>`, the widget's keys,
   `TURNSTILE_EXPECTED_HOSTNAME`, and `VITE_SOURCE_URL` when the source offer is not the public
   repository. Then `dc up -d --build`.
3. **Check the lock-down** from outside Cloudflare: `curl -m 5 http://<server IP>/` and
   `curl -km 5 https://<server IP>/` must time out, while `https://<hostname>/` answers.

## Deploy a new release

```bash
mkdir -p ~/releases && b=$(deploy/scripts/backup.sh) && cp "$b" "$b.sha256" ~/releases/  # out of KEEP's reach
git fetch && git checkout <release commit>   # then IMAGE_TAG=<its short hash> in deploy/.env
dc up -d --build && dc ps                    # then /api/ready, as above
```

When Cloudflare's ranges change, update `trusted_proxies` (`apps/web/Caddyfile`) and the firewall.

## Secrets

`deploy/.env.example` lists and explains every setting (required, the site, the API's keys):
`cp deploy/.env.example deploy/.env && chmod 600 deploy/.env`, owned by the deploy user, never
committed or printed (nor `dc config`'s output, which holds it). After a change, `dc up -d`;
`VITE_*` are built into the page: `dc up -d --build web`. Outside the file: a read-only GitHub
deploy key (`~deploy/.ssh`), the Origin CA key (README), the backups (what visitors looked up).

## Azure: quota, budget alert, the app's cap

- **The app's cap.** The API reserves each call's worst-case cost in the spend log first. Visitors'
  runs (purpose "dev") stop at `BUDGET_TOTAL_USD` − `BUDGET_EVAL_FLOOR_USD` over the log's whole
  life: $5 with the defaults (25 − 20), so `BUDGET_DAILY_USD` (13.5 a day) never binds them.
  Past it, `fallback` serves only the showcase tracks' recorded runs. To allow more, raise
  `BUDGET_TOTAL_USD` or lower the floor (0 with no evaluations here); never rotate or truncate
  the spend log, since a restore merges its old records back.
- **Budget alert.** The resource group at what this server can spend (`BUDGET_TOTAL_USD` −
  `BUDGET_EVAL_FLOOR_USD`), alerts at 50, 80, 100 %; one ahead of the log: drift, or another client.
- **TPM quota.** Tokens per minute is a rate limit, not a cost limit: give each deployment the
  peak the site needs (`LLM_CONCURRENCY` calls at once, default 2) and no more.
- **Watching it.** `deploy/scripts/spend-log.sh total`: the log's all-time total, as the API counts
  it. `dc exec api node dist/report.js --days 30`: USD per day, from rows retention prunes.

## Backups and restore drill

```bash
deploy/scripts/backup.sh                     # deploy/backups/liner-notes-<UTC time>.tar.gz + .sha256
deploy/scripts/restore.sh --dry-run latest   # checksum and integrity_check; changes nothing
deploy/scripts/restore.sh latest             # asks, stops the API, saves, restores, restarts it
```

`backup.sh` copies the database (`VACUUM INTO`, API running) and the spend log, checks the
archive as a restore would, and keeps the newest `KEEP` (14). A restore first saves the volumes
(`<project>-pre-restore-<time>.tar.gz`, never "latest" or pruned), merges the spend logs (never
below the spend either log records), and restarts the API however it ends. Backup exit 3: the
database is saved, the spend log broke the API's rules and is kept aside; a last line cut by a
crash is moved to `llm-spend.jsonl.torn` by `dc stop api && deploy/scripts/spend-log.sh
repair-tail && dc start api`, then back up again. Cron mails only on failure (`MAILTO`):
`17 3 * * * /srv/liner-notes/deploy/scripts/backup.sh >>/srv/liner-notes/deploy/backups/backup.log 2>&1 || echo "liner-notes backup failed"`

Copy `deploy/backups` off the server encrypted (`restic` to a Storage Box, say), each `.sha256`
beside its archive. Monthly, restore the newest off-site copy into a scratch project with test
values, never `deploy/.env`: the required ones, `IMAGE_TAG`, `REPLAY_MODE=only`,
`AUDIO_FETCH_MODELS=0`, `PROXY_PORT=3480`, `PROXY_TLS_PORT=3481`.

```bash
alias drill='docker compose -p ln-drill --env-file /tmp/drill.env -f deploy/compose.prod.yml'
drill up -d --no-build --wait
BACKUP_DIR=/tmp/ln-drill-backups deploy/scripts/restore.sh --yes --project ln-drill <copy> && drill down -v
```

## Replay switch

`REPLAY_MODE`: `fallback` (the default) analyses live while keys, spend log and budget allow,
else serves the showcase tracks' recorded runs; `only` calls no live service; `off` is live only.
To stop all spending: `REPLAY_MODE=only`, `dc up -d api`; `/api/ready` shows provider `not_needed`.

## Rollback

Each release keeps its images (tagged `IMAGE_TAG`; `dc images`). Go back with web and API together
(README, "Order"): `git checkout <previous commit>`, its `IMAGE_TAG` in `deploy/.env`, `dc up -d
--no-build` (`--build` if its images are gone). Migrations only go forward: an older API refuses
a newer schema ("schema version N is newer than this code supports" in `dc logs api`). Then
restore the pre-deploy copy with the previous image (losing the runs since), then web and API:

```bash
API_IMAGE=liner-notes-api:<previous tag> deploy/scripts/restore.sh ~/releases/liner-notes-<UTC time>.tar.gz
dc up -d --no-build
```
