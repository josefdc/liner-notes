import { defineConfig } from "@playwright/test";

// Browser tests run the web app alone; the API is replaced by tests/mock-sse/mock-api.js.
// They use two ports, PLAYWRIGHT_WEB_PORT and the one after it (3290 and 3291 by default; both
// must be free): outside the ports the dev setup uses (3000-3002 and the 31x0-31x2 worktree
// slots).
const port = Number(process.env.PLAYWRIGHT_WEB_PORT ?? 3290);
// A second build, served on the next port, made with Cloudflare's always-passing test site key:
// the Turnstile specs run against it, with Cloudflare's script replaced by a route. Every other
// spec runs against the build without a site key, as development does.
const turnstilePort = port + 1;
const TURNSTILE_SPECS = "**/turnstile*.spec.ts";
// The visual baselines (tests/web/visual*.spec.ts) are rendered and compared only in the pinned
// Playwright container, which `npm run test:visual` (scripts/visual.mjs) and CI's visual job run
// with PLAYWRIGHT_VISUAL=1: the `visual` project exists only there, and is then the only one, so
// no other browser can compare with the baselines or write them. Everywhere else they are ignored.
const VISUAL_SPECS = "**/visual*.spec.ts";
const visual = process.env.PLAYWRIGHT_VISUAL === "1";

export default defineConfig({
  testDir: "tests",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // The mocked API is deterministic: a flaky run is a bug, so no retries.
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    // System Chrome: no browser download.
    channel: "chrome",
    trace: "retain-on-failure",
  },
  // The visual project's workers share one preview server, in a container that may see every
  // core of the machine; elsewhere Playwright's default.
  workers: visual ? 4 : undefined,
  projects: visual
    ? [
        {
          name: "visual",
          testMatch: VISUAL_SPECS,
          // One file per view, size and ratio, named by the test, for every platform alike: the
          // container is the only platform.
          snapshotPathTemplate: "{testDir}/web/__screenshots__/{testFileName}/{arg}{ext}",
          use: {
            // The container's own Chromium (it has no Google Chrome).
            channel: "chromium",
            reducedMotion: "reduce",
          },
          expect: {
            toHaveScreenshot: {
              animations: "disabled",
              caret: "hide",
              // Up to 0.02% of the pixels may differ: two runs in the same container differ
              // by up to 0.005% (a few dozen antialiased pixels on the map and the Dashboard's
              // chart), and another CPU can differ a little more (Skia's software rasteriser
              // picks its code by the CPU's instruction set). One card's padding 1 px larger
              // changes 0.1-0.2% of the window.
              maxDiffPixelRatio: 0.0002,
            },
          },
        },
      ]
    : [
        { name: "no-site-key", testIgnore: [TURNSTILE_SPECS, VISUAL_SPECS] },
        {
          name: "site-key",
          testMatch: TURNSTILE_SPECS,
          use: { baseURL: `http://127.0.0.1:${turnstilePort}` },
        },
      ],
  // Builds served by `vite preview`, made once per run before any worker starts: the dev server
  // compiles each module on its first request, and on a cold cache a page could fail to load a
  // lazy chunk (Dashboard, Player) while the workers' first pages were loading. The servers start
  // one after the other, so the two builds never run at the same time.
  // The visual project needs only the build without a site key.
  webServer: [
    previewServer(port, {}),
    ...(visual
      ? []
      : [previewServer(turnstilePort, { VITE_TURNSTILE_SITE_KEY: "1x00000000000000000000AA" })]),
  ],
});

/**
 * A build served by `vite preview` on `servedPort`, made with `env` besides the shared settings.
 * The build goes to a directory of its own per port (relative to apps/web, ignored by git and
 * Docker as dist-e2e*), so runs on different ports in one checkout never empty each other's
 * build (they still both rebuild packages/contract/dist), and it never replaces apps/web/dist.
 */
function previewServer(servedPort: number, env: Record<string, string>) {
  const outDir = `dist-e2e-${servedPort}`;
  return {
    command:
      `npm run build -w apps/web -- --outDir ${outDir} && ` +
      `npm exec -w apps/web -- vite preview --outDir ${outDir} --host 127.0.0.1 --port ${servedPort} --strictPort`,
    env: {
      // React's development build: the specs fail on console errors and warnings, and React
      // reports duplicate or missing keys, invalid nesting and the like only in that build.
      // (`vite build --mode development` alone still bundles the production one.)
      NODE_ENV: "development",
      // /api on the page's own origin, which the mock replaces in the browser.
      VITE_API_URL: "/api",
      // A request no mock or route answers reaches the preview's /api proxy: send it to a closed
      // port, so it fails instead of reaching an API someone runs on this machine.
      API_PROXY_TARGET: "http://127.0.0.1:9",
      ...env,
    },
    // The build's output and any error the preview server reports go to the test log.
    stdout: "pipe" as const,
    // Ready only when this run's own preview says it listens on the port. Not `url`: Playwright
    // would accept any server that answers there, such as another checkout's preview started
    // while this one was building, and run the tests against it. --strictPort makes our preview
    // exit when the port is taken, and that exit fails the run.
    wait: { stdout: new RegExp(`Local:\\s+http://127\\.0\\.0\\.1:${servedPort}/`) },
    timeout: 60_000,
  };
}
