#!/usr/bin/env node
// The images a shared link shows, drawn from the recordings (fixtures/replays) with no album art:
//
//   node scripts/static-demo-cards.mjs
//
//   apps/web/demo-assets/og/home.png, og/<trackId>.png   1200 x 630, the static demo's og:image
//   docs/images/social-preview.png                       1280 x 640, the repository's social preview
//
// Each is a page of its own rendered in Playwright's Chromium, using the app's own fonts and
// colours. The strip along the bottom is the track's real map: one dot per related track, placed by
// year and coloured by the kind of its link. The files are committed, so the demo's build needs no
// browser; run this again after a recording changes.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { escapeHtml, relationsOf, shownClaims } from "./static-demo-pages.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPLAYS = join(ROOT, "fixtures", "replays");
const OG = join(ROOT, "apps", "web", "demo-assets", "og");
const SOCIAL = join(ROOT, "docs", "images", "social-preview.png");
const FONT = pathToFileURL(
  join(ROOT, "apps", "web", "public", "fonts", "inter-latin-wght-normal.woff2"),
).href;
const MONO = pathToFileURL(
  join(ROOT, "apps", "web", "public", "fonts", "IBMPlexMono-Regular-Latin1.woff2"),
).href;

const COLOURS = { measured: "#00f0ff", sourced: "#ffb000", inferred: "#c4a4fc", void: "#050505" };
const LOGO =
  '<svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#00f0ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/></svg>';

function loadAnalyses() {
  return readdirSync(REPLAYS)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(REPLAYS, name), "utf8")).analysis);
}

/** The analysed track and its relations on a line by year: real data, drawn small. */
function timeline(analysis, width) {
  const own = analysis.genealogy.nodes.find((node) => node.id === "current")?.year;
  const rows = relationsOf(analysis).filter((row) => row.year);
  const years = [...rows.map((row) => row.year), ...(own ? [own] : [])];
  if (years.length < 2) return "";
  const low = Math.min(...years);
  const high = Math.max(...years);
  const x = (year) =>
    high === low ? width / 2 : ((year - low) / (high - low)) * (width - 24) + 12;
  const dots = rows.map((row, index) => {
    const y = 34 + ((index % 3) - 1) * 18;
    const colour = row.kind === "sourced" ? COLOURS.sourced : COLOURS.inferred;
    return (
      `<line x1="${x(own ?? row.year)}" y1="34" x2="${x(row.year)}" y2="${y}" stroke="${colour}" stroke-opacity=".35"/>` +
      `<circle cx="${x(row.year)}" cy="${y}" r="6" fill="${colour}"/>`
    );
  });
  const centre = own ? `<circle cx="${x(own)}" cy="34" r="10" fill="${COLOURS.measured}"/>` : "";
  return (
    `<svg width="${width}" height="68" aria-hidden="true">${dots.join("")}${centre}</svg>` +
    `<div class="years"><span>${low}</span><span>${high}</span></div>`
  );
}

function chips() {
  return ["measured", "sourced", "inferred"]
    .map(
      (kind) =>
        `<span class="chip" style="color:${COLOURS[kind]};border-color:${COLOURS[kind]}66">${kind}</span>`,
    )
    .join("");
}

function page({ width, height, title, subtitle, foot, strip }) {
  return `<!doctype html><meta charset="utf-8"><style>
    @font-face{font-family:Inter;src:url("${FONT}");font-weight:100 900}
    @font-face{font-family:Mono;src:url("${MONO}")}
    *{box-sizing:border-box;margin:0}
    body{width:${width}px;height:${height}px;background:radial-gradient(circle at 18% 20%,#0d2226,${COLOURS.void} 58%);color:#fff;
      font-family:Inter,sans-serif;padding:60px 72px;display:flex;flex-direction:column;overflow:hidden}
    .brand{display:flex;align-items:center;gap:16px;font-size:28px;font-weight:300;letter-spacing:.04em}
    h1{font-size:${title.length > 34 ? 62 : 76}px;font-weight:650;line-height:1.08;margin-top:44px;letter-spacing:-.015em}
    .subtitle{font-size:34px;color:#ffffffb8;margin-top:16px;line-height:1.3}
    .row{margin-top:auto;display:flex;align-items:center;gap:12px;font:22px Mono,monospace;color:#ffffffb0}
    .chip{border:1.5px solid;border-radius:6px;padding:5px 13px;text-transform:uppercase;font-size:18px;letter-spacing:.09em}
    .foot{margin-left:14px}
    .strip{margin-top:24px}
    .years{display:flex;justify-content:space-between;font:17px Mono,monospace;color:#ffffff8c;margin-top:4px}
  </style><div class="brand">${LOGO}Liner Notes</div>
  <h1>${escapeHtml(title)}</h1><p class="subtitle">${escapeHtml(subtitle)}</p>
  <div class="row">${chips()}<span class="foot">${escapeHtml(foot)}</span></div>
  ${strip ? `<div class="strip">${strip}</div>` : ""}`;
}

async function shoot(browser, html, file, width, height) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const tab = await context.newPage();
  // A local file, so the page may read the app's fonts.
  const dir = mkdtempSync(join(tmpdir(), "card-"));
  const source = join(dir, "card.html");
  writeFileSync(source, html);
  await tab.goto(pathToFileURL(source).href);
  await tab.evaluate(() => document.fonts.ready);
  mkdirSync(dirname(file), { recursive: true });
  await tab.screenshot({ path: file });
  await context.close();
  rmSync(dir, { recursive: true, force: true });
}

const analyses = loadAnalyses();
const browser = await chromium.launch();
try {
  const lead = analyses.find((analysis) => analysis.title === "Hung Up") ?? analyses[0];
  const home = {
    title: "Every claim about a song, with its evidence",
    subtitle: "An AI agent that traces samples, credits and history, and says how it knows.",
    foot: "open source",
  };
  await shoot(
    browser,
    page({ width: 1200, height: 630, ...home }),
    join(OG, "home.png"),
    1200,
    630,
  );
  await shoot(
    browser,
    page({ width: 1280, height: 640, ...home, strip: timeline(lead, 1136) }),
    SOCIAL,
    1280,
    640,
  );
  for (const analysis of analyses) {
    const relations = relationsOf(analysis).length;
    await shoot(
      browser,
      page({
        width: 1200,
        height: 630,
        title: analysis.title.replace(/ - Remastered.*$/, ""),
        subtitle: analysis.artist,
        foot: `${relations} relations · ${shownClaims(analysis).length} claims`,
        strip: timeline(analysis, 1056),
      }),
      join(OG, `${analysis.id}.png`),
      1200,
      630,
    );
  }
} finally {
  await browser.close();
}
