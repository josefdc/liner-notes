import { defineConfig } from "@playwright/test";

// Browser tests run the web app alone; the API is replaced by tests/mock-sse/mock-api.js.
const port = Number(process.env.PLAYWRIGHT_WEB_PORT ?? 3110);

export default defineConfig({
  testDir: "tests",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${port}`,
    // System Chrome: no browser download.
    channel: "chrome",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `npm run dev -w apps/web -- --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    // Always start our own server: on a shared machine the port may belong to someone else,
    // and --strictPort makes a taken port fail instead of silently testing another app.
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
