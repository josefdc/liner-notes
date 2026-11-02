#!/usr/bin/env node
// Runs the visual baselines (tests/web/visual.spec.ts) in the pinned Playwright container, the
// same image CI's visual job runs in, so the browser, fonts and rasteriser that drew the
// baselines are the ones that compare with them:
//
//   npm run test:visual            compare with the committed baselines
//   npm run test:visual:update     write the baselines that differ, or are missing
//
// Arguments go on to `playwright test` (a spec, `-g <title>`, `--workers <n>`). Needs Linux on
// x64, Docker and `npm ci` run first: the checkout, with its node_modules (built for linux-x64),
// is mounted at the same path. The container runs as the calling user, with no network (the
// mocked API needs none), and is removed when it exits. The image must match the
// @playwright/test version in package.json.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The image's linux/amd64 manifest, by digest: the multi-platform tag also names an arm64 image,
 * whose Chromium draws differently.
 */
export const IMAGE =
  "mcr.microsoft.com/playwright:v1.64.1-noble@sha256:ee15712262f017b8157421b212b12099146645f44b1bc5c0514cbbe6a229b1d0";
export const PLATFORM = "linux/amd64";

// Run, not imported (scripts/visual.test.mjs reads IMAGE and PLATFORM).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();

function run() {
  // node_modules is mounted into the container as it is, so its native packages (esbuild,
  // rollup, lightningcss) must be the linux-x64 ones; and amd64 emulated on another processor
  // is not the rasteriser that drew the baselines.
  if (process.platform !== "linux" || process.arch !== "x64") {
    console.error(
      `The visual baselines run only on Linux x64 (this is ${process.platform} ${process.arch}). ` +
        "Use a Linux x64 machine, or let CI's visual job compare them.",
    );
    process.exit(2);
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");

  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--init",
      "--platform",
      PLATFORM,
      "--name",
      `ln-visual-${process.pid}`,
      "--network",
      "none",
      // Chromium's shared memory; Docker's default 64 MB can crash a tab.
      "--shm-size",
      "1g",
      // The files it writes (baselines, reports, builds) belong to the caller.
      "--user",
      `${process.getuid?.()}:${process.getgid?.()}`,
      "--env",
      "HOME=/tmp",
      "--env",
      "PLAYWRIGHT_VISUAL=1",
      "--env",
      "npm_config_update_notifier=false",
      // Passed on when set: CI's reporter and forbidOnly.
      "--env",
      "CI",
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
    console.error(
      `Could not run docker: ${result.error.message}. The visual baselines need the docker ` +
        "command (Docker Engine; Podman's docker command is not tested).",
    );
    process.exit(2);
  }
  const status = result.status;
  if (status === 125) {
    // docker run itself failed (daemon, permissions, image) before the container started.
    console.error(
      "docker run failed before the tests started: check that the Docker daemon runs and that " +
        "this user may use it (the docker group, or rootless Docker, where the container's user " +
        `must still be able to write the checkout), and that it can pull ${IMAGE}.`,
    );
  } else if (status === 126 || status === 127) {
    console.error(
      "The container could not run the tests (exit " +
        `${status}): run \`npm ci\` in the checkout first, so that its node_modules holds npm's ` +
        "and Playwright's commands.",
    );
  } else if (status !== null && status > 128) {
    console.error(
      `The tests were stopped by signal ${status - 128} (exit ${status}; 137 is usually the ` +
        "container running out of memory).",
    );
  } else if (result.signal) {
    console.error(`docker run was stopped by ${result.signal}.`);
  }
  process.exit(result.status ?? 1);
}
