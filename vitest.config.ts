import { defineConfig } from "vitest/config";

// A test's default time limit: Vitest's 5 s locally, and 30 s in CI, where GitHub's 2-vCPU runners
// run the CPU-heavy tests several times slower than a workstation (some take over a minute there).
// A test that sets its own limit keeps it.
const testTimeout = process.env.CI ? 30_000 : 5_000;

// One run covers every workspace: `npm test` (or `npx vitest run --project api`).
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "api",
          testTimeout,
          root: "apps/api",
          environment: "node",
          // Tests never load a settings file (see test/setup/noDotenv.ts), replay model calls
          // from cassettes by default (test/setup/llmReplay.ts), write no log lines unless
          // they capture them (test/setup/logging.ts) and do not pace source requests unless
          // they test the pacing (test/setup/sourcePacing.ts).
          setupFiles: [
            "test/setup/noDotenv.ts",
            "test/setup/llmReplay.ts",
            "test/setup/logging.ts",
            "test/setup/sourcePacing.ts",
          ],
          include: ["src/**/*.test.ts", "test/**/*.test.ts"],
        },
      },
      {
        // Uses the app's Vite config, so the `@` alias and the React plugin apply in tests.
        extends: "./apps/web/vite.config.ts",
        test: {
          name: "web",
          testTimeout,
          root: "apps/web",
          environment: "happy-dom",
          include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}", "config/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "contract",
          testTimeout,
          root: "packages/contract",
          environment: "node",
          include: ["src/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "scripts",
          testTimeout,
          root: "scripts",
          environment: "node",
          include: ["**/*.test.{mjs,ts}"],
        },
      },
    ],
  },
});
