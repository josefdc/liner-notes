// Spawned by src/index.test.ts with the API's settings in its environment. Starts the API
// (argv: loader URL, entry, port, database path) with that environment, its stdout and stderr
// in a pipe whose only reader is this process, keeps one request open, stops reading (closes
// the pipe) and sends SIGTERM. Prints one JSON line: { code, signal, ms } of the API's exit, or
// { error }.

import { spawn } from "node:child_process";
import { connect } from "node:net";

const [loader, entry, port, dbPath] = process.argv.slice(2);
const api = spawn(process.execPath, ["--import", loader, entry], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, PORT: port, SQLITE_DB_PATH: dbPath },
});
api.stdout.resume();
api.stderr.resume();
const killTimer = setTimeout(() => {
  api.kill("SIGKILL");
  console.log(JSON.stringify({ error: "the API did not exit within 15 s" }));
  process.exit(1);
}, 30_000);

const deadline = Date.now() + 20_000;
for (;;) {
  try {
    if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break;
  } catch {
    // not listening yet
  }
  if (Date.now() > deadline) {
    api.kill("SIGKILL");
    console.log(JSON.stringify({ error: "the API did not start" }));
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}

// A request whose body never completes. The signal is sent only once the API has read the
// request head, which it shows by answering "100 Continue": a connection whose request has not
// been read yet counts as idle, and server.close() closes it at once (Node 26), so the shutdown
// would have nothing to drain.
const socket = connect(Number(port), "127.0.0.1");
socket.on("error", () => {});
await new Promise((resolve) => socket.once("connect", resolve));
socket.write(
  "POST /api/factoids/decrypt HTTP/1.1\r\nHost: 127.0.0.1\r\n" +
    "Content-Type: application/json\r\nContent-Length: 100\r\nExpect: 100-continue\r\n\r\n",
);
const interim = await new Promise((resolve) => {
  let received = "";
  const onData = (chunk) => {
    received += chunk;
    if (!received.includes("\r\n\r\n")) return;
    socket.off("data", onData);
    resolve(received.split("\r\n")[0]);
  };
  socket.on("data", onData);
  socket.once("close", () => resolve(`connection closed after ${JSON.stringify(received)}`));
});
if (!interim.startsWith("HTTP/1.1 100 ")) {
  api.kill("SIGKILL");
  console.log(JSON.stringify({ error: `expected 100 Continue, got ${interim}` }));
  process.exit(1);
}
socket.write("{");

api.stdout.destroy();
api.stderr.destroy();
const signalledAt = Date.now();
api.on("exit", (code, signal) => {
  clearTimeout(killTimer);
  console.log(JSON.stringify({ code, signal, ms: Date.now() - signalledAt }));
  socket.destroy();
});
api.kill("SIGTERM");
