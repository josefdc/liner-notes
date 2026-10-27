// Spawned by src/index.test.ts with the API's settings in its environment (PORT=0: the API binds
// a port of the system's choosing). Starts the API (argv: loader URL, entry, database path) with
// that environment, its stdout and stderr in a pipe whose only reader is this process, reads the
// port from the API's "listening" log line, gets a run token, keeps one request open, stops
// reading (closes the
// pipe) and sends SIGTERM. Prints one JSON line: { code, signal, ms, afterContinue } of the
// API's exit, or { error }.

import { spawn } from "node:child_process";
import { connect } from "node:net";

const [loader, entry, dbPath] = process.argv.slice(2);
const api = spawn(process.execPath, ["--import", loader, entry], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, SQLITE_DB_PATH: dbPath },
});
let output = "";
api.stdout.on("data", (chunk) => {
  output += chunk;
});
api.stderr.on("data", (chunk) => {
  output += chunk;
});

const LISTENING = "Liner Notes API listening on port";

/** The port in the API's own "listening" log line, once it has written it. */
function listeningPort() {
  for (const line of output.split("\n")) {
    try {
      const entry = JSON.parse(line);
      if (
        entry?.component === "Server" &&
        String(entry.msg).startsWith(LISTENING) &&
        typeof entry.port === "number"
      ) {
        return entry.port;
      }
    } catch {
      // not a whole JSON line
    }
  }
  return undefined;
}

/** Stops the API and reports why the run could not be measured. */
function fail(error) {
  api.kill("SIGKILL");
  console.log(JSON.stringify({ error }));
  process.exit(1);
}
const killTimer = setTimeout(() => fail("the API did not exit within 45 s of its start"), 45_000);

// Waits for the API's own "listening" line, then for it to answer on that port, within 30 s
// (about 1 s on a quiet machine, 10-12 s on two busy cores).
const startedAt = Date.now();
const deadline = startedAt + 30_000;
let port;
for (;;) {
  if (api.exitCode !== null || api.signalCode !== null) {
    fail(`the API exited ${Date.now() - startedAt} ms into its startup:\n${output}`);
  }
  port ??= listeningPort();
  if (port !== undefined) {
    try {
      const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
      if ((await fetch(`http://127.0.0.1:${port}/api/health`, { signal })).ok) break;
    } catch {
      // not answering yet
    }
  }
  if (Date.now() >= deadline) {
    fail(
      port === undefined
        ? `the API wrote no "${LISTENING} <port>" line (Server, with a numeric port) within ${Date.now() - startedAt} ms:\n${output}`
        : `the API listens on port ${port} but did not answer /api/health within ${Date.now() - startedAt} ms:\n${output}`,
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
}

// The held request needs a run token: development has the Turnstile bypass ("dev-bypass").
const tokenAnswer = await fetch(`http://127.0.0.1:${port}/api/runs`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ turnstileToken: "dev-bypass" }),
  signal: AbortSignal.timeout(5_000),
}).catch((error) => fail(`could not get a run token: ${error.message}`));
if (!tokenAnswer.ok) fail(`could not get a run token (HTTP ${tokenAnswer.status})`);
const { runToken } = await tokenAnswer.json();

// A request whose body never completes. The signal is sent only once the API has read the
// request head, which it shows by answering "100 Continue": a connection whose request has not
// been read yet counts as idle, and server.close() closes it at once (Node 26), so the shutdown
// would have nothing to drain. Anything the API sends after the 100 (an early answer, such as a
// 429) means the request was not held, and is reported.
const CONTINUE = "HTTP/1.1 100 Continue\r\n\r\n";
const socket = connect(port, "127.0.0.1");
const connected = await new Promise((resolve) => {
  socket.once("connect", () => resolve(true));
  socket.once("error", () => resolve(false));
  socket.once("close", () => resolve(false));
});
if (!connected) fail("could not connect to the API");
socket.on("error", () => {});
let received = "";
socket.on("data", (chunk) => {
  received += chunk;
});
socket.write(
  `POST /api/factoids/more?runToken=${encodeURIComponent(runToken)} HTTP/1.1\r\n` +
    "Host: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 100\r\n" +
    "Expect: 100-continue\r\n\r\n",
);
const interim = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve("no interim answer within 5 s"), 5_000);
  const onData = () => {
    if (!received.includes("\r\n\r\n")) return;
    clearTimeout(timer);
    socket.off("data", onData);
    resolve(received);
  };
  socket.on("data", onData);
  socket.once("close", () => {
    clearTimeout(timer);
    resolve(`the connection closed after ${JSON.stringify(received)}`);
  });
});
if (interim !== CONTINUE) fail(`expected only "100 Continue", got ${JSON.stringify(interim)}`);
socket.write("{");
if (received !== CONTINUE) fail(`answered before the signal: ${JSON.stringify(received)}`);

api.stdout.destroy();
api.stderr.destroy();
const signalledAt = Date.now();
api.on("exit", (code, signal) => {
  clearTimeout(killTimer);
  // afterContinue: what the API sent on the held connection after the 100 (expected: nothing).
  const afterContinue = received.slice(CONTINUE.length);
  console.log(JSON.stringify({ code, signal, ms: Date.now() - signalledAt, afterContinue }));
  socket.destroy();
});
api.kill("SIGTERM");
