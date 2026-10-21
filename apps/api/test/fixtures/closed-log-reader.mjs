// Spawned by src/index.test.ts with the API's settings in its environment. Starts the API
// (argv: loader URL, entry, port, database path) with that environment, its stdout and stderr
// in a pipe whose only reader is this process, keeps one request open, stops reading (closes
// the pipe) and sends SIGTERM. Prints one JSON line: { code, signal, ms, afterContinue } of the
// API's exit, or { error }.

import { spawn } from "node:child_process";
import { connect } from "node:net";

const [loader, entry, port, dbPath] = process.argv.slice(2);
const api = spawn(process.execPath, ["--import", loader, entry], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, PORT: port, SQLITE_DB_PATH: dbPath },
});
api.stdout.resume();
api.stderr.resume();

/** Stops the API and reports why the run could not be measured. */
function fail(error) {
  api.kill("SIGKILL");
  console.log(JSON.stringify({ error }));
  process.exit(1);
}
const killTimer = setTimeout(() => fail("the API did not exit within 30 s of its start"), 30_000);

const deadline = Date.now() + 20_000;
for (;;) {
  try {
    if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break;
  } catch {
    // not listening yet
  }
  if (Date.now() > deadline) fail("the API did not start");
  await new Promise((resolve) => setTimeout(resolve, 100));
}

// A request whose body never completes. The signal is sent only once the API has read the
// request head, which it shows by answering "100 Continue": a connection whose request has not
// been read yet counts as idle, and server.close() closes it at once (Node 26), so the shutdown
// would have nothing to drain. Anything the API sends after the 100 (an early answer, such as a
// 429) means the request was not held, and is reported.
const CONTINUE = "HTTP/1.1 100 Continue\r\n\r\n";
const socket = connect(Number(port), "127.0.0.1");
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
  "POST /api/factoids/decrypt HTTP/1.1\r\nHost: 127.0.0.1\r\n" +
    "Content-Type: application/json\r\nContent-Length: 100\r\nExpect: 100-continue\r\n\r\n",
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
