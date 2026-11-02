#!/usr/bin/env node
// Runs the visual baselines (tests/web/visual.spec.ts) in the pinned Playwright container, the
// same image CI's visual job runs in, so the browser, fonts and rasteriser that drew the
// baselines are the ones that compare with them:
//
//   npm run test:visual            compare with the committed baselines
//   npm run test:visual:update     write the baselines that differ, or are missing
//
// Arguments go on to `playwright test` (a spec, `-g <title>`, `--workers <n>`). Needs Docker and
// `npm ci` run first: the checkout, with its node_modules, is mounted at the same path. The
// container runs as the calling user, with no network (the mocked API needs none), and is
// removed when it exits. The image must match the @playwright/test version in package.json.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const IMAGE =
  "mcr.microsoft.com/playwright:v1.64.1-noble@sha256:2f05f8a734509a7b3f26a912639488ee08f58a7b292d14d62271bcff9038768f";

// Run, not imported (scripts/visual.test.mjs reads IMAGE).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();

function run() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const user =
    typeof process.getuid === "function"
      ? ["--user", `${process.getuid()}:${process.getgid()}`]
      : [];

  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--init",
      "--name",
      `ln-visual-${process.pid}`,
      "--network",
      "none",
      // Chromium's shared memory; Docker's default 64 MB can crash a tab.
      "--shm-size",
      "1g",
      ...user,
      "--env",
      "HOME=/tmp",
      "--env",
      "PLAYWRIGHT_VISUAL=1",
      "--env",
      "npm_config_update_notifier=false",
      // Passed on when set: CI's reporter and forbidOnly, the preview's port.
      "--env",
      "CI",
      "--env",
      "PLAYWRIGHT_WEB_PORT",
      "--volume",
      `${root}:${root}`,
      "--workdir",
      root,
      IMAGE,
      "bash",
      "-eo",
      "pipefail",
      "-c",
      'npm run build -w packages/contract && exec npx playwright test --project=visual "$@"',
      "bash",
      ...process.argv.slice(2),
    ],
    { stdio: "inherit" },
  );
  if (result.error) {
    console.error(`could not run docker: ${result.error.message}`);
    process.exit(2);
  }
  process.exit(result.status ?? 1);
}
