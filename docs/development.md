# Development

Three services run side by side: the web app, the API and the audio service.

## Prerequisites

- Node.js 24 or later, with npm 11.18 or later (it enforces the install-script allowlist in `.npmrc`)
- Python 3.12+
- [uv](https://docs.astral.sh/uv/) (Python package manager)

## 1. Install Dependencies

```bash
# Web app, API and shared packages (npm workspaces, one lockfile)
npm ci

# Python audio service
cd services/audio && uv sync
```

## 2. Environment Variables

```bash
cp apps/api/.env.example apps/api/.env
chmod 600 apps/api/.env
```

Edit `apps/api/.env` with your keys. The API refuses to start without the Spotify pair. Every
variable `apps/api/.env.example` lists, where it explains each one in full:

| variable | what it sets |
| --- | --- |
| `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` | required; from the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard). With `REPLAY_MODE=only` Spotify is never called and any value starts the API |
| `LLM_PROVIDER` | the model provider: `azure` (default); `gemini` is not implemented and refuses every call |
| `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT` | the Azure OpenAI resource's key and root URL (`https://<resource>.cognitiveservices.azure.com/`); calls use its v1 API |
| `AZURE_OPENAI_BASE_URL`, `AZURE_OPENAI_API_VERSION` | a v1 base URL used instead of the endpoint's; the API version is accepted and not used |
| `AZURE_OPENAI_DEPLOYMENT_FAST`, `_MAIN`, `_RESEARCH`, `_JUDGE`, `_PRO` | the deployment of each tier (fast: scout, classification, research planner; main: composer; research: summaries; judge: verifier). `_PRO` is the fallback for research and judge, and `_FAST` for main. Defaults `gpt-6-luna` for fast and main, `gpt-6-sol` for research and judge |
| `LLM_SPEND_LOG` | absolute path of the spend log (JSONL) shared by every process; live model calls are refused while it is unset or missing. Create it once with `npm run smoke:llm -w apps/api -- --init` |
| `BUDGET_TOTAL_USD`, `BUDGET_DAILY_USD`, `BUDGET_EVAL_FLOOR_USD`, `BUDGET_EVAL_GOLDEN_USD`, `BUDGET_EVAL_BASELINE_USD`, `BUDGET_EVAL_PERTURB_USD`, `BUDGET_EVAL_VARIANCE_USD` | budget caps in USD over the spend log: total, per UTC day, the evaluation floor and each evaluation's own cap |
| `LLM_TIMEOUT_MS`, `MAX_LLM_CALLS_PER_RUN`, `LLM_CONCURRENCY` | one attempt's timeout, model calls per analysis, calls in flight per process |
| `LLM_CASSETTE`, `LLM_CASSETTE_DIR` | record or replay model answers (tests and evals only; refused in production) |
| `SOURCE_CASSETTE`, `SOURCE_CASSETTE_DIR` | the same for the music and search sources and the audio service |
| `LLM_RUN_PURPOSE` | the evaluation an API process runs for (`eval:golden`, `eval:baseline`, `eval:perturb`, `eval:variance`), and the cap it spends from |
| `LLM_ALLOW_TRACING` | `1` allows live calls while LangChain/LangSmith tracing is on; they are refused otherwise |
| `TAVILY_API_KEY` | [Tavily](https://tavily.com/) web search |
| `SOURCE_USER_AGENT` | optional: the `User-Agent` sent to the sources, as `AppName/Version ( contact )`; defaults to this project |
| `LASTFM_API_KEY` | [Last.fm](https://www.last.fm/api/account/create) genre tags and similar tracks |
| `DISCOGS_TOKEN` | optional: a Discogs personal access token, for release credits |
| `SHS_API_KEY` | optional in the code, but without it SecondHandSongs refused every request in the evaluation (HTTP 403) |
| `GENIUS_ACCESS_TOKEN` | optional: a Genius client access token, for song relationships (never lyrics) |
| `AUDIO_ANALYSIS_URL` | the audio service, `http://localhost:3002` in development |
| `PORT`, `HOST` | the API's port (3001) and address (127.0.0.1) |
| `LOG_LEVEL`, `LOG_FILE`, `LOG_IP_SALT` | log level, an optional file for the JSON lines, and the key of the hashed client addresses ([privacy](privacy.md)) |
| `REPLAY_MODE`, `REPLAY_DIR` | `off` (default), `fallback` or `only`, and the directory of the recorded runs (`fixtures/replays`) |
| `CORS_ORIGINS` | the browser origins allowed to call the API; unset in development, the local web ports |
| `RUN_TOKEN_SECRET`, `TURNSTILE_SECRET_KEY`, `TURNSTILE_EXPECTED_HOSTNAME`, `TURNSTILE_BYPASS` | run tokens and the Cloudflare Turnstile check behind them; both secrets are required in production (see [Deployment](deployment.md)) |
| `SSE_HOLD_MS` | development and tests only: hold a replayed stream open before its first event |
| `TRUST_PROXY` | how many reverse proxies in front of the API are trusted for the client address |
| `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`, `RATE_LIMIT_GLOBAL_MAX`, `SEARCH_RATE_LIMIT_WINDOW_MS`, `SEARCH_RATE_LIMIT_MAX` | per-address and global rate limits |
| `SQLITE_DB_PATH` | the database (default `data/sonic-agent.db` in `apps/api`) |
| `CHECKPOINT_RETENTION_HOURS`, `STORE_RETENTION_DAYS`, `RUN_RETENTION_DAYS`, `RUN_EVENT_RETENTION_DAYS` | how long checkpoints, stored items, runs and run events are kept ([privacy](privacy.md)) |

`npm run smoke:llm -w apps/api` makes one small call per tier through the provider layer and
prints status, latency, tokens and estimated cost; it spends from the budget like any other call.
To run with no real key, set `REPLAY_MODE=only` (any Spotify values): the showcase tracks are
served from their recordings, and any other query is refused.

The model tiers, budget caps, cassettes and limits are documented in `apps/api/.env.example`.

## 3. Run All Services

```bash
npm run dev
```

This starts the web app (port 3000), the API (port 3001) and the audio service (port 3002).
Override the ports with `WEB_PORT`, `API_PORT` and `AUDIO_PORT`, or pick services with
`DEV_SERVICES=web,api`. Each service can also run alone: `npm run dev -w apps/web`,
`npm run dev -w apps/api`, `npm run dev -w services/audio`.

The web app calls the API at `/api` on its own origin, and the Vite dev server forwards those
requests to the API on `API_PORT` (default 3001), or to `API_PROXY_TARGET` when set (an http(s)
origin such as `http://192.168.1.20:3001`, for an API running elsewhere). A build can point the web app elsewhere with
`VITE_API_URL`, the API's root URL including `/api` (see `apps/web/.env.example`); the web
image is built with `VITE_API_URL=/api` and its Caddy forwards `/api/*` to the API. A value that
cannot work (`api`, or an absolute URL without a path) stops the build with an error.
`VITE_SOURCE_URL` sets where the footer's "Source" link points (default
`https://github.com/josefdc/liner-notes`): a build of a modified version should point it at its
own source.

The web dev server listens on loopback only. `WEB_HOST=0.0.0.0 npm run dev` serves it on the
network (to try it from a phone, say); anyone who can reach that port can then also start
analyses through the `/api` proxy, on your model budget.

The audio service needs [uv](https://docs.astral.sh/uv/); without it, run
`DEV_SERVICES=web,api npm run dev`.

Then open http://localhost:3000

## 4. Checks

```bash
npm run lint           # Biome (lint + formatting); `npm run format` rewrites files
npm run typecheck      # TypeScript in every workspace
npm run guard:honest   # ratcheted counts (see below); lower the baselines with -- --update
npm run check:release-age -- --base origin/main   # changed lock entries are releases at least 14 days old
npm test               # Vitest: API, web and script tests
node --test 'evals/**/*.test.mjs'   # the evaluation scripts' tests (no network, no model)
npm run check:links    # relative links and #anchors in the tracked Markdown files (offline)
node evals/agent/kinds.mjs --check  # docs/evaluation.md's chart and evals/reports/agent-kinds.md match the run records
npm run build && npm run check:css   # the built CSS is Tailwind output with no invalid values
npm run test:e2e       # Playwright against a development build of the web app served by vite preview with a mocked API (Google Chrome; PLAYWRIGHT_WEB_PORT, default 3290)
npm run test:visual    # the visual baselines, in the pinned Playwright container (Docker)
cd services/audio && uv run ruff check . && uv run ruff format --check .
cd services/audio && uv run pytest -q
```

The visual baselines (`tests/web/visual.spec.ts`) compare the search, the track picker, the
Dashboard, the Player and the song-relations map, at rest and with a track selected, drawn from the
mock fixtures at 768, 1024, 1280, 1380, 1440 and 1680 px and at device pixel ratio 1 and 2, and the
parts of the Dashboard and the Player below the fold at 768, 1024 and 1440 px, with the PNGs in
`tests/web/__screenshots__/`. `npm run test:visual` runs them in the Playwright image pinned by
digest (its linux/amd64 manifest) in `scripts/visual.mjs`, the one CI's visual job runs in, with
the checkout mounted. It needs Linux on x64 and Docker, and `npm ci` run first: the mounted
`node_modules` must hold the linux-x64 builds of esbuild, rollup and lightningcss, and an arm64
image draws differently. After a change that is meant to change a view, run
`npm run test:visual:update`, look at the PNGs it rewrote and commit them. Off Linux x64, push
the change and take the `*-actual.png` files from the `visual-report` artifact of CI's failed
visual job (drawn by the same image), look at them, and copy each over its baseline in
`tests/web/__screenshots__/visual.spec.ts/` without the `-actual` in its name. Baselines come
only from that image: the `visual` project exists only in its container (`PLAYWRIGHT_VISUAL=1`
stops any other run), and a baseline drawn by another browser, or outside the container, would
not match CI's.

The honesty guard (`scripts/guard-honest.mjs`) counts patterns that may only go down: placeholder
data (random values, stock images, unscoped colours), the prototype's old copy and product name, and
emoji in progress and log messages, in the source and in the messages of the recorded runs
(`fixtures/replays`). Each count fails CI if it rises above its baseline in `scripts/guard-baseline.json`.

Dependencies take only releases that are at least 14 days old, a rolling window by publish time:
`min-release-age=14` in `.npmrc` for npm and `exclude-newer = "14 days"` for uv in the audio
service. npm applies the setting only when it resolves a version (npm ci installs what the lock
names wherever it still agrees with `package.json`), so add or update packages with `npm install`
and do not edit `package-lock.json` by hand.

`npm run check:release-age -- --base <ref>` (`scripts/check-release-age.mjs`) guards against that
mistake: a lock edited by hand, or resolved without the setting, that brings in a release too new.
It is not a security boundary against a change written to defeat it, which could as well edit the
CI workflow.

It compares the lock npm ci would use (`npm-shrinkwrap.json` if there is one, else
`package-lock.json`) with the one npm would have used at `<ref>`. While both files exist,
`package-lock.json` is also compared with `package-lock.json` at `<ref>`, so it cannot change
unchecked and take over when the shrinkwrap is removed. An entry counts as changed when it is new
or its version, resolved URL, integrity, name, link, bundle or `hasShrinkwrap` flag changed. A
changed entry fails if its `name` field is not a package name npm accepts (its rule for old
packages, which allows a leading `_` in a scope and `!'()*`), or if it has `hasShrinkwrap`
(npm then installs what the package's own shrinkwrap names). Otherwise it must be one of:

- an `https://registry.npmjs.org/<name>/-/<basename>-<version>.tgz` tarball (`<basename>` is the
  name without its scope) whose name and semver version match the entry (its `version`, and its
  `name` field or else its path), with an integrity in the lock; bundled (`inBundle`) entries
  with a resolved URL are checked the same way;
- an entry with no resolved URL but a semver version and an integrity, which npm resolves again
  as that version;
- a bundled (`inBundle`) entry with no resolved URL and no integrity, when the nearest entry above
  it that is not bundled is new or changed here, and so checked: its bytes come from that tarball;
- a workspace package, or a link to one of the `workspaces` at `<ref>` (in its lock's root entry or
  its `package.json`) or in the working tree's `package.json`, which npm ci reads (no check
  needed). A workspace that only the working tree's `package.json` declares must be a local folder
  whose entry has no resolved URL and no integrity, and its link must have no integrity; otherwise
  it fails. The `workspaces` in the lock's own root entry are never used for this.

A release passes when npmjs lists a publish time for its version at least the minimum age before
the check, and the lock's integrity agrees with the one npmjs lists for that version
(`dist.integrity`, and `dist.shasum` as `sha1-`): every token must be a hash, of an algorithm npmjs
lists for that version, and every hash must match. Anything else fails (exit 1): git, codeload,
`file:`, `http:` or other-host tarballs, links to other folders, an entry that disagrees with its
tarball, a missing integrity or one that differs from npmjs's, a bundled entry with no resolved URL
and no integrity under a package whose tarball is not checked here (unchanged, a workspace, or
not a registry release; if that package does not bundle it after all, npm resolves it with nothing
to verify it against), a version that is not semver or has no publish time, or a release that is
too new (named with its version, publish time and age). The hint to resolve the lock again with npm and its `min-release-age` is printed only for failures
that doing so can fix (a release too new, or an entry that disagrees with npmjs or lacks an
integrity); any other failure gets a note that the change must be undone or approved.

Two more things fail, even with an unchanged lock:

- a change to npm's registry settings in `.npmrc` (`registry`, `<scope>:registry`,
  `replace-registry-host`), which decide where npm ci fetches the tarballs from. A maintainer
  changes them on the base branch, past this check;
- a dependency spec in the root or a workspace `package.json` (`dependencies`, `devDependencies`,
  `optionalDependencies`, `peerDependencies`, `overrides`) that is not a registry range, a tag, an
  `npm:` alias of one, a `$name` override reference to a dependency the root `package.json`
  declares, or a `file:` path to a workspace folder (a `workspace:` spec is let through: npm does
  not support it and stops). npm ci resolves a spec the lock no longer satisfies again, outside the
  lock, so a git or URL dependency would escape the age rule.

What it does not cover:

- other `.npmrc` settings that change where the bytes come from or how they are fetched:
  proxies, `userconfig` and `globalconfig`, CA and TLS settings;
- `workspaces` patterns other than plain names, `*` and `**` (braces, `[]`, `?` and negation);
- `min-release-age-exclude[]` and `before`: a release npm would let through because of them still
  fails here;
- a dependency published with a shrinkwrap (`hasShrinkwrap`): it fails, and a maintainer must
  approve it;
- in CI, when the commit before a push to `main` cannot be fetched (after a force-push, or in a
  private repository without credentials), the job compares with the parent commit, with a
  notice, so it checks only the last commit of that push.

The minimum age is the largest of 14 days and `min-release-age` in `.npmrc` at `<ref>` and in the
working tree (a `min-release-age[]` list counts by its largest value, which can only be stricter
than npm), so a change cannot lower it for itself. Publish times and integrities come from
registry.npmjs.org whatever npm's settings say (`--registry <url>` overrides it). The check exits 2
when it cannot run: an unknown base, an unreadable lock, `package.json` or `.npmrc`, or a registry
it cannot read within three attempts per package and three minutes in all. An unchanged lock with
unchanged registry settings makes no registry request. CI runs it in its own job, against the
parent commit on a pull request and against the commit before the push on `main`.

CI runs the same checks on every pull request (`.github/workflows/ci.yml`).

## README images

The screenshots in `docs/images` are taken from the showcase replays by
`node scripts/readme-shots.mjs --covers` (it starts the API with `REPLAY_MODE=only` and dummy keys,
and the web app, on free local ports, with outbound network denied, apart from the Cover Art
Archive's images; see the script's header). The animation is `node scripts/demo-gif.mjs`
([the static demo](static-demo.md)).
