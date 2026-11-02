#!/usr/bin/env node
// End-to-end check of replay mode with outbound network denied:
//
//   npm run test:replay   (then runs scripts/replay-interrupt.test.mjs, which interrupts this)
//
// Starts the API as `npm start -w apps/api` with REPLAY_MODE=only, tests/deny-network.mjs
// preloaded in every node process (NODE_OPTIONS), dummy Spotify, model and source keys, a
// scratch database and every setting the checks rely on pinned (scripts/replay-api-env.mjs, so
// a developer's apps/api/.env changes nothing), then checks over HTTP:
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
//   A5  Stop: a replay whose client closes its stream after its first events (as the web
//       page's Stop does: EventSource.close() closes the connection; here the fetch is aborted,
//       which closes it the same way, since this script cannot drive the page) is recorded as
//       cancelled with no result, well before the replay would have ended.
//
// Last, it stops the API (scripts/stop-server.mjs: SIGTERM to the server process, then a wait
// until the API's output closes, that is until every process holding it has exited) and requires
// it to exit 0 with no SIGKILL. It checks the API's log (LOG_FILE): JSON lines, the A1 run's lines
// carry its run id, and no line holds an IP address, a query string, the typed query or any of the
// dummy keys. Then `npm run report -w apps/api` over the API's database counts the replays it
// served, and prints nothing anyone typed. The deny-network report is read twice: once the API's
// output has closed, and once the report step's has. Every process that loaded
// tests/deny-network.mjs and wrote its start line by then must have written its exit report with
// 0 outbound attempts, and every line must be readable. A guarded process that starts only after
// the last read (say, node run later by a detached shell the API left behind) is never seen.
//
// Interrupted (SIGINT, SIGTERM), it stops the API the same way (and the report step, when that
// runs) and removes its scratch directory before it exits with 130 or 143.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { replayApiEnv } from "./replay-api-env.mjs";
import { endGroup, readReport, readReportFile, runs, stopServer } from "./stop-server.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The script of the API's server process (`npm start` runs it with node, tsx loaded by --import).
const API_ENTRY = "apps/api/src/index.ts";
// The script of the report step's own process (`npm run report` runs it through the tsx CLI).
const REPORT_ENTRY = "apps/api/src/scripts/report.ts";

const TRACK_ID = "0DiWol3AO6WpXZgp0goxAV";
const SHOWCASE_QUERY = "One More Time Daft Punk";
// The showcase whose replay serves fact cards ("More facts"): the demo's two recorded cards.
const FACTS_TRACK = {
  trackId: TRACK_ID,
  trackTitle: "One More Time",
  trackArtist: "Daft Punk",
};
// A showcase whose run wrote no fact card: its replay serves none, and asks nothing.
const NO_FACTS_TRACK = {
  trackId: "0Dmao2oWlAZzIBX2Q1B5AH",
  trackTitle: "Bitter Sweet Symphony - Remastered 2016",
  trackArtist: "The Verve",
};
const TYPED_QUERY = "DAFT punk: one MORE time";
const START_TIMEOUT_MS = 120_000;
const STOP_TIMEOUT_MS = 20_000;
// How long after the SIGTERM the output may stay open (held by a process outside the API's group,
// which the SIGKILL at STOP_TIMEOUT_MS does not reach) before the stop gives up and fails.
const GIVE_UP_MS = 30_000;
// The report step's stop: SIGKILL to its group after REPORT_STOP_TIMEOUT_MS, and no more waiting
// after REPORT_GIVE_UP_MS.
const REPORT_STOP_TIMEOUT_MS = 5_000;
const REPORT_GIVE_UP_MS = 10_000;
// The longest an interrupt can take to stop both.
const MAX_STOP_S = (GIVE_UP_MS + REPORT_GIVE_UP_MS) / 1000;
// Each request, body included: a stream that never ends fails the check instead of hanging CI.
const REQUEST_TIMEOUT_MS = 30_000;
const timeout = () => AbortSignal.timeout(REQUEST_TIMEOUT_MS);
// The API's line once it listens.
const LISTENING = /"msg":"Liner Notes API listening on port (\d+)"/;

