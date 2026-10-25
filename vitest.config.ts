import { defineConfig } from "vitest/config";

// One run covers every workspace: `npm test` (or `npx vitest run --project api`).
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "api",
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
          root: "apps/web",
          environment: "happy-dom",
          include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}", "config/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "contract",
          root: "packages/contract",
          environment: "node",
          include: ["src/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "scripts",
          root: "scripts",
          environment: "node",
          include: ["**/*.test.{mjs,ts}"],
        },
      },
    ],
  },
});
