import { defineConfig } from "tsup";

export default defineConfig({
  // The server, and the run report (`node dist/report.js` in the API image).
  entry: { index: "src/index.ts", report: "src/scripts/report.ts" },
  format: ["esm"],
  target: "node24",
  platform: "node",
  outDir: "dist",
  clean: true,
  splitting: false,
  external: ["better-sqlite3"],
});