const scratch = mkdtempSync(join(tmpdir(), "replay-e2e-"));
const report = join(scratch, "deny-network.jsonl");
const logFile = join(scratch, "api.jsonl");

const env = replayApiEnv({ scratch, report, logFile });

/** The stop of the API, once begun (see stop()), and the exit code an interrupt asked for. */
let stopping;
let interrupted;
/** Whether the API's output was printed after an interrupt. */
let outputShown = false;
/** The report step, once started: its process and its close (see runReportStep()). */
let reportStep;

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
// A failure to start npm at all ends both waits below, with code null.
let spawnError;
api.once("error", (error) => {
  spawnError = error;
});
const exited = new Promise((resolveExit) => {
  api.on("exit", (code) => resolveExit(code));
  api.once("error", () => resolveExit(null));
});
// Once every process holding the API's output (npm, sh, the server) has exited.
const closed = new Promise((resolveClose) => {
  api.on("close", (code) => resolveClose(code));
  api.once("error", () => resolveClose(null));
});
// From here on an interrupt stops the API (and the report step) and removes the scratch directory.
// A second signal changes nothing but a line: each stop gives up waiting after a bounded time.
for (const [name, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
]) {
  process.on(name, () => {
    if (interrupted !== undefined) {
      console.error(`${name}: still stopping (it gives up within ${MAX_STOP_S} s)`);
      return;
    }
    interrupted = code;
    console.error(`\n${name}: stopping the API and removing ${scratch}`);
    stopAndExit(code);
  });
}

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
  exited.then((code) => {
    clearInterval(poll);
    clearTimeout(timer);
    reject(
      new Error(
        spawnError
          ? `npm could not be started (${spawnError.message})`
          : `the API exited with ${code} before listening`,
      ),
    );
  });
}).catch((error) => {
  // Interrupted, the API was stopped on purpose (stopAndExit prints its output).
  if (interrupted === undefined) {
    console.error(output);
    console.error(String(error));
  }
  // Never returns: the script stops here.
  return stopAndExit(1);
});

const base = `http://127.0.0.1:${port}`;
// Imported once the API's prestart has built the contract.
const { AnalyzeStreamEvent, RunResponse, runIssues } = await import("@liner-notes/contract");

/** Every run token the API issued here, so the log can be checked for them. */
const issuedTokens = [];

/** A run token, as the web page gets one: POST /api/runs with the development bypass. */
async function runToken() {
  const res = await fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ turnstileToken: "dev-bypass" }),
    signal: timeout(),
  });
  if (res.status !== 200) throw new Error(`POST /api/runs answered ${res.status}`);
  const { runToken: token } = await res.json();
  issuedTokens.push(token);
  return token;
}

/**
 * `path` with a run token in its query, on the routes that require one: `token`, or a new one.
 * A path that has one already is left as it is.
 */
async function tokened(path, token) {
  if (!/^\/api\/(?:analyze|factoids)(?:[/?]|$)/.test(path) || path.includes("runToken=")) {
    return path;
  }
  const value = encodeURIComponent(token ?? (await runToken()));
  return `${path}${path.includes("?") ? "&" : "?"}runToken=${value}`;
}

/** The events of one analysis stream (heartbeats left out), and the run token it started with. */
async function stream(query) {
  const token = await runToken();
  const path = await tokened(`/api/analyze/stream?query=${encodeURIComponent(query)}`, token);
  const res = await fetch(`${base}${path}`, { signal: timeout() });
  const text = await res.text();
  const events = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)))
    .filter((event) => event.type !== "heartbeat");
  return { text, events, token };
}

