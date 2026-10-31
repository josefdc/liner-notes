// Starts the API for an eval run and drives one analysis through its HTTP stream, as the web page
// does: a run token with the development bypass, GET /api/analyze/stream, and, when the run
// pauses for the clarification step, GET /api/analyze/stream/resume with the top-ranked
// candidate (the first one sent, which the picker's countdown picks), never the gold ISRC.

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { join } from "node:path";

import { stopServer } from "../../../scripts/stop-server.mjs";
import { REPO_ROOT } from "./golden.mjs";

const API_DIR = join(REPO_ROOT, "apps", "api");
const LISTENING = /"msg":"Liner Notes API listening on port (\d+)"/;
const START_TIMEOUT_MS = 120_000;
const STOP_TIMEOUT_MS = 20_000;
/** The longest one stream (an analysis, or its resume) may stay open. */
export const STREAM_TIMEOUT_MS = 6 * 60_000;

/** The pinned deployments: the app's defaults per tier, so a replay keys its calls the same. */
export const DEPLOYMENTS = {
  AZURE_OPENAI_DEPLOYMENT_FAST: "gpt-6-luna",
  AZURE_OPENAI_DEPLOYMENT_MAIN: "gpt-6-luna",
  AZURE_OPENAI_DEPLOYMENT_RESEARCH: "gpt-6-sol",
  AZURE_OPENAI_DEPLOYMENT_JUDGE: "gpt-6-sol",
  AZURE_OPENAI_DEPLOYMENT_PRO: "gpt-6-sol",
};

/**
 * Settings pinned for every eval start, whatever apps/api/.env says (a variable already in the
 * environment wins over the file, an empty one included): development, the default limits, no
 * tracing, no Turnstile secret (run tokens come with the development bypass), no stored replays.
 */
export function pinnedEnv() {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    LANG: process.env.LANG ?? "C.UTF-8",
    NODE_ENV: "development",
    HOST: "127.0.0.1",
    REPLAY_MODE: "off",
    LLM_PROVIDER: "",
    ...DEPLOYMENTS,
    LLM_TIMEOUT_MS: "",
    MAX_LLM_CALLS_PER_RUN: "",
    LLM_CONCURRENCY: "",
    SOURCE_TIMEOUT_MS: "",
    CORS_ORIGINS: "http://localhost:3140",
    WEB_PORT: "3140",
    TRUST_PROXY: "",
    RATE_LIMIT_WINDOW_MS: "",
    RATE_LIMIT_MAX: "1000",
    RATE_LIMIT_GLOBAL_MAX: "1000",
    SEARCH_RATE_LIMIT_WINDOW_MS: "",
    SEARCH_RATE_LIMIT_MAX: "",
    TURNSTILE_SECRET_KEY: "",
    TURNSTILE_BYPASS: "",
    TURNSTILE_EXPECTED_HOSTNAME: "",
    RUN_TOKEN_SECRET: "",
    SSE_HOLD_MS: "",
    LANGSMITH_TRACING: "",
    LANGSMITH_TRACING_V2: "",
    LANGCHAIN_TRACING_V2: "",
    LANGCHAIN_TRACING: "",
    LLM_ALLOW_TRACING: "",
    OPENAI_CUSTOM_HEADERS: "",
    LOG_LEVEL: "info",
    LOG_IP_SALT: "",
    RUN_RETENTION_DAYS: "",
    RUN_EVENT_RETENTION_DAYS: "",
    STORE_RETENTION_DAYS: "",
    CHECKPOINT_RETENTION_HOURS: "",
    npm_config_update_notifier: "false",
  };
}

/**
 * Starts the API (`node --import tsx src/index.ts` in apps/api, the command `npm start` runs,
 * with the contract already built) with exactly `env`, its output appended to `logPath`. Resolves
 * once it listens, with { port, stop }.
 */
export async function startApi(env, logPath) {
  const out = createWriteStream(logPath, { flags: "a" });
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: API_DIR,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const take = (chunk) => {
    out.write(chunk);
    if (output.length < 1_000_000) output += chunk;
  };
  child.stdout.on("data", take);
  child.stderr.on("data", take);
  const closed = new Promise((resolveClose) => {
    child.on("close", (code) => resolveClose(code));
    child.once("error", () => resolveClose(null));
  });
  const stop = async () => {
    const result = await stopServer({
      group: child.pid,
      pid: child.pid,
      closed,
      timeoutMs: STOP_TIMEOUT_MS,
    });
    await new Promise((r) => out.end(r));
    return result;
  };
  const port = await new Promise((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error("the API did not start")), START_TIMEOUT_MS);
    const poll = setInterval(() => {
      const match = output.match(LISTENING);
      if (match) {
        clearInterval(poll);
        clearTimeout(timer);
        resolvePort(Number(match[1]));
      }
    }, 100);
    closed.then((code) => {
      clearInterval(poll);
      clearTimeout(timer);
      reject(new Error(`the API exited with ${code} before listening (log: ${logPath})`));
    });
  }).catch(async (error) => {
    await stop();
    throw error;
  });
  return { port, stop, pid: child.pid };
}

async function runToken(base) {
  const res = await fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ turnstileToken: "dev-bypass" }),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status !== 200) throw new Error(`POST /api/runs answered ${res.status}`);
  return (await res.json()).runToken;
}

/** Every event of one stream (heartbeats left out), read until it ends. */
async function readStream(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(STREAM_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${new URL(url).pathname} answered ${res.status}`);
  const events = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    for (let end = text.indexOf("\n\n"); end !== -1; end = text.indexOf("\n\n")) {
      for (const line of text.slice(0, end).split("\n")) {
        if (!line.startsWith("data:")) continue;
        const event = JSON.parse(line.slice(5));
        if (event.type !== "heartbeat") events.push(event);
      }
      text = text.slice(end + 2);
    }
  }
  return events;
}

/**
 * One analysis of `query`: its events, and the resume's when the clarification step fired.
 * Returns { runId, events, resumed: { candidates, chosen } | null }.
 */
export async function analyse(port, query) {
  const base = `http://127.0.0.1:${port}`;
  const token = await runToken(base);
  const tokenParam = `runToken=${encodeURIComponent(token)}`;
  const first = await readStream(
    `${base}/api/analyze/stream?query=${encodeURIComponent(query)}&${tokenParam}`,
  );
  const runId = first[0]?.runId ?? null;
  const pause = first.find((e) => e.type === "interrupt");
  if (!pause) return { runId, events: first, resumed: null };
  const chosen = pause.candidates[0];
  if (!chosen) return { runId, events: first, resumed: { candidates: 0, chosen: null } };
  const params = new URLSearchParams({
    threadId: pause.threadId,
    selectedTrackId: chosen.id,
    pickedBy: "countdown",
  });
  const second = await readStream(
    `${base}/api/analyze/stream/resume?${params.toString()}&${tokenParam}`,
  );
  return {
    runId,
    events: [...first, ...second],
    resumed: {
      candidates: pause.candidates.length,
      chosen: { id: chosen.id, title: chosen.title ?? null, artist: chosen.artist ?? null },
    },
  };
}
