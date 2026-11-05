#!/usr/bin/env node
// Builds the static demo: the web app with no API behind it, for a static host such as GitHub Pages.
//
//   node scripts/build-static-demo.mjs [--site https://josefdc.github.io/liner-notes] [--out apps/web/dist-demo]
//
// 1. Builds the web app with VITE_STATIC_DEMO=1, under the path of `--site`.
// 2. Starts the API with REPLAY_MODE=only, dummy keys and outbound network denied
//    (scripts/replay-api-env.mjs), and keeps what it answers for each recorded track: the analysis
//    stream, the stored result, the "More facts" stream, and its refusal of any other song. So the
//    demo serves the API's own answers, including what it does to a recording when serving it.
// 3. Writes those answers to `demo-data/`, and a page for each address (`/`, `/t/<id>/`,
//    `/t/<id>/map/`) with its own title, description, canonical address, link preview, JSON-LD and a
//    plain article (scripts/static-demo-pages.mjs), plus 404.html and sitemap.xml.
//
// There is no robots.txt: a crawler reads one only at a host's root, which a project's GitHub Pages
// site does not own. Submit sitemap.xml in Google Search Console instead.
//
// Refuses to start while apps/api/.env exists, as scripts/readme-shots.mjs does. Exits 1 when an
// answer is missing or the network guard counted an outbound attempt.

import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { replayApiEnv } from "./replay-api-env.mjs";
import {
  homePage,
  mapPage,
  renderNotFound,
  renderPage,
  sitemapXml,
  trackPage,
} from "./static-demo-pages.mjs";
import { readReportFile } from "./stop-server.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WEB = join(ROOT, "apps", "web");
const LISTENING = /"msg":"Liner Notes API listening on port (\d+)"/;
const CAPTURE_ORIGIN = "http://127.0.0.1:3000";
const STREAM_LIMIT_MS = 120_000;

const { values } = parseArgs({
  options: {
    site: { type: "string", default: "https://josefdc.github.io/liner-notes" },
    out: { type: "string", default: "apps/web/dist-demo" },
  },
});
const site = values.site.replace(/\/+$/, "");
const out = resolve(ROOT, values.out);
const base = `${new URL(site).pathname.replace(/\/+$/, "")}/`;

const scratch = mkdtempSync(join(tmpdir(), "static-demo-"));
const report = join(scratch, "deny-network.jsonl");
let api = null;

/** The web app's build, under the site's path. */
function buildWeb() {
  const built = spawnSync(
    "npm",
    ["run", "build", "-w", "apps/web", "--", `--base=${base}`, `--outDir=${out}`, "--emptyOutDir"],
    { cwd: ROOT, stdio: "inherit", env: { ...process.env, VITE_STATIC_DEMO: "1" } },
  );
  if (built.status !== 0) throw new Error("The web build failed");
}

/** Starts the API; resolves with its address once it listens. */
function startApi() {
  return new Promise((resolveStart, reject) => {
    api = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: join(ROOT, "apps", "api"),
      env: replayApiEnv({
        scratch,
        report,
        logFile: join(scratch, "api.jsonl"),
        corsOrigins: CAPTURE_ORIGIN,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const timer = setTimeout(() => reject(new Error(`The API did not start:\n${output}`)), 120_000);
    const listen = (chunk) => {
      output += chunk;
      const match = output.match(LISTENING);
      if (match) {
        clearTimeout(timer);
        resolveStart(`http://127.0.0.1:${match[1]}`);
      }
    };
    api.stdout.on("data", listen);
    api.stderr.on("data", listen);
    api.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`The API exited with ${code}:\n${output}`));
    });
  });
}

function stopApi() {
  return new Promise((done) => {
    if (!api || api.exitCode !== null || api.signalCode !== null) return done();
    const kill = setTimeout(() => api.kill("SIGKILL"), 10_000);
    api.removeAllListeners("exit");
    api.once("exit", () => {
      clearTimeout(kill);
      done();
    });
    api.kill("SIGTERM");
  });
}

const HEADERS = { Origin: CAPTURE_ORIGIN, "Sec-Fetch-Site": "same-origin" };

