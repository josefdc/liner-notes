// Spawned by src/index.test.ts with the API's settings in its environment. Starts the API
// (argv: loader URL, entry, port, database path) with that environment, its stdout and stderr in a pipe whose only reader is this process, keeps one request
// open, stops reading (closes the pipe) and sends SIGTERM. Prints one JSON line:
// { code, signal, ms } of the API's exit, or { error }.

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

const socket = connect(Number(port), "127.0.0.1");
await new Promise((resolve) => socket.once("connect", resolve));
socket.on("error", () => {});
socket.write(
  "POST /api/factoids/decrypt HTTP/1.1\r\nHost: 127.0.0.1\r\n" +
    "Content-Type: application/json\r\nContent-Length: 100\r\n\r\n{",
);

api.stdout.destroy();
api.stderr.destroy();
const signalledAt = Date.now();
api.on("exit", (code, signal) => {
  clearTimeout(killTimer);
  console.log(JSON.stringify({ code, signal, ms: Date.now() - signalledAt }));
  socket.destroy();
});
api.kill("SIGTERM");
