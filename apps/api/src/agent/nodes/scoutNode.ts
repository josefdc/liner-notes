/**
 * Scout Node — Searches Spotify, picks the result that matches the query, and returns the
 * candidates instead when the user has to choose (see trackMatch.ts). A request for a track by
 * its Spotify id (a suggestion or a node) reads that track instead of searching. A result stored
 * for the chosen track is served without composing it again (storedResults.ts): the search
 * always runs first, so what is served is about the track this query finds now.
 *
 * When no track is found the scout says why as a type (`scoutFailure`): nothing matched, Spotify
 * kept rate limiting, or Spotify could not answer. Spotify's errors are typed (sources/http.ts).
 *
 * Retries (each Spotify call, at most 3 attempts in all): a rate limit (429), a 408 or 5xx
 * answer, a timeout (SOURCE_TIMEOUT_MS per request) or a network error is tried again; any other
 * error is not. A rate limit that says how long to wait (Retry-After) is waited out when that is
 * at most MAX_RETRY_WAIT_MS, and ends the search at once when it is longer; any other wait is a
 * 1 s, then 2 s backoff. Each wait is said in a status line, and a cancelled run cuts it short.
 * In a Spotify outage that is 3 requests and up to about 33 s before the run fails.
 */

import { getStore } from "@langchain/langgraph";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { SearchCandidate as SearchCandidateSchema } from "@liner-notes/contract";
import { isSourceError } from "../../sources/http.js";
import { fetchTrack, searchTracks } from "../../sources/spotify.js";
import { isAbortError, retryAfterWait, withRetry } from "../errors.js";
import { type AgentRuntime, defaultAgentRuntime, timestampOf } from "../runtime.js";
import type { ScoutFailure, SonicAgentStateType, SpotifyData } from "../state.js";
import type { SearchCandidate } from "../schema.js";
import { readStoredResult, servedResult, shownQueryMatch } from "../storedResults.js";
import { matchTrack, needsChoice, rankTracks } from "../trackMatch.js";

/** The longest Retry-After the scout waits out before trying Spotify again. */
export const MAX_RETRY_WAIT_MS = 10_000;

type Update = Partial<SonicAgentStateType>;

/** A Spotify call with the scout's retries (see the top of this file), each wait said. */
function withSpotifyRetry<T>(
  fn: () => Promise<T>,
  config: LangGraphRunnableConfig,
  runtime: AgentRuntime,
): Promise<T> {
  return withRetry(fn, {
    signal: config.signal,
    retryDelay: (error) => retryAfterWait(error, MAX_RETRY_WAIT_MS),
    onWait: (ms, error) => {
      const seconds = Math.max(1, Math.ceil(ms / 1000));
      config.writer?.({
        type: "status",
        code: "SYS-WARN",
        message: isSourceError(error, "rate_limited")
          ? `Spotify is rate limiting requests; trying again in ${seconds} s...`
          : `Spotify did not answer; trying again in ${seconds} s...`,
        node: "scout",
        timestamp: timestampOf(runtime),
      });
    },
  });
}

/** Why a Spotify call failed, as the scout reports it. */
function failureOf(error: unknown): ScoutFailure {
  if (isSourceError(error, "rate_limited")) {
    return { kind: "rate_limited", retryAfterMs: error.retryAfterMs ?? null };
  }
  return { kind: "upstream_unavailable" };
}

/** The scout's update for a run that found no track. */
function failed(failure: ScoutFailure, error: string, status: string): Update {
  console.warn(`⚠️ [Scout] ${error}`);
  return { error, scoutFailure: failure, statusMessages: [status] };
}

/** A selected track, served from the store when a result is stored for it. */
async function selectedTrack(
  selected: Update & { spotifyData: SpotifyData },
  config: LangGraphRunnableConfig,
  runtime: AgentRuntime,
): Promise<Update> {
  const track = selected.spotifyData;
  const stored = await readStoredResult(getStore(), track.id, runtime.now());
  config.signal?.throwIfAborted();
  if (stored) {
    console.log("📦 [Scout] Stored result for:", track.id);
    const trackData = servedResult(stored, shownQueryMatch(selected));
    config.writer?.({
      type: "status",
      code: "NET-200",
      message: "Cache hit — returning stored analysis",
      node: "scout",
      timestamp: timestampOf(runtime),
    });
    config.writer?.({ type: "complete", data: trackData });
    return { ...selected, trackData };
  }

  config.writer?.({
    type: "status",
    code: "SPOTIFY-FOUND",
    message: `Target acquired: "${track.title}" // ${track.artist}`,
    node: "scout",
    timestamp: timestampOf(runtime),
  });
  console.log("✅ [Scout] Selected:", track.title, "by", track.artist);
  return { ...selected, statusMessages: [`✅ Found: "${track.title}" by ${track.artist}`] };
}

/**
 * The track the request asked for by id (a suggestion, a genealogy node, a picker row when the
 * picker had no thread to resume). The id decides the track; how the request's text matches it
 * is still recorded, so a result whose id and text disagree (a node's id that names another
 * recording than its label) says so. The request says how the track was picked (`pickedBy`), as
 * a resume does: the web sends "click" for a suggestion, whose text may still read as a partial
 * match of its own track (a self-titled song), so that no note shows; a genealogy node sends
 * none. A track Spotify does not have (404, or 400 for an id it does not know) is "no match".
 */