/** A JSON answer of the API; an error status fails unless `allow` lists it. */
async function getJson(url, init = {}) {
  const response = await fetch(url, { ...init, headers: { ...HEADERS, ...init.headers } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

/**
 * The events of a stream until it ends, with the time each was sent after the stream opened.
 * Heartbeats are left out: the demo's stream never goes silent for long, and arms no watchdog.
 */
async function captureStream(url) {
  const signal = AbortSignal.timeout(STREAM_LIMIT_MS);
  const response = await fetch(url, {
    headers: { ...HEADERS, Accept: "text/event-stream" },
    signal,
  });
  if (!response.ok || !response.body) throw new Error(`${url}: HTTP ${response.status}`);
  const started = Date.now();
  const events = [];
  let buffer = "";
  const decoder = new TextDecoderStream();
  for await (const chunk of response.body.pipeThrough(decoder)) {
    buffer += chunk;
    let end = buffer.indexOf("\n\n");
    while (end !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      end = buffer.indexOf("\n\n");
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      const { type } = JSON.parse(data);
      if (type === "heartbeat") continue;
      events.push({ atMs: Date.now() - started, data });
      if (type === "done") return events;
    }
  }
  return events;
}

function writeFile(path, text) {
  const file = join(out, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

async function capture(apiUrl) {
  // A run token opens one stream.
  const newToken = async () => {
    const { runToken } = await getJson(`${apiUrl}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ turnstileToken: "dev-bypass" }),
    });
    return runToken;
  };
  const { replays } = await getJson(`${apiUrl}/api/replays`);
  if (replays.length === 0) throw new Error("The API lists no recorded tracks");

  const refusal = await captureStream(
    `${apiUrl}/api/analyze/stream?query=${encodeURIComponent("no recording of this song")}&runToken=${await newToken()}`,
  );
  if (!refusal.some(({ data }) => JSON.parse(data).code === "live_disabled")) {
    throw new Error("The API did not refuse a song without a recording as live_disabled");
  }

  const analyses = [];
  const suggestions = [];
  for (const replay of replays) {
    const query = encodeURIComponent(`${replay.title} ${replay.artist}`);
    const stream = await captureStream(
      `${apiUrl}/api/analyze/stream?query=${query}&trackId=${replay.id}&runToken=${await newToken()}`,
    );
    const stored = await getJson(`${apiUrl}/api/runs/by-track/${replay.id}`);
    if (stored.analysis?.id !== replay.id) throw new Error(`No stored result for ${replay.id}`);
    const { analysis } = stored;
    const facts = new URLSearchParams({
      trackTitle: analysis.title,
      trackArtist: analysis.artist,
      existingIds: analysis.factoids.map((factoid) => factoid.id).join(","),
      round: "0",
      runId: analysis.run.id,
      mode: "replay",
      runToken: await newToken(),
    });
    const moreFacts = await captureStream(`${apiUrl}/api/factoids/more/stream?${facts}`);
    writeFile(`demo-data/${replay.id}.json`, JSON.stringify({ stored, stream, moreFacts }));
    analyses.push(analysis);
    const { id, title, artist, album, coverUrl, releaseYear, isrc } = analysis;
    suggestions.push({ id, title, artist, album, coverUrl, releaseYear, isrc });
  }
  writeFile("demo-data/index.json", JSON.stringify({ replays, suggestions, refusal }));
  return analyses;
}

function writePages(analyses) {
  const template = readFileSync(join(out, "index.html"), "utf8");
  const pages = [
    homePage(site, analyses),
    ...analyses.flatMap((analysis) => [trackPage(site, analysis), mapPage(site, analysis)]),
  ];
  for (const page of pages) writeFile(page.path, renderPage(template, page));
  writeFile("404.html", renderNotFound(template, site));
  writeFile("sitemap.xml", sitemapXml(pages, new Date().toISOString().slice(0, 10)));
  const cards = join(WEB, "demo-assets", "og");
  if (existsSync(cards)) cpSync(cards, join(out, "og"), { recursive: true });
  // GitHub Pages runs a site through Jekyll without this file, which drops some paths.
  writeFile(".nojekyll", "");
  return pages;
}

async function main() {
  const settings = join(ROOT, "apps", "api", ".env");
  if (existsSync(settings)) {
    throw new Error(`${relative(ROOT, settings)} exists: move it aside (it is not read).`);
  }
  buildWeb();
  const analyses = await capture(await startApi());
  await stopApi();
  const attempts = readReportFile(report).lines.reduce(
    (sum, line) => sum + (line.attempts ?? 0),
    0,
  );
  if (attempts > 0) throw new Error(`The API tried the network ${attempts} time(s): see ${report}`);
  const pages = writePages(analyses);
  console.log(
    `${pages.length} pages and ${analyses.length} recorded tracks in ${relative(ROOT, out)}, for ${site}/`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await stopApi();
    rmSync(scratch, { recursive: true, force: true });
  });
