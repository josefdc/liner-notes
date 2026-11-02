#!/usr/bin/env node
// The README's screenshots, taken from the showcase replays (fixtures/replays), never from a live
// analysis: no model call, no source call, no key.
//
//   node scripts/readme-shots.mjs [--out docs/images] [--covers] [--channel chrome]
//
// Refuses to start while the API's settings file (apps/api/.env) exists, so nothing of a
// developer's settings or keys can reach the API it starts; it checks only that the file exists,
// and never reads it. Starts the API with the environment scripts/replay-e2e.mjs gives it
// (scripts/replay-api-env.mjs: REPLAY_MODE=only, dummy keys, every setting pinned, a scratch
// database, tests/deny-network.mjs preloaded), and the web app's Vite dev server forwarding /api
// to it, with the same network guard, both on free loopback ports.
// Then, in Playwright's Chromium (`--channel chrome` for Google Chrome) at 1440 x 900, device pixel
// ratio 1, motion reduced, it opens and saves:
//
//   search.png      the landing page
//   dashboard.png   the Dashboard of the demo replay, One More Time (Daft Punk)
//   player.png      its Player ("View full analysis")
//   map.png         the song-relations map of Hung Up (Madonna), full size (/t/<id>/map)
//
// The browser may load only the page's own origin: every other request is aborted, so nothing
// leaves the machine and the album cover shows as not loaded. `--covers` lets the Cover Art
// Archive's images load (coverartarchive.org and archive.org), to show the cover as the app does.
//
// The dashboard is saved down to the row that holds its "Connections" heading, which starts near
// the window's bottom edge, so the row is left out whole rather than cut. The map is Hung Up's,
// whose timeline fits the window (the map cannot zoom out below 1); the run fails when an
// "N more" cue shows that a track is out of view.
//
// The PNGs are what Chromium writes, unmodified (the dashboard's clipped by the screenshot call).
// Once both servers have exited, it reads the network guard's report: any outbound attempt by
// either fails the run. Exits 1 when a view does not show or the guard counted an attempt.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { replayApiEnv } from "./replay-api-env.mjs";
import { readReportFile } from "./stop-server.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEMO = "one-more-time-daft-punk";
// The map's showcase: its timeline fits 1440 px (4 year columns), where One More Time's (9 years)
// runs off the right edge, and the map cannot zoom out below 1.
const MAP_DEMO = "hung-up-madonna";
const VIEWPORT = { width: 1440, height: 900 };
const LISTENING = /"msg":"Liner Notes API listening on port (\d+)"/;
const COVER_HOSTS = /(^|\.)(coverartarchive\.org|archive\.org)$/;
// The unspecified addresses (0.0.0.0, ::, and :: written out in full).
const UNSPECIFIED = /^(0\.0\.0\.0|::|0000(:0000){7})$/;

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

/**
 * Starts `args` with node in `cwd`; resolves with the child once `ready(output)` matches. The
 * child is in `children` from its spawn, so cleanUp() stops it whatever happens; when it is not
 * ready within `timeoutMs`, it is stopped at once and the start fails.
 */
