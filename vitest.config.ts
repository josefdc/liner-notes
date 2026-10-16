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
          include: ["src/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "web",
          root: "apps/web",
          environment: "happy-dom",
          include: ["src/**/*.test.{ts,tsx}"],
        },
      },
      {
        test: {
          name: "scripts",
          root: "scripts",
          environment: "node",
          include: ["**/*.test.mjs"],
        },
      },
    ],
  },
});
