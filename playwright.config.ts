import { defineConfig } from "@playwright/test";

// Browser tests run the web app alone; the API is replaced by tests/mock-sse/mock-api.js.
// Outside the ports the dev setup uses (3000-3002 and the 31x0-31x2 worktree slots).
const port = Number(process.env.PLAYWRIGHT_WEB_PORT ?? 3290);
// Relative to apps/web, one per port: two runs in one checkout never rebuild each other's files.
// Ignored by git and Docker (dist-e2e*).
const outDir = `dist-e2e-${port}`;

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
  // A build served by `vite preview`, made once per run before any worker starts: the dev server
  // compiles each module on its first request, and on a cold cache a page could fail to load a
  // lazy chunk (Dashboard, Player) while the workers' first pages were loading. The build goes to
  // its own directory, so it never replaces apps/web/dist.
  webServer: {
    command:
      `npm run build -w apps/web -- --outDir ${outDir} && ` +
      `npm exec -w apps/web -- vite preview --outDir ${outDir} --host 127.0.0.1 --port ${port} --strictPort`,
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
    },
    // The build's output and any error the preview server reports go to the test log.
    stdout: "pipe",
    url: `http://127.0.0.1:${port}`,
    // Always start our own server: on a shared machine the port may belong to someone else,
    // and --strictPort makes a taken port fail instead of silently testing another app.
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
