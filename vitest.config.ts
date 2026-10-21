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
          // Several modules load apps/api/.env on import, and dotenv never replaces a variable that
          // is already set: these empty values keep a developer's .env from reaching the tests
          // (real credentials, a custom User-Agent, cassette mode). A test that needs one sets it.
          env: {
            MUSICBRAINZ_USER_AGENT: "",
            SOURCE_USER_AGENT: "",
            SOURCE_TIMEOUT_MS: "",
            SOURCE_CASSETTE: "",
            DISCOGS_TOKEN: "",
            SHS_API_KEY: "",
            GENIUS_ACCESS_TOKEN: "",
            GEMINI_API_KEY: "",
            TAVILY_API_KEY: "",
            LASTFM_API_KEY: "",
          },
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
          include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}"],
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