/** The event types (with error codes) of any event stream, heartbeats left out. */
async function sseTypes(path) {
  const text = await (await fetch(`${base}${await tokened(path)}`, { signal: timeout() })).text();
  return text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)))
    .filter((event) => event.type !== "heartbeat")
    .map((event) => `${event.type}${event.code ? `:${event.code}` : ""}`)
    .join(" ");
}

async function json(path, init) {
  const res = await fetch(`${base}${await tokened(path)}`, { ...init, signal: timeout() });
  return { status: res.status, text: await res.clone().text(), body: await res.json() };
}

/**
 * Opens an analysis stream, reads it until `count` events have come (heartbeats left out), then
 * closes it as the web page's Stop does: the connection is closed. Returns the events read.
 */
async function streamThenClose(query, count) {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const events = [];
  try {
    const path = await tokened(`/api/analyze/stream?query=${encodeURIComponent(query)}`);
    const res = await fetch(`${base}${path}`, { signal: controller.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (events.length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      for (let end = text.indexOf("\n\n"); end !== -1; end = text.indexOf("\n\n")) {
        for (const line of text.slice(0, end).split("\n")) {
          if (!line.startsWith("data:")) continue;
          const event = JSON.parse(line.slice(5));
          if (event.type !== "heartbeat" && events.length < count) events.push(event);
        }
        text = text.slice(end + 2);
      }
    }
  } finally {
    clearTimeout(deadline);
    controller.abort();
  }
  return events;
}

/** The A1 run's id, for the log checks after the API stopped. */
let replayRunId;
/** The A5 run's id (the replay stopped by its client), for the log checks. */
let stoppedRunId;
/** How long the A1 replay took from request to its last event, in milliseconds. */
let replayMs = 0;

try {
  // A1: a full replay of the recorded track.
  const replayStarted = performance.now();
  const replay = await stream(SHOWCASE_QUERY);
  replayMs = performance.now() - replayStarted;
  const types = replay.events.map((event) => event.type);
  console.log(`A1 events with "type": ${(replay.text.match(/"type"/g) ?? []).length}`);
  console.log(`A1 stream: ${types.join(" ")}`);
  const runId = replay.events[0]?.runId;
  replayRunId = runId;
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
  const more = await json("/api/factoids/more", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...FACTS_TRACK, existingFactoidIds: [] }),
  });
  console.log(`factoids: ${more.status} ${more.body.factoids?.length} recorded facts`);
  check(more.status === 200 && more.body.factoids?.length > 0, "factoids come from the recording");
  const noMore = await json("/api/factoids/more", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...NO_FACTS_TRACK, existingFactoidIds: [] }),
  });
  console.log(`no-card factoids: ${noMore.status} ${noMore.body.factoids?.length} recorded facts`);
  check(
    noMore.status === 200 &&
      Array.isArray(noMore.body.factoids) &&
      noMore.body.factoids.length === 0,
    "a showcase whose run wrote no card serves none, and nothing is asked",
  );
  const other = await json("/api/factoids/more", {
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
    `/api/factoids/more/stream?${new URLSearchParams({
      trackTitle: FACTS_TRACK.trackTitle,
      trackArtist: FACTS_TRACK.trackArtist,
    })}`,
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
  // A resume of the A4 run, with the token it started with (only that token resumes it).
  const resumed = await json(await tokened("/api/analyze/resume", typed.token), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threadId: typedRun, selectedTrackId: TRACK_ID }),
  });
  check(
    resumed.status === 503 && resumed.body.code === "live_disabled",
    "POST /api/analyze/resume is refused",
  );
  const resumeStream = await sseTypes(
    await tokened(
      `/api/analyze/stream/resume?threadId=${typedRun}&selectedTrackId=${TRACK_ID}`,
      typed.token,
    ),
  );
  check(resumeStream === "error:live_disabled done", "the resume stream is refused");

  // Run tokens: none, or one that already started its run, is a 401 before anything runs.
  const untokened = await fetch(
    `${base}/api/analyze/stream?query=${encodeURIComponent(SHOWCASE_QUERY)}`,
    { signal: timeout() },
  );
  const reused = await fetch(
    `${base}${await tokened(`/api/analyze/stream?query=${encodeURIComponent(SHOWCASE_QUERY)}`, typed.token)}`,
    { signal: timeout() },
  );
  console.log(`run tokens: none ${untokened.status}, reused ${reused.status}`);
  check(
    untokened.status === 401 && reused.status === 401,
    "a stream without a run token, or with a used one, is refused",
  );

  // A5: Stop. The replay is closed after connected, the replay notice and its first step.
  const read = await streamThenClose(SHOWCASE_QUERY, 3);
  const closedAt = performance.now();
  stoppedRunId = read[0]?.runId;
  console.log(`A5 read before the close: ${read.map((event) => event.type).join(" ")}`);
  check(
    read.length >= 3 && read.every((event) => event.type !== "complete"),
    "A5 the stream is closed before its result",
  );
  let stopped = null;
  while (performance.now() - closedAt < 10_000) {
    stopped = await json(`/api/runs/${encodeURIComponent(stoppedRunId ?? "none")}`);
    if (stopped.body.run?.status && stopped.body.run.status !== "running") break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  const stopMs = performance.now() - closedAt;
  console.log(
    `A5 run ${stopped?.status} status ${stopped?.body.run?.status} after ${Math.round(stopMs)} ms ` +
      `(the whole replay took ${Math.round(replayMs)} ms)`,
  );
  check(
    stopped?.body.run?.status === "cancelled" && stopped.body.analysis === null,
    "A5 the server records the closed replay as cancelled, with no result",
    `status ${stopped?.body.run?.status}`,
  );
  check(
    stopMs < replayMs / 2,
    "A5 it stops at the close: the rest of the replay is not played out",
    `${Math.round(stopMs)} ms after the close, the whole replay ${Math.round(replayMs)} ms`,
  );
  const head = await fetch(
    `${base}/api/analyze/stream?query=${encodeURIComponent(SHOWCASE_QUERY)}`,
    { method: "HEAD", signal: timeout() },
  );
  check(head.status === 200, "HEAD on the stream answers its headers only");
} catch (error) {
  // An interrupt stops the API under a running check: that check did not fail on its own.
  if (interrupted === undefined) check(false, `checks ran (${error})`);
}

