#!/usr/bin/env node
// The README's animation (docs/images/demo.gif), recorded from the static demo's build: a search, the
// replayed analysis, the Dashboard, the Player and the song-relations map of Hung Up (Madonna).
//
//   npm run demo:build && node scripts/demo-gif.mjs [--out docs/images/demo.gif]
//
// Needs ffmpeg on the PATH, and network access for the Cover Art Archive's image.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";
import { serveDemo } from "./serve-static-demo.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SIZE = { width: 1280, height: 720 };
const { values } = parseArgs({
  options: { out: { type: "string", default: "docs/images/demo.gif" } },
});
const out = resolve(ROOT, values.out);
const dir = join(ROOT, "apps", "web", "dist-demo");
if (!existsSync(join(dir, "index.html"))) throw new Error("Run npm run demo:build first.");

const scratch = mkdtempSync(join(tmpdir(), "demo-gif-"));
const { server, url } = await serveDemo({ dir, port: 0 });
const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: SIZE,
    colorScheme: "dark",
    recordVideo: { dir: scratch, size: SIZE },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const pause = (ms) => page.waitForTimeout(ms);

  await page.goto(url);
  await page.getByRole("combobox").waitFor();
  await pause(900);
  await page.getByRole("combobox").pressSequentially("Hung Up", { delay: 90 });
  await pause(700);
  await page
    .getByRole("option", { name: /Hung Up/ })
    .first()
    .click();
  await page.getByRole("button", { name: /view full analysis/i }).waitFor();
  await pause(2600);
  await page.getByRole("button", { name: /view full analysis/i }).click();
  await page.getByRole("link", { name: /open the full map/i }).waitFor();
  await pause(2600);
  await page.getByRole("link", { name: /open the full map/i }).click();
  await page
    .getByRole("heading", { name: /song relations/i })
    .first()
    .waitFor();
  await pause(1600);
  await page.getByRole("button", { name: /Gimme/ }).first().click();
  await pause(3000);
  await context.close();

  const video = readdirSync(scratch).find((name) => name.endsWith(".webm"));
  if (!video) throw new Error("No video was recorded");
  const made = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-loglevel",
      "error",
      "-ss",
      "0.6",
      "-i",
      join(scratch, video),
      "-filter_complex",
      "fps=9,scale=900:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle",
      out,
    ],
    { stdio: "inherit" },
  );
  if (made.status !== 0) throw new Error("ffmpeg failed");
  console.log(`Wrote ${out}`);
} finally {
  await browser.close();
  server.close();
  rmSync(scratch, { recursive: true, force: true });
}
