#!/usr/bin/env node
// Starts the web app, the API and the audio service together for local development.
//
//   npm run dev                          all three on 3000 / 3001 / 3002
//   WEB_PORT=3110 API_PORT=3111 AUDIO_PORT=3112 npm run dev
//   DEV_SERVICES=web,api npm run dev     a subset
//
// Output lines are prefixed with the service name. If one service exits, the others are stopped.

import { spawn } from "node:child_process";

const { WEB_PORT, API_PORT, AUDIO_PORT } = process.env;

const services = {
  web: {
    workspace: "apps/web",
    args: WEB_PORT ? ["--", "--port", WEB_PORT] : [],
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

const children = new Map();
let shuttingDown = false;

function prefix(name, stream, target) {
  let buffer = "";
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

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children.values()) {
    // Each child leads its own process group so watchers and servers it spawned stop too.
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  setTimeout(() => process.exit(code), 500).unref();
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
    } else if (children.size === 0) {
      process.exit(code ?? 0);
    }
  });
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
