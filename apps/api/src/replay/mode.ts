/**
 * What REPLAY_MODE means for one request: serve it live, replay a recorded run, or refuse it.
 *
 *   off       always live.
 *   fallback  live while live analysis is available; when it is not, a recorded run when the
 *             request names a recorded track, else refused. Live analysis is unavailable when
 *             the Spotify keys are not set (live_disabled) or when the model budget is spent
 *             (budget_exhausted: a cap would be passed, or the spend log cannot be read).
 *   only      a recorded run when the request names a recorded track, else refused. Nothing
 *             live is ever called, so this is decided before any client is built.
 *
 * The mode is read from the environment on every request (startup has already checked it); a
 * value that is not a mode is taken as "only", so a mistake never spends anything.
 */

import { parseReplayMode, REQUIRED_KEYS, type ReplayMode } from "../config/settings.js";
import { liveBudgetState } from "../llm/budgetState.js";
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

/** The error code of a request refused live services: switched off, or the budget is spent. */
export type LiveRefusal = "live_disabled" | "budget_exhausted";

/**
 * Why this request must not use live services, or null when it may: only mode or fallback
 * without the Spotify keys (live_disabled), or fallback once the model budget is spent
 * (budget_exhausted). The one place every route decides between live and recorded.
 */
export async function liveRefused(
  env: NodeJS.ProcessEnv = process.env,
): Promise<LiveRefusal | null> {
  const mode = currentReplayMode(env);
  if (mode === "off") return null;
  if (mode === "only" || liveUnavailableReason(env) !== null) return "live_disabled";
  return (await liveBudgetState(env)).state === "exhausted" ? "budget_exhausted" : null;
}

export type ReplayChoice =
  | { kind: "live" }
  | { kind: "replay"; record: ReplayRecord }
  | { kind: "refused"; code: LiveRefusal };

/**
 * How to answer a request for the track `find` looks up among the records: live when live
 * services may be used, else that track's recording, else refused with the reason live
 * services may not be used (live_disabled or budget_exhausted).
 */
export async function chooseReplay(
  find: (records: ReturnType<typeof replays>) => ReplayRecord | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReplayChoice> {
  const refused = await liveRefused(env);
  if (!refused) return { kind: "live" };
  const record = find(replays(env));
  return record ? { kind: "replay", record } : { kind: "refused", code: refused };
}
