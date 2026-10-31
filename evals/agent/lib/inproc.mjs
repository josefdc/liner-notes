// The app's model layer in this process, for the harnesses that call one step directly (the
// model-only baseline and the perturbation judge) instead of running the whole pipeline.
//
// The settings are the app's: config/env.ts loads apps/api/.env (this file never reads it) and
// stops the process when they are invalid. What an eval must not leave to that file is set here
// first, since a variable already in the environment wins over the file: development, the pinned
// deployments, the cassette mode and directory, the spend log, the purpose and no tracing.

import { DEPLOYMENTS } from "./api.mjs";
import { importApp } from "./app.mjs";

/** Dummy credentials for a replay: no live client may be built from a real key. */
const REPLAY_KEYS = {
  AZURE_OPENAI_API_KEY: "dummy-azure-key",
  AZURE_OPENAI_ENDPOINT: "https://dummy-resource.openai.azure.com/",
  AZURE_OPENAI_BASE_URL: "",
  SPOTIFY_CLIENT_ID: "dummy-spotify-client-id",
  SPOTIFY_CLIENT_SECRET: "dummy-spotify-client-secret",
};

/**
 * Sets the eval's settings and loads the app's: { cassette: "record" | "replay", cassetteDir,
 * spendLog, purpose }. Returns the app modules the harnesses use.
 */
export async function appModelLayer({ cassette, cassetteDir, spendLog, purpose }) {
  Object.assign(process.env, {
    NODE_ENV: "development",
    REPLAY_MODE: "off",
    LLM_PROVIDER: "",
    ...DEPLOYMENTS,
    LLM_TIMEOUT_MS: "",
    MAX_LLM_CALLS_PER_RUN: "",
    LLM_CONCURRENCY: "",
    LLM_CASSETTE: cassette,
    LLM_CASSETTE_DIR: cassetteDir,
    LLM_SPEND_LOG: spendLog,
    LLM_RUN_PURPOSE: purpose,
    LANGSMITH_TRACING: "",
    LANGSMITH_TRACING_V2: "",
    LANGCHAIN_TRACING_V2: "",
    LANGCHAIN_TRACING: "",
    LLM_ALLOW_TRACING: "",
    OPENAI_CUSTOM_HEADERS: "",
    LOG_LEVEL: "warn",
    ...(cassette === "replay" ? REPLAY_KEYS : {}),
  });
  await importApp("apps/api/src/config/env.ts");
  const [invoke, runtime] = await Promise.all([
    importApp("apps/api/src/llm/invoke.ts"),
    importApp("apps/api/src/agent/runtime.ts"),
  ]);
  return { llm: invoke.llm, agentRuntime: runtime.agentRuntime };
}