const stopped = await stop();
// Interrupted meanwhile: the checks below would not run to the end.
if (interrupted !== undefined) await stopAndExit(interrupted);
// npm's own exit, which passes on the server's code: known once npm exited, even when the stop
// gave up waiting for the output to close.
check(
  api.exitCode === 0,
  "the API exited 0",
  `${
    api.exitCode !== null
      ? `exit ${api.exitCode}`
      : api.signalCode !== null
        ? `killed by ${api.signalCode}`
        : "npm had not exited"
  }, SIGTERM to ${stopped.signalled > 0 ? "the server process" : "the group"}`,
);
check(
  !stopped.killed && !stopped.lingering,
  `the API's process group ended within ${STOP_TIMEOUT_MS / 1000} s of the SIGTERM`,
  stopped.killed
    ? `SIGKILL sent after ${STOP_TIMEOUT_MS / 1000} s`
    : stopped.lingering
      ? "a process was still in the group when its output closed: SIGKILL sent then"
      : "",
);
check(
  !stopped.held,
  "the API's output closed after the stop",
  stopped.held ? "a process outside the API's process group still holds it" : "",
);
// The API's output has closed (every process that held it has exited), or the stop gave up
// waiting for that (checked above): a process still holding it may write more lines later.
const apiReport = readReportFile(report);
const apiProcesses = checkGuarded("the API", apiReport);
check(
  apiProcesses.some((line) => runs(line, API_ENTRY) && line.exited),
  "the API process reported its outbound attempts at exit",
);

