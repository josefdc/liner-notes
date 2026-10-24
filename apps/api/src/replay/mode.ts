/**
 * What REPLAY_MODE means for one request: serve it live, replay a recorded run, or refuse it.
 *
 *   off       always live.
 *   fallback  live while live analysis is available; when it is not, a recorded run when the
 *             request names a recorded track, else refused.
 *   only      a recorded run when the request names a recorded track, else refused. Nothing
 *             live is ever called, so this is decided before any client is built.
 *
 * The mode is read from the environment on every request (startup has already checked it); a
 * value that is not a mode is taken as "only", so a mistake never spends anything.
 */

import { parseReplayMode, REQUIRED_KEYS, type ReplayMode } from "../config/settings.js";
import { replays } from "./records.js";
import type { ReplayRecord } from "@liner-notes/contract";

export function currentReplayMode(env: NodeJS.ProcessEnv = process.env): ReplayMode {
  return parseReplayMode(env.REPLAY_MODE) ?? "only";
}

/**
 * Why live analysis cannot run right now, or null when it can: the Spotify keys every live
 * analysis starts with are not set (REPLAY_MODE=fallback lets the API start without them).
 */
export function liveUnavailableReason(env: NodeJS.ProcessEnv = process.env): string | null {
  const missing = REQUIRED_KEYS.filter((key) => !env[key]);
  return missing.length > 0 ? `${missing.join(", ")} not set` : null;
}

/** True when this request must not use live services: only mode, or fallback without them. */
export function liveRefused(env: NodeJS.ProcessEnv = process.env): boolean {
  const mode = currentReplayMode(env);
  if (mode === "only") return true;
  return mode === "fallback" && liveUnavailableReason(env) !== null;
}

export type ReplayChoice =
  | { kind: "live" }
  | { kind: "replay"; record: ReplayRecord }
  | { kind: "refused" };

/**
 * How to answer a request for the track `find` looks up among the records: live when live
 * services may be used, else that track's recording, else refused (`live_disabled`).
 */
export function chooseReplay(
  find: (records: ReturnType<typeof replays>) => ReplayRecord | null,
  env: NodeJS.ProcessEnv = process.env,
): ReplayChoice {
  if (!liveRefused(env)) return { kind: "live" };
  const record = find(replays(env));
  return record ? { kind: "replay", record } : { kind: "refused" };
}
