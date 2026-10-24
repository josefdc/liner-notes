/**
 * What REPLAY_MODE means for one request: serve it live, replay a recorded run, or refuse it.
 *
 *   off       always live.
 *   fallback  live while live analysis is available; when it is not, a recorded run when the
 *             request names a recorded track, else refused. Live analysis is unavailable when
 *             the Spotify keys are not set or the spend log cannot be used (live_disabled), or
 *             when a cap of the model budget is reached (budget_exhausted).
 *   only      a recorded run when the request names a recorded track, else refused. Nothing
 *             live is ever called, so this is decided before any client is built.
 *
 * The mode is read from the environment on every request (startup has already checked it); a
 * value that is not a mode is taken as "only", so a mistake never spends anything.
 */

import type { ReplayRecord, RunMode } from "@liner-notes/contract";
import { defaultAgentRuntime } from "../agent/runtime.js";
import {
  type LlmPurpose,
  parseReplayMode,
  REQUIRED_KEYS,
  type ReplayMode,
} from "../config/settings.js";
import { liveBudgetState } from "../llm/budgetState.js";
import { replays } from "./records.js";

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
 * Why this request must not use live services, or null when it may: only mode, or fallback
 * without the Spotify keys or with a spend log that cannot be used (live_disabled: live
 * analysis is off on this server), or fallback once a cap of the model budget is reached
 * (budget_exhausted). The one place every route decides between live and recorded.
 *
 * `purpose` is the budget purpose of the live work the request would start: the analysis
 * runtime's by default (agent/runtime.ts), so the pause follows the same caps as its calls.
 */
export async function liveRefused(
  env: NodeJS.ProcessEnv = process.env,
  purpose: LlmPurpose = defaultAgentRuntime.purpose,
): Promise<LiveRefusal | null> {
  const mode = currentReplayMode(env);
  if (mode === "off") return null;
  if (mode === "only" || liveUnavailableReason(env) !== null) return "live_disabled";
  const budget = await liveBudgetState(env, purpose);
  if (budget.state === "exhausted") return "budget_exhausted";
  if (budget.state === "unverifiable") return "live_disabled";
  return null;
}

export type ReplayChoice =
  | { kind: "live" }
  | { kind: "replay"; record: ReplayRecord }
  | { kind: "refused"; code: LiveRefusal };

export interface ReplayOptions {
  env?: NodeJS.ProcessEnv;
  /** The budget purpose of the live work (see liveRefused). */
  purpose?: LlmPurpose;
  /**
   * How the result the request is about was produced, when the client says so: more of a
   * replayed result only ever comes from its recording, and more of a live result never does,
   * whatever live services allow at the moment.
   */
  resultMode?: RunMode;
}

/**
 * How to answer a request for the track `find` looks up among the records: live when live
 * services may be used, else that track's recording, else refused with the reason live
 * services may not be used (live_disabled or budget_exhausted). With `resultMode` the answer
 * stays on that side: a replayed result gets its recording or live_disabled, a live result gets
 * live services or the refusal.
 */
export async function chooseReplay(
  find: (records: ReturnType<typeof replays>) => ReplayRecord | null,
  { env = process.env, purpose, resultMode }: ReplayOptions = {},
): Promise<ReplayChoice> {
  if (resultMode === "replay") {
    const record = find(replays(env));
    return record ? { kind: "replay", record } : { kind: "refused", code: "live_disabled" };
  }
  const refused = await liveRefused(env, purpose);
  if (!refused) return { kind: "live" };
  if (resultMode === "live") return { kind: "refused", code: refused };
  const record = find(replays(env));
  return record ? { kind: "replay", record } : { kind: "refused", code: refused };
}