// The API's log, as written to LOG_FILE.
let logText = "";
try {
  logText = readFileSync(logFile, "utf8");
} catch {
  // checked below
}
const logLines = logText.split("\n").filter((line) => line.trim() !== "");
const logEntries = logLines.flatMap((line) => {
  try {
    return [JSON.parse(line)];
  } catch {
    return [];
  }
});
const runLines = logEntries.filter((entry) => entry.runId !== undefined);
console.log(
  `log: ${logLines.length} lines, ${runLines.length} with "runId", ` +
    `${logEntries.filter((entry) => entry.runId === replayRunId).length} of the A1 run`,
);
check(logLines.length > 0 && logEntries.length === logLines.length, "log: every line is JSON");
check(
  logEntries.some((entry) => entry.runId === replayRunId && entry.component === "Run") &&
    logEntries.some((entry) => entry.runId === replayRunId && entry.path === "/api/analyze/stream"),
  "log: the A1 run's route and request lines carry its run id",
);
check(
  logEntries.some(
    (entry) => entry.runId === stoppedRunId && /^Replay cancelled/.test(entry.msg ?? ""),
  ) &&
    !logEntries.some(
      (entry) => entry.runId === stoppedRunId && /^Replay (complete|failed)/.test(entry.msg ?? ""),
    ),
  "log: the A5 replay stopped by its client is logged as cancelled",
);
check(!/\b(?:\d{1,3}\.){3}\d{1,3}\b|::1\b|::ffff:/i.test(logText), "log: no IP address");
check(!logText.includes("query="), "log: no query string");
check(
  !logText.toLowerCase().includes(TYPED_QUERY.toLowerCase()) &&
    !logText.toLowerCase().includes(SHOWCASE_QUERY.toLowerCase()),
  "log: no typed query at info level",
);
// The dummy keys and tokens, and the dummy model endpoint's host.
const dummySecrets = Object.entries(env)
  .filter(([name, value]) => /KEY|SECRET|TOKEN/.test(name) && value)
  .map(([, value]) => value)
  .concat([new URL(env.AZURE_OPENAI_ENDPOINT).host]);
check(
  dummySecrets.every((secret) => !logText.includes(secret)),
  "log: none of the dummy keys or the endpoint",
);
check(
  issuedTokens.length > 0 && issuedTokens.every((token) => !logText.includes(token)),
  "log: none of the run tokens",
  `${issuedTokens.length} issued`,
);

// The run report over the database the API wrote (two days, in case the runs crossed midnight).
const reportRun = await runReportStep();
if (interrupted !== undefined) await stopAndExit(interrupted);
const reportOut = reportRun.stdout ?? "";
let runReport = null;
try {
  runReport = JSON.parse(reportOut.slice(reportOut.indexOf("{")));
} catch {
  // checked below
}
const reportTotal = runReport?.total;
console.log(
  `report: exit ${reportRun.status}, ${reportTotal?.runs ?? "?"} runs, ` +
    `${reportTotal?.replay ?? "?"} replays, ${reportTotal?.live ?? "?"} live, ` +
    `${reportTotal?.model?.calls ?? "?"} model calls`,
);
check(
  reportRun.status === 0 &&
    reportTotal?.replay >= 2 &&
    reportTotal.live === 0 &&
    reportTotal.model?.calls === 0 &&
    reportTotal.model.unsentCalls === 0 &&
    reportTotal.model.sentUnknownCalls === 0,
  "report: counts the replays the API served, and no live run or model call",
  reportRun.status === 0
    ? ""
    : String(reportRun.error ?? reportRun.stderr ?? "")
        .slice(-300)
        .trim(),
);
check(
  reportOut !== "" &&
    !reportOut.toLowerCase().includes(TYPED_QUERY.toLowerCase()) &&
    !reportOut.toLowerCase().includes(SHOWCASE_QUERY.toLowerCase()) &&
    (replayRunId === undefined || !reportOut.includes(replayRunId)),
  "report: no typed query and no run id",
);
check(
  !reportRun.lingering,
  "the report step's process group ended with its output",
  reportRun.lingering ? "a process was still in the group: SIGKILL sent" : "",
);
// The report step's processes (npm, the contract build, tsx, the report script), from the lines
// they added. Its output has closed, or it timed out and was stopped (the report check above
// fails then): a process still holding the output may write more lines later.
const reportProcesses = checkGuarded("the report step", readReportFile(report, apiReport.end));
check(
  reportProcesses.some((line) => runs(line, REPORT_ENTRY) && line.exited),
  "the report script reported its outbound attempts at exit",
);

