import { defineConfig } from "@playwright/test";

// Browser tests run the web app alone; the API is replaced by tests/mock-sse/mock-api.js.
// Outside the ports the dev setup uses (3000-3002 and the 31x0-31x2 worktree slots).
const port = Number(process.env.PLAYWRIGHT_WEB_PORT ?? 3290);

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
  webServer: {
    command: `npm run dev -w apps/web -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    // Always start our own server: on a shared machine the port may belong to someone else,
    // and --strictPort makes a taken port fail instead of silently testing another app.
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
