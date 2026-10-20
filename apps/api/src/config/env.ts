/**
 * Loads the API's .env from the apps/api directory (not from the working directory), validates
 * the settings once and stops the process when they are invalid.
 *
 * Imported first by index.ts so modules that read process.env at import time see the loaded
 * values. Variables already set in the environment (e.g. docker compose env_file) take
 * precedence over the file. REPLAY_MODE=only needs no Spotify or model keys.
 */

import { join } from "node:path";
import dotenv from "dotenv";
import { API_ROOT } from "./apiPackage.js";
import { readSettings, type Settings } from "./settings.js";

export const ENV_PATH = join(API_ROOT, ".env");

dotenv.config({ path: ENV_PATH });

const result = readSettings(process.env);
if (!result.ok) {
  for (const error of result.errors) console.error(`[config] ${error}`);
  console.error(
    `[config] Set them in ${ENV_PATH} (see .env.example) or in the process environment.`,
  );
  process.exit(1);
}
for (const warning of result.warnings) console.warn(`[config] ${warning}`);

export const settings: Settings = result.settings;
