#!/usr/bin/env node
// Starts the web app, the API and the audio service together for local development.
//
//   npm run dev                          all three on 3000 / 3001 / 3002
//   WEB_PORT=3110 API_PORT=3111 AUDIO_PORT=3112 npm run dev
//   DEV_SERVICES=web,api npm run dev     a subset
//
// Output lines are prefixed with the service name. If one service exits, the others are
// stopped and this script exits with the first failing service's exit code. The API runs
// under `tsx watch`, which stays up after a crash and restarts on the next file change.

import { spawn } from "node:child_process";

const { WEB_PORT, API_PORT, AUDIO_PORT } = process.env;
const STOP_TIMEOUT_MS = 5000;

const services = {
  web: {
    workspace: "apps/web",
    // strictPort: never drift onto the next port (the API's) when the web port is taken
    args: ["--", "--port", WEB_PORT ?? "3000", "--strictPort"],
    env: {},
  },
  api: {
    workspace: "apps/api",
    args: [],
    env: {
      ...(API_PORT && { PORT: API_PORT }),
      ...(AUDIO_PORT && { AUDIO_ANALYSIS_URL: `http://localhost:${AUDIO_PORT}` }),
    },
  },
  audio: {
    workspace: "services/audio",
    args: [],
    env: {},
  },
};

const selected = (process.env.DEV_SERVICES ?? "web,api,audio")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);

for (const name of selected) {
  if (!services[name]) {
    console.error(`[dev] unknown service "${name}" (expected: ${Object.keys(services).join(", ")})`);
    process.exit(1);
  }
}

if (API_PORT && API_PORT !== "3001" && selected.includes("web")) {
  console.warn("[dev] note: the web app still calls the API on port 3001; API_PORT moves only the API");
}

const children = new Map();
let shuttingDown = false;
let exitCode = 0;

function prefix(name, stream, target) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) target.write(`[${name}] ${line}\n`);
  });
  stream.on("end", () => {
    if (buffer) target.write(`[${name}] ${buffer}\n`);
  });
}

// Each child leads its own process group, so watchers and servers it spawned are signalled too.
function signalAll(signal) {
  for (const child of children.values()) {
    try {
      process.kill(-child.pid, signal);
    } catch {
      // already gone
    }
  }
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  exitCode = code;
  if (children.size === 0) process.exit(exitCode);
  signalAll("SIGTERM");
  setTimeout(() => {
    if (children.size > 0) {
      console.error(`[dev] ${[...children.keys()].join(", ")} did not stop in time; killing`);
      signalAll("SIGKILL");
    }
    process.exit(exitCode);
  }, STOP_TIMEOUT_MS).unref();
}

for (const name of selected) {
  const service = services[name];
  const child = spawn("npm", ["run", "dev", "-w", service.workspace, ...service.args], {
    env: { ...process.env, ...service.env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  children.set(name, child);
  prefix(name, child.stdout, process.stdout);
  prefix(name, child.stderr, process.stderr);
  child.on("exit", (code, signal) => {
    children.delete(name);
    if (!shuttingDown) {
      console.error(`[dev] ${name} exited (${signal ?? code}); stopping the other services`);
      shutdown(code || 1);
    }
    if (children.size === 0) process.exit(exitCode);
  });
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => shutdown(0));
}