function start(name, args, { cwd, env, ready, timeoutMs = 120_000 }) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let output = "";
  const append = (chunk) => {
    output += chunk;
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  return new Promise((resolveStart, reject) => {
    const timer = setTimeout(() => {
      clearInterval(poll);
      child.kill("SIGTERM");
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

const SETTINGS_FILE = join(ROOT, "apps", "api", ".env");
const scratch = mkdtempSync(join(tmpdir(), "readme-shots-"));
const report = join(scratch, "deny-network.jsonl");
const children = [];
let browser;

/** Stops the servers and waits for them to exit (SIGKILL after 10 s). */
async function stopChildren() {
  await browser?.close().catch(() => {});
  await Promise.all(
    children.map(
      (child) =>
        new Promise((done) => {
          if (child.exitCode !== null || child.signalCode !== null) return done();
          const kill = setTimeout(() => child.kill("SIGKILL"), 10_000);
          child.once("exit", () => {
            clearTimeout(kill);
            done();
          });
          child.kill("SIGTERM");
        }),
    ),
  );
}

async function cleanUp() {
  await stopChildren();
  rmSync(scratch, { recursive: true, force: true });
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    cleanUp().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  });
}

async function main() {
  if (existsSync(SETTINGS_FILE)) {
    throw new Error(
      `${relative(ROOT, SETTINGS_FILE)} exists: move it aside while the screenshots are taken, so ` +
        "none of its settings or keys can reach the API this starts (it is not read).",
    );
  }
  const recordingOf = (name) =>
    JSON.parse(readFileSync(join(ROOT, "fixtures", "replays", `${name}.json`), "utf8"));
  const { query } = recordingOf(DEMO).request;
  const mapRecording = recordingOf(MAP_DEMO);
  const webPort = await freePort();
  const webOrigin = `http://127.0.0.1:${webPort}`;

  // The API, replaying recordings only, with every setting it reads pinned here.
  const api = await start("the API", ["--import", "tsx", "src/index.ts"], {
    cwd: join(ROOT, "apps", "api"),
    env: replayApiEnv({
      scratch,
      report,
      logFile: join(scratch, "api.jsonl"),
      corsOrigins: webOrigin,
    }),
    ready: (output) => output.match(LISTENING),
  });
  const apiPort = Number(api.match[1]);

  // The web app's dev server, forwarding /api to that API.
  await start(
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
        NODE_OPTIONS: `--import ${join(ROOT, "tests", "deny-network.mjs")}`,
        DENY_NETWORK_REPORT: report,
        WEB_HOST: "127.0.0.1",
        API_PROXY_TARGET: `http://127.0.0.1:${apiPort}`,
        VITE_TURNSTILE_SITE_KEY: "",
      },
      ready: (output) => output.includes(`:${webPort}`),
    },
  );

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
  const shoot = async (name, clip) => {
    const path = join(outDir, `${name}.png`);
    await page.screenshot({ path, animations: "disabled", caret: "hide", clip });
    saved.push(path);
  };

  /** Analyses `text` (a replay, at its recorded pace) and opens its Dashboard. */
  const analyse = async (text) => {
    await page.goto(`${webOrigin}/`);
    await page.getByPlaceholder(/Song title/).fill(text);
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
  };

  // Search.
  await page.goto(`${webOrigin}/`);
  await expect(page.getByRole("combobox", { name: "Song title and artist" })).toBeVisible();
  await settled();
  await shoot("search");

  // The Dashboard of the demo replay, down to the row that holds "Connections": that row starts
  // near the window's bottom edge, so it is left out whole rather than cut.
  await analyse(query);
  const rowTop = await page.evaluate(() => {
    const heading = [...document.querySelectorAll("h2")].find(
      (h) => h.textContent?.trim() === "Connections",
    );
    const grid = heading?.closest(".lg\\:col-span-2")?.parentElement;
    if (!grid) return null;
    return Math.min(...[...grid.children].map((child) => child.getBoundingClientRect().top));
  });
  if (rowTop === null) throw new Error('the Dashboard shows no "Connections" heading');
  await shoot(
    "dashboard",
    rowTop < VIEWPORT.height
      ? { x: 0, y: 0, width: VIEWPORT.width, height: Math.floor(rowTop) - 24 }
      : undefined,
  );

  // Its Player.
  await page.getByRole("button", { name: "View full analysis" }).click();
  await expect(page.getByRole("button", { name: /Back to summary/ })).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await settled();
  await shoot("player");

  // The map's showcase, full size, from the run its replay stored for the track; every track of
  // it must be in view (no "N more" cue at an edge).
  await analyse(mapRecording.request.query);
  await page.goto(`${webOrigin}/t/${mapRecording.analysis.id}/map`);
  const graph = page.locator('[data-map-view] svg[aria-label="Connections graph"]');
  await expect(graph.locator("g.nodes > g").first()).toBeVisible();
  await settled();
  const cues = page.locator("[data-map-view]").getByText(/^\s*(← )?\d+ more\b/);
  if ((await cues.count()) > 0) {
    throw new Error(`the map does not fit the window: ${await cues.first().innerText()}`);
  }
  await shoot("map");

  for (const path of saved) {
    console.log(`${relative(ROOT, path)}  ${statSync(path).size} bytes`);
  }
  if (blocked.size)
    console.log(`requests aborted (not this origin): ${[...blocked].sort().join(", ")}`);
}

/** The guard's report once both servers have exited: throws on any outbound attempt. */
function checkGuard() {
  const { lines, unreadable } = readReportFile(report);
  const pids = new Set(lines.map((line) => line.pid));
  // Vite checks that its port is free by listening on each wildcard address, the unspecified IPv6
  // address among them written out in full; the guard counts the lookup of that spelling. It is
  // a bind on this machine, not a connection out, so it is printed and not counted.
  const local = lines.filter(
    (line) => (line.hosts ?? []).length > 0 && line.hosts.every((host) => UNSPECIFIED.test(host)),
  );
  for (const line of local)
    console.log(`deny-network: not counted (a local bind): ${line.hosts.join(", ")}`);
  const attempts = lines.filter(
    (line) => !local.includes(line) && (line.event === "blocked" || line.attempts > 0),
  );
  console.log(
    `deny-network: ${pids.size} guarded process(es), ${attempts.length} report line(s) with an attempt`,
  );
  if (pids.size === 0) throw new Error("the network guard wrote no report: was it loaded?");
  if (unreadable.length > 0) throw new Error(`unreadable report lines: ${unreadable[0]}`);
  if (attempts.length > 0) {
    const named = attempts.map(
      (line) => `${line.argv.join(" ")}: ${(line.hosts ?? []).join(", ") || "(hosts not named)"}`,
    );
    throw new Error(`outbound attempts by a server:\n  ${[...new Set(named)].join("\n  ")}`);
  }
}

try {
  await main();
  await stopChildren();
  checkGuard();
  await cleanUp();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  await cleanUp();
  process.exitCode = 1;
}
