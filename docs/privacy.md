# Privacy

What a Liner Notes deployment keeps about the people who use it, for how long, and what it sends
to other services. Each point names the code it comes from. The site has no accounts and
no analytics, and the API sets no cookies.

## What is stored

The API keeps one SQLite database (`SQLITE_DB_PATH`; tables in `apps/api/src/store/migrations.ts`):

- **Runs** (`runs`): one row per analysis, with the text the visitor typed (`query`), the run's
  status and times, the result it produced and the evidence it cited, and the commit of the code
  that ran it.
- **Run events** (`run_events`): the server-sent events each run's stream sent, kept so a recent
  run can be recorded as a replay.
- **Model usage** (`llm_usage`): per model call, the run it belongs to, the tier and deployment,
  tokens, estimated cost, latency and status. No prompt or answer text.
- **Stored results** (`store_items`, LangGraph's store): a track's latest result, served again
  to the next visitor who asks for the same track. They are keyed by track, not by visitor. Choices
  remembered across visitors were removed (schema version 8).
- **Checkpoints** (LangGraph's SQLite saver, `apps/api/src/store/checkpointer.ts`): the state of
  a run in progress, so it can resume after the track picker. Preview links are removed before a
  checkpoint is written, with one known exception: the percent-encoded clip link a failed
  download's detail can hold ([README, "Known limitations"](../README.md#known-limitations)) is
  kept in the run's checkpoint until the checkpoint is deleted. The link is a
  signed CDN URL that expires in about 15 minutes.
- **Caches** (`audio_cache`, `research_cache`, `artwork_cache`, `musicbrainz_recording_cache`):
  measurements and source answers about tracks, never about visitors. No preview link is stored
  (`artwork_cache.preview_url` is always null since schema version 6).
- **Retention state** (`retention_state`): the last cutoff applied, so the run report can mark
  pruned days.

No table has a column for an IP address or any other identifier of a visitor.

The spend log (`LLM_SPEND_LOG`, `apps/api/src/llm/spendLog.ts`) holds one line per model call
(time, deployment, tokens, estimated cost, tier, call site and run id). It holds no query text
and is never pruned: it is the record of spend.

## How long it is kept

The API deletes old data at start and then every hour (`apps/api/src/store/retention.ts`):

| what | kept for | setting |
| --- | --- | --- |
| runs, with the typed query and the result | 30 days after the run finished (or started, if it never finished) | `RUN_RETENTION_DAYS` |
| run events | 7 days after they were sent, never longer than the runs | `RUN_EVENT_RETENTION_DAYS` |
| model usage rows | with their run; 30 days for a row with no run | `RUN_RETENTION_DAYS` |
| checkpoints | 24 hours after the thread was last active; a run waiting at the track picker until it is older than the run retention | `CHECKPOINT_RETENTION_HOURS` |
| stored items | 30 days after their last update | `STORE_RETENTION_DAYS` |

Within those, a stored result is served for at most 24 hours (`STORED_RESULT_TTL_MS`,
`apps/api/src/agent/storedResults.ts`). The caches expire on their own: a high-confidence audio
measurement after 30 days and a low-confidence one after 24 hours, research answers after
48 hours, artwork lookups after 7 days (`apps/api/src/store/cache.ts`,
`apps/api/src/store/measuredAudio.ts`, `apps/api/src/agent/research/runEvidence.ts`).

## Addresses and logs

- **API log.** Request lines carry `ipHash`, an HMAC-SHA256 of the client address keyed by
  `LOG_IP_SALT` (or by a key the process makes for itself), cut to 16 hex digits
  (`ipHash`, `apps/api/src/logger.ts`). The address itself, query strings, `User-Agent` and
  `Referer` are not written. The typed text is written at debug level only; at info and above
  only its length is. Configured keys and tokens, the model endpoint and preview links are
  scrubbed from every line.
- **Rate limits.** `express-rate-limit` counts requests per client address in the API process's
  memory (its default store: `apps/api/src/http/middleware/rateLimit.ts` sets no other) for the
  length of each window. The raw address is held there only, never written to disk.
- **Caddy** (the web image) logs addresses shortened to their network, and writes the typed text
  and the run token as `REDACTED` or not at all ([README, "Client addresses"](../README.md#deploying)).
- `npm run test:replay` checks the API's log for IP addresses, query strings, the typed query and
  the configured keys, and fails if it finds one.

## What other services see

- **Cloudflare's proxy**, in the deployment the runbook describes (`deploy/RUNBOOK.md`), sits in
  front of the site: it terminates TLS and sees every request, with the visitor's address, the
  typed text in `?query=` and the run token. Caddy takes the visitor's address from its
  `CF-Connecting-IP` header (`apps/web/Caddyfile`, `trusted_proxies`).
- **Cloudflare Turnstile** sees the visitor's browser when it asks for a run token
  (`POST /api/runs`), and the API sends it the visitor's address with the token it checks
  (`remoteip` in `apps/api/src/http/turnstile.ts`, from `routes/runTokens.ts`).
- **Spotify** receives the text the visitor typed, from the API and not with the visitor's
  address: as it is typed, through the suggestions route (`GET /api/search/suggest`,
  `searchTracks` in `apps/api/src/http/routes/search.ts`), and as a search query when a run
  starts (the scout, `apps/api/src/agent/nodes/scoutNode.ts`). When live analysis is refused
  (`REPLAY_MODE=only`, no Spotify keys, or the model budget spent), the suggestions come from the
  recorded runs and Spotify is not asked.
- **The other music and search sources** (Deezer, MusicBrainz and the Cover Art Archive,
  Last.fm, Genius, ListenBrainz, SecondHandSongs, Discogs and Tavily) receive track titles,
  artists and identifiers from the API, not the visitor's address.
- **Azure OpenAI** receives the prompts: the chosen track and the evidence gathered for it. The
  typed text is not part of them.
- **A tracing service** (LangSmith) receives prompts and answers only if an operator turns
  LangChain/LangSmith tracing on. It is off by default, and the API refuses every model call
  while it is on unless `LLM_ALLOW_TRACING=1` is also set (`apps/api/.env.example`,
  `assertProviderConfigured` in `apps/api/src/llm/factory.ts`).
- **The browser** loads cover images from the Cover Art Archive or Spotify, the Player's clip
  from Deezer, and the map's preview clips from Deezer or Spotify, directly: those services see
  the visitor's address.

The licences and terms of these services are in [NOTICE](../NOTICE).
