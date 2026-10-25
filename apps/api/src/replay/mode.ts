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

import type { ReplayRecord } from "@liner-notes/contract";
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
 * `quiet` (readiness probes) reads the budget without logging a pause.
 */
export async function liveRefused(
  env: NodeJS.ProcessEnv = process.env,
  purpose: LlmPurpose = defaultAgentRuntime.purpose,
  options: { quiet?: boolean } = {},
): Promise<LiveRefusal | null> {
  const mode = currentReplayMode(env);
  if (mode === "off") return null;
  if (mode === "only" || liveUnavailableReason(env) !== null) return "live_disabled";
  const budget = await liveBudgetState(env, purpose, options);
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
   * The request is about a live result (the client says so): more of it never comes from a
   * recording, whatever live services allow at the moment. More of a replayed result only ever
   * comes from its recording: see recordingFor.
   */
  resultMode?: "live";
}

/**
 * How to answer a request for the track `find` looks up among the records: live when live
 * services may be used, else that track's recording, else refused with the reason live
 * services may not be used (live_disabled or budget_exhausted). For a live result
 * (`resultMode: "live"`) a refusal is never answered with a recording.
 */
export async function chooseReplay(
  find: (records: ReturnType<typeof replays>) => ReplayRecord | null,
  { env = process.env, purpose, resultMode }: ReplayOptions = {},
): Promise<ReplayChoice> {
  const refused = await liveRefused(env, purpose);
  if (!refused) return { kind: "live" };
  if (resultMode === "live") return { kind: "refused", code: refused };
  const record = find(replays(env));
  return record ? { kind: "replay", record } : { kind: "refused", code: refused };
}

/**
 * The recording a replayed result came from, whatever REPLAY_MODE and the budget say: more of a
 * replayed result only ever comes from there. Null when it is no longer served.
 */
export function recordingFor(
  find: (records: ReturnType<typeof replays>) => ReplayRecord | null,
  env: NodeJS.ProcessEnv = process.env,
): ReplayRecord | null {
  return find(replays(env));
}
