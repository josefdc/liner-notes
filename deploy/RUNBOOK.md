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
mkdir -p ~/releases && b=$(deploy/scripts/backup.sh); cp "$b" "$b.sha256" ~/releases/  # out of KEEP's reach, even on exit 3
git fetch && git checkout <release commit>   # then IMAGE_TAG=<its short hash> in deploy/.env
dc up -d --build && dc ps                    # then /api/ready, as above
# When Cloudflare's ranges change: trusted_proxies in apps/web/Caddyfile, and the firewall.
```

## Secrets

`deploy/.env.example` explains every setting: `cp deploy/.env.example deploy/.env && chmod 600
deploy/.env`, owned by the deploy user, never committed or printed (nor `dc config`'s output).
After a change, `dc up -d`; `VITE_*` are built into the page: `dc up -d --build web`. Outside the
file: a read-only deploy key (`~deploy/.ssh`), the Origin CA key (README), the backups.

## Azure: quota, budget alert, the app's cap

- **The app's cap.** The API reserves each call's worst-case cost in the spend log first. Visitors'
  runs (purpose "dev") stop at `BUDGET_TOTAL_USD` − `BUDGET_EVAL_FLOOR_USD` over the log's whole
  life: $5 with the defaults (25 − 20), so `BUDGET_DAILY_USD` (13.5 a day) never binds them. To
  allow more, raise the total or lower the floor (0 with no evaluations here); never rotate or
  truncate the spend log (a restore merges old records back). Past it, `fallback` replays only.
- **Budget alert.** The resource group at what this server can spend (`BUDGET_TOTAL_USD` −
  `BUDGET_EVAL_FLOOR_USD`), alerts at 50, 80, 100 %; one ahead of the log: drift, or another client.
- **TPM quota.** A rate limit, not a cost limit: each deployment gets the peak the site needs
  (`LLM_CONCURRENCY` calls at once, default 2) and no more.
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
below the spend either log records), and starts the API again after a failure or an interrupt.
Backup exit 3: the database is saved; the spend log broke the API's rules and is kept aside as
`llm-spend.jsonl.invalid`. `dc stop api && deploy/scripts/spend-log.sh repair-tail && dc start api`
moves a line cut by a crash to `llm-spend.jsonl.torn`; then back up again. Such a backup restores
into a volume with no spend log only after `tar -xzf <backup> llm-spend.jsonl.invalid` and, API
stopped, `spend-log.sh place llm-spend.jsonl.invalid`. Cron mails failures only, through `MAILTO`
and a mail relay (an MTA such as `msmtp-mta`), or point the echo at another alert route:
`17 3 * * * /srv/liner-notes/deploy/scripts/backup.sh >>/srv/liner-notes/deploy/backups/backup.log 2>&1 || echo "liner-notes backup failed"`

Copy `deploy/backups` off the server encrypted (`restic` to a Storage Box, say), each `.sha256`
beside its archive. Monthly, restore the newest off-site copy into a scratch project (another
Docker host, or a quiet hour) with test values, never `deploy/.env`: the required ones,
`IMAGE_TAG`, `REPLAY_MODE=only`, `AUDIO_FETCH_MODELS=0` (an exit-3 copy needs `place`, above).

```bash
alias drill='docker compose -p ln-drill --env-file /tmp/drill.env -f deploy/compose.prod.yml'
drill up -d --no-build --wait api           # the API and the audio service only
BACKUP_DIR=/tmp/ln-drill-backups deploy/scripts/restore.sh --yes --project ln-drill <copy>
drill exec api node dist/report.js --days 30 && drill down -v   # the restored runs, then away
```

## Replay switch

`REPLAY_MODE`: `fallback` (the default) analyses live while keys, spend log and budget allow,
else serves the showcase tracks' recorded runs; `only` calls no live service; `off` is live only.
To stop all spending: `REPLAY_MODE=only`, `dc up -d api`; `/api/ready` shows provider `not_needed`.

## Rollback

Each release keeps its images (`IMAGE_TAG`; `dc images`). Go back with web and API together (README,
"Order"): `git checkout <previous commit>`, its `IMAGE_TAG` in `deploy/.env`, `dc up -d --no-build`
(`--build` if its images are gone). An older API refuses a newer schema ("schema version N is newer
than this code supports" in `dc logs api`): restore the pre-deploy copy with the previous image:

```bash
API_IMAGE=liner-notes-api:<previous tag> deploy/scripts/restore.sh ~/releases/<backup>.tar.gz  # <IMAGE_PREFIX>-api if set
dc up -d --no-build                          # web and API on the same release; runs since are lost
```
