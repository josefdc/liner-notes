#!/usr/bin/env node
// End-to-end check of replay mode with outbound network denied:
//
//   npm run test:replay
//
// Starts the API as `npm start -w apps/api` with REPLAY_MODE=only, tests/deny-network.mjs
// preloaded in every node process (NODE_OPTIONS), dummy Spotify, model and source keys, a
// scratch database and every setting the checks rely on pinned (so a developer's apps/api/.env
// changes nothing), then checks over HTTP:
//
//   A1  a recorded track's stream is a full replay: connected ... complete, done, every event
//       valid, the result says mode "replay" with recordedAt and commit, for this run's id;
//       a query with no recording gets error live_disabled, then done
//   A3  search suggestions come from the recordings ("dyn" matches none, "daft" the dev record)
//   A4  after a replay for a distinctive typed query, GET /api/runs/by-track/<id> serves that
//       run with mode "replay", and the body does not contain the typed text
//   and "more facts" for the recorded track come from the recording (POST and stream); another
//   track's are refused with live_disabled; POST /api/analyze replays or refuses the same way;
//   both resume routes are refused; HEAD on the stream answers.
//
// Last, it stops the API and requires every process to report 0 outbound attempts.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PRELOAD = join(ROOT, "tests", "deny-network.mjs");
const FIXTURES = join(ROOT, "fixtures", "replays");

const TRACK_ID = "0DiWol3AO6WpXZgp0goxAV";
const SHOWCASE_QUERY = "One More Time Daft Punk";
const TYPED_QUERY = "DAFT punk: one MORE time";
const START_TIMEOUT_MS = 120_000;
const STOP_TIMEOUT_MS = 20_000;

const scratch = mkdtempSync(join(tmpdir(), "replay-e2e-"));
const report = join(scratch, "deny-network.jsonl");

const env = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? scratch,
  NODE_OPTIONS: `--import ${PRELOAD}`,
  DENY_NETWORK_REPORT: report,
  npm_config_update_notifier: "false",
  npm_config_fund: "false",
  npm_config_audit: "false",
  NODE_ENV: "development",
  REPLAY_MODE: "only",
  REPLAY_DIR: FIXTURES,
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
  CORS_ORIGINS: "http://localhost:3000",
  TRUST_PROXY: "",
  RATE_LIMIT_WINDOW_MS: "",
  RATE_LIMIT_MAX: "",
  RATE_LIMIT_GLOBAL_MAX: "",
  SEARCH_RATE_LIMIT_WINDOW_MS: "",
  SEARCH_RATE_LIMIT_MAX: "",
  LANGSMITH_TRACING: "",
  LANGSMITH_TRACING_V2: "",
  LANGCHAIN_TRACING_V2: "",
  LANGCHAIN_TRACING: "",
  OPENAI_CUSTOM_HEADERS: "",
};

const failures = [];
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(label);
};

// --- the API ----------------------------------------------------------------------------------

const api = spawn("npm", ["start", "-w", "apps/api"], {
  cwd: ROOT,
  env,
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
api.stdout.on("data", (chunk) => {
  output += chunk;
});
api.stderr.on("data", (chunk) => {
  output += chunk;
});
const exited = new Promise((resolveExit) => api.on("exit", (code) => resolveExit(code)));

const port = await new Promise((resolvePort, reject) => {
  const timer = setTimeout(() => reject(new Error("the API did not start")), START_TIMEOUT_MS);
  const poll = setInterval(() => {
    const match = output.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
    if (match) {
      clearInterval(poll);
      clearTimeout(timer);
      resolvePort(Number(match[1]));
    }
  }, 100);
  exited.then((code) => {
    clearInterval(poll);
    clearTimeout(timer);
    reject(new Error(`the API exited with ${code} before listening`));
  });
}).catch((error) => {
  console.error(output);
  console.error(String(error));
  // Never returns: the script stops here.
  return stopAndExit(1);
});

const base = `http://127.0.0.1:${port}`;
// Imported once the API's prestart has built the contract.
const { AnalyzeStreamEvent, RunResponse, runIssues } = await import("@liner-notes/contract");

/** The events of one analysis stream (heartbeats left out). */
async function stream(query) {
  const res = await fetch(`${base}/api/analyze/stream?query=${encodeURIComponent(query)}`);
  const text = await res.text();
  const events = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)))
    .filter((event) => event.type !== "heartbeat");
  return { text, events };
}

