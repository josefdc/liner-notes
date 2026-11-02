// The environment of an API started to serve replays only, with outbound network denied:
// REPLAY_MODE=only, tests/deny-network.mjs preloaded in every node process (NODE_OPTIONS), dummy
// Spotify, model and source keys, and every setting the API reads pinned (most to its default),
// so a developer's settings file in apps/api changes nothing that is set here. Used by
// scripts/replay-e2e.mjs and scripts/readme-shots.mjs.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The API's environment. `scratch` holds its database and spend log; `report` is the
 * deny-network report and `logFile` the API's log; `corsOrigins` the origins it answers.
 */
export function replayApiEnv({ scratch, report, logFile, corsOrigins = "http://localhost:3000" }) {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? scratch,
    NODE_OPTIONS: `--import ${join(ROOT, "tests", "deny-network.mjs")}`,
    DENY_NETWORK_REPORT: report,
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
    NODE_ENV: "development",
    REPLAY_MODE: "only",
    REPLAY_DIR: join(ROOT, "fixtures", "replays"),
    HOST: "127.0.0.1",
    PORT: "0",
    SQLITE_DB_PATH: join(scratch, "api.db"),
    // Dummy keys: were any live client built, it would try the network and be counted.
    SPOTIFY_CLIENT_ID: "dummy-spotify-client-id",
    SPOTIFY_CLIENT_SECRET: "dummy-spotify-client-secret",
    AZURE_OPENAI_API_KEY: "dummy-azure-key",
    AZURE_OPENAI_ENDPOINT: "https://dummy-resource.openai.azure.com/",
    AZURE_OPENAI_BASE_URL: "",
    LLM_PROVIDER: "",
    LLM_CASSETTE: "off",
    LLM_SPEND_LOG: join(scratch, "spend.jsonl"),
    SOURCE_CASSETTE: "",
    GEMINI_API_KEY: "dummy-gemini-key",
    TAVILY_API_KEY: "dummy-tavily-key",
    LASTFM_API_KEY: "dummy-lastfm-key",
    DISCOGS_TOKEN: "dummy-discogs-token",
    SHS_API_KEY: "dummy-shs-key",
    GENIUS_ACCESS_TOKEN: "dummy-genius-token",
    AUDIO_ANALYSIS_URL: "http://dummy-audio.invalid:3002",
    // Pinned to their defaults, so a settings file cannot change what is checked.
    CORS_ORIGINS: corsOrigins,
    TRUST_PROXY: "",
    RATE_LIMIT_WINDOW_MS: "",
    RATE_LIMIT_MAX: "",
    RATE_LIMIT_GLOBAL_MAX: "",
    SEARCH_RATE_LIMIT_WINDOW_MS: "",
    SEARCH_RATE_LIMIT_MAX: "",
    // Development without a Turnstile secret: run tokens come with the bypass ("dev-bypass").
    TURNSTILE_SECRET_KEY: "",
    TURNSTILE_BYPASS: "",
    TURNSTILE_EXPECTED_HOSTNAME: "",
    RUN_TOKEN_SECRET: "",
    SSE_HOLD_MS: "",
    LANGSMITH_TRACING: "",
    LANGSMITH_TRACING_V2: "",
    LANGCHAIN_TRACING_V2: "",
    LANGCHAIN_TRACING: "",
    OPENAI_CUSTOM_HEADERS: "",
    LOG_LEVEL: "info",
    LOG_FILE: logFile,
    LOG_IP_SALT: "",
    RUN_RETENTION_DAYS: "",
  };
}