async function requestedTrack(
  state: SonicAgentStateType,
  trackId: string,
  config: LangGraphRunnableConfig,
  runtime: AgentRuntime,
): Promise<Update> {
  console.log("🔍 [Scout] Reading the requested track:", trackId);
  let track: SpotifyData;
  try {
    track = await withSpotifyRetry(() => fetchTrack(trackId, config.signal), config, runtime);
  } catch (error) {
    if (config.signal?.aborted || isAbortError(error)) throw error;
    const missing =
      isSourceError(error, "invalid_input") ||
      (isSourceError(error, "http") && (error.status === 404 || error.status === 400));
    return missing
      ? failed({ kind: "no_match" }, `No Spotify track ${trackId}`, "❌ Track not found")
      : failed(failureOf(error), `Spotify track ${trackId} not read`, "❌ Error reading Spotify");
  }
  return selectedTrack(
    {
      spotifyData: track,
      selectedTrackId: track.id,
      isrc: track.isrc ?? null,
      queryMatch: matchTrack(state.songQuery, track).match,
      selectedBy: "user",
      pickedBy: state.pickedBy ?? null,
    },
    config,
    runtime,
  );
}

export async function scoutNode(
  state: SonicAgentStateType,
  config: LangGraphRunnableConfig,
  runtime: AgentRuntime = defaultAgentRuntime,
): Promise<Partial<SonicAgentStateType>> {
  const writer = config.writer;

  writer?.({
    type: "status",
    code: "NET-100",
    message: "Establishing connection to Spotify API...",
    node: "scout",
    timestamp: timestampOf(runtime),
  });

  if (state.requestedTrackId) {
    return requestedTrack(state, state.requestedTrackId, config, runtime);
  }

  console.log("🔍 [Scout] Searching for:", state.songQuery);

  try {
    let tracks: SpotifyData[];
    try {
      // As many results as Spotify gives (10): a version or a cover ranked high by Spotify must
      // not push the original recording out of the choice.
      tracks = await withSpotifyRetry(
        () => searchTracks(state.songQuery, 10, config.signal),
        config,
        runtime,
      );
    } catch (error) {
      if (config.signal?.aborted || isAbortError(error)) throw error;
      const why = error instanceof Error ? error.message : String(error);
      return failed(
        failureOf(error),
        `Spotify search failed: ${why}`,
        "❌ Error searching Spotify",
      );
    }

    if (tracks.length === 0) {
      return failed({ kind: "no_match" }, "No tracks found", "❌ No matching songs found");
    }

    // Spotify gives this app no popularity, so the results are judged on how their title and
    // artists match the query (trackMatch.ts): the best match first, selected without asking
    // only when it is clearly the song the query names.
    const ranked = rankTracks(state.songQuery, tracks);
    const best = ranked[0];
    const topTrack = best.track;
    const { maxCandidates } = state.hitlConfig;
    const queryMatch = best.match;
    if (queryMatch === "none") {
      console.warn("⚠️ [Scout] No result matches the query by title or artist:", state.songQuery);
    }

    if (needsChoice(ranked)) {
      // Convert to candidates for human selection (limited by maxCandidates config). One the
      // contract does not accept is left out rather than failing the whole choice.
      const candidates: SearchCandidate[] = ranked
        .slice(0, maxCandidates)
        .map(({ track: t }) => ({
          id: t.id,
          title: t.title,
          artist: t.artist,
          ...(t.artistNames ? { artistNames: t.artistNames } : {}),
          ...(t.artistIds ? { artistIds: t.artistIds } : {}),
          album: t.album,
          coverUrl: t.coverUrl,
          releaseYear: t.releaseDate?.split("-")[0],
          // Only a score Spotify gave; none is invented when it is missing.
          ...(typeof t.popularity === "number" ? { popularity: t.popularity } : {}),
        }))
        .filter((candidate) => {
          const checked = SearchCandidateSchema.safeParse(candidate);
          if (!checked.success) {
            console.warn(
              "⚠️ [Scout] Candidate left out, it does not fit the contract:",
              candidate.id,
              checked.error.issues.map((issue) => issue.path.join(".")),
            );
          }
          return checked.success;
        });
      // A pick remembered for the same text is not reused: it was one user's choice (or the
      // picker's countdown), and a title alone must always ask.
      console.log("⚠️ [Scout] Choice needed:", {
        query: state.songQuery,
        queryMatch,
        candidateCount: tracks.length,
      });

      if (candidates.length === 0) {
        return {
          error: "No candidate fits the contract",
          statusMessages: ["❌ No usable matches"],
        };
      }

      writer?.({
        type: "candidates",
        candidates,
        message: `Found ${candidates.length} matching songs. Please select one.`,
      });

      console.log("⏸️ [Scout] Returning candidates for user disambiguation");

      return {
        candidates,
        queryMatch,
        statusMessages: [`⚠️ Found ${candidates.length} matches - please select`],
      };
    }

    // Unambiguous: auto-select top result
    return await selectedTrack(
      {
        spotifyData: topTrack,
        selectedTrackId: topTrack.id,
        isrc: topTrack.isrc ?? null,
        queryMatch,
        selectedBy: "match",
      },
      config,
      runtime,
    );
  } catch (error) {
    // A cancelled run stops here instead of reporting a search error.
    if (config.signal?.aborted || isAbortError(error)) throw error;
    // A bug, not a Spotify answer: the run fails as a plain failure.
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("❌ [Scout] Error:", message);
    return {
      error: `Scout error: ${message}`,
      statusMessages: ["❌ Error searching Spotify"],
    };
  }
}