try {
  rmSync(scratch, { recursive: true, force: true });
} catch (error) {
  check(false, `the scratch directory ${scratch} was removed`, String(error));
}
if (failures.length > 0) {
  console.error(`\n${failures.length} checks failed. API output:\n${output}`);
  process.exit(1);
}
console.log("\nreplay e2e: all checks passed");

// --- the network guard's report ---------------------------------------------------------------

/**
 * The checks on the processes that wrote `lines` to the deny-network report during one step. A
 * process writes a line when it starts, at each blocked attempt and when it exits: each process
 * is listed with its highest count, its parent and whether it reported at exit.
 */
function checkGuarded(step, { lines, unreadable }) {
  check(
    unreadable.length === 0,
    `${step}: every line of the deny-network report is readable`,
    unreadable.length > 0 ? `${unreadable.length} not: ${unreadable[0].slice(0, 80)}` : "",
  );
  const byPid = new Map();
  for (const line of lines) {
    const known = byPid.get(line.pid);
    byPid.set(line.pid, {
      pid: line.pid,
      // The parent when it started: a process whose parent exits is handed to another.
      ppid: known?.ppid ?? line.ppid,
      argv: line.argv,
      execArgv: line.execArgv ?? [],
      attempts: Math.max(known?.attempts ?? 0, line.attempts),
      exited: Boolean(known?.exited) || line.event === "exit",
    });
  }
  const processes = [...byPid.values()];
  for (const line of processes) {
    console.log(
      `deny-network: ${describeProcess(line)}: ${line.attempts}` +
        (line.exited ? "" : " (no exit report)"),
    );
  }
  // A process that started but wrote no exit report was killed, or is still running (one that left
  // the step's process group and its output, say): its attempts so far are known, later ones not.
  const unreported = processes.filter((line) => !line.exited);
  check(
    unreported.length === 0,
    `${step}: every process covered by the network guard reported at exit`,
    unreported.map(describeProcess).join("; "),
  );
  check(
    processes.every((line) => line.attempts === 0),
    `${step}: 0 outbound attempts in every process`,
    `${processes.reduce((sum, line) => sum + line.attempts, 0)} in total`,
  );
  return processes;
}

/**
 * A process of the report: its pid, its parent and its script. A process with no script
 * (`node -e ...`) is named by its node options instead, and by its parent's script when the parent
 * is in the report too.
 */
function describeProcess(line) {
  const script = line.argv.join(" ").slice(-60);
  if (script !== "") return `pid ${line.pid} (parent ${line.ppid}) ${script}`;
  const parent = readReport(report).find((other) => other.pid === line.ppid);
  const parentScript = parent ? ` ${parent.argv.join(" ").slice(-60)}` : "";
  const options = line.execArgv.join(" ").slice(0, 60);
  return `pid ${line.pid} (parent ${line.ppid}${parentScript}) node ${options}`;
}

// --- stopping ---------------------------------------------------------------------------------

/**
 * Stops the API: SIGTERM to its server process once known, and a wait until its output closes.
 * Only the first call signals; any later one (an interrupt during or after the stop) gets its
 * result, so a pid that may since have been reused is never signalled again.
 */