/** The event types (with error codes) of any event stream, heartbeats left out. */
async function sseTypes(path) {
  const text = await (await fetch(`${base}${path}`)).text();
  return text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)))
    .filter((event) => event.type !== "heartbeat")
    .map((event) => `${event.type}${event.code ? `:${event.code}` : ""}`)
    .join(" ");
}

async function json(path, init) {
  const res = await fetch(`${base}${path}`, init);
  return { status: res.status, text: await res.clone().text(), body: await res.json() };
}

try {
  // A1: a full replay of the recorded track.
  const replay = await stream(SHOWCASE_QUERY);
  const types = replay.events.map((event) => event.type);
  console.log(`A1 events with "type": ${(replay.text.match(/"type"/g) ?? []).length}`);
  console.log(`A1 stream: ${types.join(" ")}`);
  const runId = replay.events[0]?.runId;
  const complete = replay.events.find((event) => event.type === "complete");
  const run = complete?.data?.run;
  check(types[0] === "connected", "A1 the stream starts with connected");
  check(
    replay.events[1]?.type === "status" &&
      /^Replaying an analysis recorded on /.test(replay.events[1].message),
    "A1 the first event after connected says it is a replay",
  );
  check(types.at(-2) === "complete" && types.at(-1) === "done", "A1 it ends with complete, done");
  check(
    replay.events.every((event) => AnalyzeStreamEvent.safeParse(event).success),
    "A1 every event fits the contract",
  );
  check(
    replay.events.every((event, i) => event.runId === runId && event.seq === i),
    "A1 every event carries this run's id and its seq",
  );
  check(run?.mode === "replay", "A1 the result says mode replay", `mode ${run?.mode}`);
  check(
    Boolean(run?.recordedAt && run?.commit),
    "A1 recordedAt and commit are set",
    `${run?.recordedAt} ${run?.commit}`,
  );
  check(run?.id === runId, "A1 the result names this run");
  check(
    run !== undefined && runIssues(run, complete.data.audio).length === 0,
    "A1 the run information passes runIssues",
  );

  const unknown = await stream("A song nobody recorded");
  const unknownTypes = unknown.events.map(
    (event) => `${event.type}${event.code ? `:${event.code}` : ""}`,
  );
  console.log(`A1 unknown query: ${unknownTypes.join(" ")}`);
  check(
    unknownTypes.join(" ") === "error:live_disabled done",
    "A1 a query with no recording gets live_disabled, never another recording",
  );

  // A3: suggestions from the recordings.
  const dyn = await json("/api/search/suggest?query=dyn");
  console.log(`A3 suggest?query=dyn: ${dyn.status} ${dyn.text}`);
  check(dyn.status === 200 && dyn.body.success === true, "A3 suggest answers without Spotify");
  check(dyn.body.suggestions?.length === 0, "A3 'dyn' matches no recorded track");
  const daft = await json("/api/search/suggest?query=daft");
  console.log(`A3 suggest?query=daft: ${daft.status} ${daft.text}`);
  check(
    daft.status === 200 && daft.body.suggestions?.[0]?.id === TRACK_ID,
    "A3 'daft' suggests the recorded track",
  );

  // A4: the stored replay, without the typed query.
  const typed = await stream(TYPED_QUERY);
  const typedRun = typed.events[0]?.runId;
  check(typed.events.at(-2)?.type === "complete", "A4 the typed query replays the recording");
  const byTrack = await json(`/api/runs/by-track/${TRACK_ID}`);
  console.log(
    `A4 by-track: ${byTrack.status} run ${JSON.stringify(byTrack.body.run)} ` +
      `analysis.run.mode ${byTrack.body.analysis?.run?.mode}`,
  );
  check(byTrack.status === 200 && RunResponse.safeParse(byTrack.body).success, "A4 a RunResponse");
  check(byTrack.body.run?.mode === "replay", "A4 run.mode is replay");
  check(byTrack.body.run?.id === typedRun, "A4 it is the latest replayed run");
  check(
    !byTrack.text.toLowerCase().includes(TYPED_QUERY.toLowerCase()),
    "A4 the body does not contain the typed query",
  );
  const byId = await json(`/api/runs/${typedRun}`);
  check(
    byId.status === 200 && byId.body.run?.mode === "replay",
    "A4 GET /api/runs/:id says replay",
  );

  // "More facts" from the recording.
  const more = await json("/api/factoids/decrypt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      trackId: TRACK_ID,
      trackTitle: "One More Time",
      trackArtist: "Daft Punk",
      existingFactoidIds: [],
    }),
  });
  console.log(`factoids: ${more.status} ${more.body.factoids?.length} recorded facts`);
  check(more.status === 200 && more.body.factoids?.length > 0, "factoids come from the recording");
  const other = await json("/api/factoids/decrypt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      trackId: "unrecorded",
      trackTitle: "Unrecorded",
      trackArtist: "Nobody",
    }),
  });
  check(
    other.status === 503 && other.body.code === "live_disabled",
    "factoids of an unrecorded track are refused with live_disabled",
  );

  // The other replay paths, so an outbound call added to any of them is counted below.
  const factoidStream = await sseTypes(
    "/api/factoids/decrypt/stream?trackTitle=One%20More%20Time&trackArtist=Daft%20Punk",
  );
  console.log(`factoid stream: ${factoidStream}`);
  check(/^connected( factoid)+ done$/.test(factoidStream), "the factoid stream replays them");
  const posted = await json("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: SHOWCASE_QUERY }),
  });
  console.log(`POST /api/analyze: ${posted.status} mode ${posted.body.data?.run?.mode}`);
  check(
    posted.status === 200 &&
      posted.body.data?.run?.mode === "replay" &&
      posted.body.data.run.id === posted.body.threadId,
    "POST /api/analyze answers with the recording as a new run",
  );
  const postedOther = await json("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "A song nobody recorded" }),
  });
  check(
    postedOther.status === 503 && postedOther.body.code === "live_disabled",
    "POST /api/analyze refuses a query with no recording",
  );
  const resumed = await json("/api/analyze/resume", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threadId: "some-thread", selectedTrackId: TRACK_ID }),
  });
  check(
    resumed.status === 503 && resumed.body.code === "live_disabled",
    "POST /api/analyze/resume is refused",
  );
  const resumeStream = await sseTypes(
    `/api/analyze/stream/resume?threadId=some-thread&selectedTrackId=${TRACK_ID}`,
  );
  check(resumeStream === "error:live_disabled done", "the resume stream is refused");
  const head = await fetch(
    `${base}/api/analyze/stream?query=${encodeURIComponent(SHOWCASE_QUERY)}`,
    {
      method: "HEAD",
    },
  );
  check(head.status === 200, "HEAD on the stream answers its headers only");
} catch (error) {
  check(false, `checks ran (${error})`);
}

