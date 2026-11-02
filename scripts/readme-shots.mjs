#!/usr/bin/env node
// The README's screenshots, taken from the showcase replays (fixtures/replays), never from a live
// analysis: no model call, no source call, no key.
//
//   node scripts/readme-shots.mjs [--out docs/images] [--covers] [--channel chrome]
//
// Starts the API with REPLAY_MODE=only, dummy keys and a scratch database (as
// scripts/replay-e2e.mjs does, with tests/deny-network.mjs preloaded, so the API cannot reach the
// network), and the web app's Vite dev server forwarding /api to it, both on free loopback ports.
// Then, in Playwright's Chromium (`--channel chrome` for Google Chrome) at 1440 x 900, device pixel
// ratio 1, motion reduced, it opens and saves:
//
//   search.png      the landing page
//   dashboard.png   the Dashboard of the demo replay, One More Time (Daft Punk)
//   player.png      its Player ("View full analysis")
//   map.png         its song-relations map, full size (/t/<id>/map)
//
// The browser may load only the page's own origin: every other request is aborted, so nothing
// leaves the machine and the album cover shows as not loaded. `--covers` lets the Cover Art
// Archive's images load (coverartarchive.org and archive.org), to show the cover as the app does.
//
// The PNGs are what Chromium writes, unmodified. Exits 1 when a view does not show.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEMO = "one-more-time-daft-punk";
const VIEWPORT = { width: 1440, height: 900 };
const LISTENING = /"msg":"Liner Notes API listening on port (\d+)"/;
const COVER_HOSTS = /(^|\.)(coverartarchive\.org|archive\.org)$/;

const { values } = parseArgs({
  options: {
    out: { type: "string", default: "docs/images" },
    covers: { type: "boolean", default: false },
    channel: { type: "string" },
  },
});
const outDir = resolve(ROOT, values.out);

/** A free loopback port. */
function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