function stop() {
  stopping ??= (async () => {
    const server = readReport(report).find(
      (line) => runs(line, API_ENTRY) && line.event === "start",
    );
    const stopped = await stopServer({
      group: api.pid,
      pid: server?.pid,
      closed,
      timeoutMs: STOP_TIMEOUT_MS,
      giveUpMs: GIVE_UP_MS,
    });
    if (stopped.held) {
      // Stop reading, so this script can exit.
      api.stdout.destroy();
      api.stderr.destroy();
    }
    return stopped;
  })();
  return stopping;
}

/**
 * Runs `npm run report -w apps/api` in a process group of its own, so that an interrupt or its
 * timeout stops all of it. Resolves with { status, stdout, stderr, error, lingering } once its
 * output has closed and any process left in its group got SIGKILL (`lingering`); after
 * START_TIMEOUT_MS, once stopReportStep() has stopped it or given up (status null, error says so).
 */
async function runReportStep() {
  const child = spawn("npm", ["run", "report", "-w", "apps/api", "--", "--days", "2", "--json"], {
    cwd: ROOT,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  // Decoded as a stream, so a character split across two chunks stays whole.
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  let error;
  reportStep = { child, ended: false };
  const stepClosed = new Promise((resolveClose) => {
    child.on("close", (code) => {
      reportStep.ended = true;
      resolveClose(code);
    });
    child.once("error", (spawnError) => {
      error = spawnError;
      reportStep.ended = true;
      resolveClose(null);
    });
  });
  reportStep.closed = stepClosed;
  let timer;
  const timedOut = new Promise((resolveTimeout) => {
    timer = setTimeout(async () => {
      error = new Error(`the report step did not end within ${START_TIMEOUT_MS / 1000} s`);
      await stopReportStep();
      resolveTimeout(null);
    }, START_TIMEOUT_MS);
  });
  const status = await Promise.race([stepClosed, timedOut]);
  clearTimeout(timer);
  // Closed on its own: a member that holds no output may still run (stopReportStep() ends it
  // otherwise).
  const lingering =
    reportStep.stopping === undefined && child.pid !== undefined && (await endGroup(child.pid));
  return { status: error ? null : status, stdout, stderr, error, lingering };
}

/**
 * Stops the report step, when it still runs: SIGTERM to its whole process group (no server pid to
 * single out here), SIGKILL to the group after REPORT_STOP_TIMEOUT_MS, and no more waiting after
 * REPORT_GIVE_UP_MS (a process outside the group still holds its output: stop reading it). Once
 * the step ended, its group id is never signalled.
 */
function stopReportStep() {
  if (reportStep === undefined || (reportStep.ended && !reportStep.stopping)) {
    return Promise.resolve();
  }
  reportStep.stopping ??= stopServer({
    group: reportStep.child.pid,
    closed: reportStep.closed,
    timeoutMs: REPORT_STOP_TIMEOUT_MS,
    giveUpMs: REPORT_GIVE_UP_MS,
  }).then((stopped) => {
    if (stopped.held) {
      reportStep.child.stdout.destroy();
      reportStep.child.stderr.destroy();
    }
  });
  return reportStep.stopping;
}

/**
 * Stops the API, removes the scratch directory and exits: with `code`, or an interrupt's, even
 * when part of that fails. Interrupted before the API listened, it prints the API's output, the
 * only clue to why it had not started.
 */
async function stopAndExit(code) {
  try {
    await stop();
    await stopReportStep();
    if (interrupted !== undefined && !LISTENING.test(output) && !outputShown) {
      outputShown = true;
      console.error(`The API's output (it had not started listening):\n${output}`);
    }
    rmSync(scratch, { recursive: true, force: true });
  } catch (error) {
    console.error(`Could not finish stopping and cleaning up: ${error}`);
  }
  process.exit(interrupted ?? code);
}
