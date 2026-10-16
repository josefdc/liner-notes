/**
 * Loads the API's .env from the apps/api directory (not from the working
 * directory) and stops the process when required keys are missing.
 *
 * Imported first by index.ts so modules that read process.env at import
 * time see the loaded values. Variables already set in the environment
 * (e.g. docker compose env_file) take precedence over the file.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const REQUIRED_KEYS = ["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET"] as const;

// Walk up to the package root: src/config/ in development, dist/ when bundled.
function findApiRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

export const ENV_PATH = join(findApiRoot(), ".env");

dotenv.config({ path: ENV_PATH });

const missing = REQUIRED_KEYS.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(
    `[config] Missing required environment variables: ${missing.join(", ")}.\n` +
      `[config] Set them in ${ENV_PATH} (see .env.example) or in the process environment.`
  );
  process.exit(1);
}