/** Starts `args` with node in `cwd`; resolves with the child once `ready(output)` matches. */
function start(name, args, { cwd, env, ready, timeoutMs = 120_000 }) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const append = (chunk) => {
    output += chunk;
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  return new Promise((resolveStart, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${name} did not start within ${timeoutMs / 1000} s:\n${output}`));
    }, timeoutMs);
    const poll = setInterval(() => {
      const match = ready(output);
      if (match) {
        clearInterval(poll);
        clearTimeout(timer);
        resolveStart({ child, match });
      }
    }, 100);
    child.once("exit", (code) => {
      clearInterval(poll);
      clearTimeout(timer);
      reject(new Error(`${name} exited with ${code} before it was ready:\n${output}`));
    });
  });
}

const scratch = mkdtempSync(join(tmpdir(), "readme-shots-"));
const children = [];
let browser;

async function cleanUp() {
  await browser?.close().catch(() => {});
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
  rmSync(scratch, { recursive: true, force: true });
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    cleanUp().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  });
}

async function main() {
  const recording = JSON.parse(
    readFileSync(join(ROOT, "fixtures", "replays", `${DEMO}.json`), "utf8"),
  );
  const { id: trackId } = recording.analysis;
  const query = recording.request.query;
  const webPort = await freePort();
  const webOrigin = `http://127.0.0.1:${webPort}`;

  // The API, replaying recordings only, with every setting it reads pinned here.
  const api = await start("the API", ["--import", "tsx", "src/index.ts"], {
    cwd: join(ROOT, "apps", "api"),
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? scratch,
      NODE_OPTIONS: `--import ${join(ROOT, "tests", "deny-network.mjs")}`,
      DENY_NETWORK_REPORT: join(scratch, "deny-network.jsonl"),
      NODE_ENV: "development",
      REPLAY_MODE: "only",
      REPLAY_DIR: join(ROOT, "fixtures", "replays"),
      HOST: "127.0.0.1",
      PORT: "0",
      SQLITE_DB_PATH: join(scratch, "api.db"),
      SPOTIFY_CLIENT_ID: "dummy-spotify-client-id",
      SPOTIFY_CLIENT_SECRET: "dummy-spotify-client-secret",
      AZURE_OPENAI_API_KEY: "dummy-azure-key",
      AZURE_OPENAI_ENDPOINT: "https://dummy-resource.openai.azure.com/",
      LLM_CASSETTE: "off",
      LLM_SPEND_LOG: join(scratch, "spend.jsonl"),
      TAVILY_API_KEY: "dummy-tavily-key",
      AUDIO_ANALYSIS_URL: "http://dummy-audio.invalid:3002",
      CORS_ORIGINS: webOrigin,
      TURNSTILE_SECRET_KEY: "",
      RUN_TOKEN_SECRET: "",
      LOG_LEVEL: "info",
      LOG_FILE: join(scratch, "api.jsonl"),
    },
    ready: (output) => output.match(LISTENING),
  });
  children.push(api.child);
  const apiPort = Number(api.match[1]);

  // The web app's dev server, forwarding /api to that API.
  const web = await start(
    "the web app",
    [
      join(ROOT, "node_modules", "vite", "bin", "vite.js"),
      "--port",
      String(webPort),
      "--strictPort",
    ],
    {
      cwd: join(ROOT, "apps", "web"),
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? scratch,
        WEB_HOST: "127.0.0.1",
        API_PROXY_TARGET: `http://127.0.0.1:${apiPort}`,
        VITE_TURNSTILE_SITE_KEY: "",
      },
      ready: (output) => output.includes(`:${webPort}`),
    },
  );
  children.push(web.child);

  const { chromium, expect } = await import("@playwright/test");
  browser = await chromium.launch(values.channel ? { channel: values.channel } : {});
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
    colorScheme: "dark",
    timezoneId: "UTC",
    locale: "en-GB",
  });
  const blocked = new Set();
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === webOrigin || url.protocol === "data:" || url.protocol === "blob:") {
      return route.continue();
    }
    if (values.covers && COVER_HOSTS.test(url.hostname)) return route.continue();
    blocked.add(url.host);
    return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);

  const settled = async () => {
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    await page.mouse.move(0, 0);
    await page.waitForFunction(() =>
      document
        .getAnimations()
        .every(
          (animation) =>
            animation.playState !== "running" ||
            animation.effect?.getComputedTiming().iterations === Number.POSITIVE_INFINITY,
        ),
    );
    // Two frames, so what the last animation left is painted.
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
  };
  mkdirSync(outDir, { recursive: true });
  const saved = [];
  const shoot = async (name) => {
    const path = join(outDir, `${name}.png`);
    await page.screenshot({ path, animations: "disabled", caret: "hide" });
    saved.push(path);
  };

  // Search.
  await page.goto(`${webOrigin}/`);
  await expect(page.getByRole("combobox", { name: "Song title and artist" })).toBeVisible();
  await settled();
  await shoot("search");

  // The Dashboard of the demo replay: the replay runs at its recorded pace.
  await page.getByPlaceholder(/Song title/).fill(query);
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  const heading = page
    .locator("section")
    .filter({ has: page.getByRole("button", { name: "View full analysis" }) })
    .getByRole("heading", { level: 1 });
  const openButton = page.getByRole("button", { name: "Open the results" });
  await expect(openButton.or(heading).first()).toBeVisible({ timeout: 180_000 });
  await expect(async () => {
    if (await heading.isVisible()) return;
    if (await openButton.isVisible()) await openButton.click({ timeout: 2_000 });
    await expect(heading).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await settled();
  await shoot("dashboard");

  // Its Player.
  await page.getByRole("button", { name: "View full analysis" }).click();
  await expect(page.getByRole("button", { name: /Back to summary/ })).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await settled();
  await shoot("player");

  // Its song-relations map, full size, from the run the replay stored for the track.
  await page.goto(`${webOrigin}/t/${trackId}/map`);
  const graph = page.locator('[data-map-view] svg[aria-label="Connections graph"]');
  await expect(graph.locator("g.nodes > g").first()).toBeVisible();
  await settled();
  await shoot("map");

  for (const path of saved) {
    console.log(`${relative(ROOT, path)}  ${statSync(path).size} bytes`);
  }
  if (blocked.size)
    console.log(`requests aborted (not this origin): ${[...blocked].sort().join(", ")}`);
}

try {
  await main();
  await cleanUp();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  await cleanUp();
  process.exitCode = 1;
}