await stop();
// A process writes a line at each blocked attempt and one when it exits: keep its highest count.
const byProcess = new Map();
for (const line of await reportLines()) {
  if ((byProcess.get(line.pid)?.attempts ?? -1) < line.attempts) byProcess.set(line.pid, line);
}
const processes = [...byProcess.values()];
for (const line of processes) {
  console.log(`deny-network: pid ${line.pid} ${line.argv.join(" ").slice(-60)}: ${line.attempts}`);
}
check(
  processes.some((line) => line.argv.some((arg) => arg.endsWith("apps/api/src/index.ts"))),
  "the API process reported its outbound attempts",
);
check(
  processes.every((line) => line.attempts === 0),
  "0 outbound attempts in every process",
  `${processes.reduce((sum, line) => sum + line.attempts, 0)} in total`,
);

rmSync(scratch, { recursive: true, force: true });
if (failures.length > 0) {
  console.error(`\n${failures.length} checks failed. API output:\n${output}`);
  process.exit(1);
}
console.log("\nreplay e2e: all checks passed");

// --- stopping ---------------------------------------------------------------------------------

async function stop() {
  try {
    process.kill(-api.pid, "SIGTERM");
  } catch {
    // already gone
  }
  const timer = setTimeout(() => {
    try {
      process.kill(-api.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }, STOP_TIMEOUT_MS);
  await exited;
  clearTimeout(timer);
}

/** The report's lines, once the API process has written its own (npm may exit first). */
async function reportLines() {
  const read = () => {
    try {
      return readFileSync(report, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    } catch {
      return [];
    }
  };
  const until = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < until) {
    const lines = read();
    if (lines.some((line) => line.argv.some((arg) => arg.endsWith("apps/api/src/index.ts"))))
      return lines;
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  return read();
}

async function stopAndExit(code) {
  await stop();
  rmSync(scratch, { recursive: true, force: true });
  process.exit(code);
}
