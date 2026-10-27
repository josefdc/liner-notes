/**
 * Clarification Node — Human-in-the-loop
 * Pauses execution until user selects a track. A result stored for the picked track is served
 * without composing it again. The resume value names the track and how it was picked (a click,
 * or the picker's countdown); older clients send the track id alone.
 */

import { getStore, interrupt } from "@langchain/langgraph";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { SourceError } from "@liner-notes/contract";
import { normalizeIsrc } from "../../sources/musicbrainz.js";
import { errorRecord } from "../../sources/records.js";
import { fetchTrack } from "../../sources/spotify.js";
import type { PickedBy, SonicAgentStateType, SpotifyData } from "../state.js";
import type { SearchCandidate } from "../schema.js";
import { isAbortError } from "../errors.js";
import { type AgentRuntime, defaultAgentRuntime, timestampOf } from "../runtime.js";
import {
  readStoredResult,
  servedResult,
  shownQueryMatch,
  STORED_LINE,
  storedStatus,
} from "../storedResults.js";
import { selectedLine } from "../statusText.js";
import { choiceMessage, matchTrack } from "../trackMatch.js";
import { logger } from "../../logger.js";

const log = logger("Clarification");

/** What the route resumes a paused run with: the picked track, and how it was picked. */
export interface PickResume {
  trackId: string;
  pickedBy?: PickedBy;
}

/** The pick in a resume value: an object from this release, a bare id from older clients. */
function pickOf(value: unknown): { trackId: string; pickedBy: PickedBy | null } | null {
  if (typeof value === "string") return value ? { trackId: value, pickedBy: null } : null;
  if (typeof value !== "object" || value === null) return null;
  const { trackId, pickedBy } = value as Partial<PickResume>;
  if (typeof trackId !== "string" || !trackId) return null;
  return {
    trackId,
    pickedBy: pickedBy === "click" || pickedBy === "countdown" ? pickedBy : null,
  };
}

interface DisambiguationInterrupt {
  type: string;
  candidates: SearchCandidate[];
  message: string;
}

export async function clarificationNode(
  state: SonicAgentStateType,
  config: LangGraphRunnableConfig,
  runtime: AgentRuntime = defaultAgentRuntime,
): Promise<Partial<SonicAgentStateType>> {
  log.info("Waiting for user to select track...");

  // Pauses the run: the first time through, interrupt() stops the graph and the route sends the
  // payload's candidates to the client. On resume (Command({ resume })) the node runs again from
  // the top and interrupt() returns the selected track id instead.
  // Type parameters: <payload, resume value> — compile-time hint only
  const resumed = interrupt<DisambiguationInterrupt, PickResume | string>({
    type: "disambiguation",
    candidates: state.candidates!, // non-null: routing guarantees candidates exist here
    message: choiceMessage(state.candidates!.length),
  });

  // Keep the runtime guard — Command({ resume }) could pass any value at runtime
  const pick = pickOf(resumed);
  if (!pick) {
    return {
      error: "No track selected during disambiguation",
      statusMessages: ["No track was selected"],
    };
  }

  const selectedId = pick.trackId;
  // Find the selected candidate and convert to SpotifyData
  const selected = state.candidates?.find((c) => c.id === selectedId);

  if (!selected) {
    return {
      error: "Invalid selection",
      statusMessages: ["The selected track is not one of the offered choices"],
    };
  }

  const writer = config.writer;
  writer?.({
    type: "status",
    code: "SPOTIFY-FOUND",
    message: selectedLine(selected),
    node: "clarification",
    timestamp: timestampOf(runtime),
  });

  // The pick is not remembered for the query's text: it is this user's choice, and the next
  // search of the same text asks again.

  // Fetch full Spotify data for selected track
  let spotifyData: SpotifyData;
  let detailed = true;
  // Set when the details could not be read, with Spotify's typed error: the run goes on with
  // the candidate's fields, and its result is not stored (the composer stores nothing built
  // without the details), so a later run with the track's full details (its ISRC and duration,
  // which the audio lookup needs) is never served this one.
  let sourceErrors: SourceError[] = [];
  try {
    config.signal?.throwIfAborted();
    spotifyData = await fetchTrack(selectedId, config.signal);
    log.info(`User selected: ${spotifyData.title}`);
  } catch (error) {
    if (config.signal?.aborted || isAbortError(error)) throw error;
    // Fallback: minimal SpotifyData from the candidate, with the ISRC and release date Spotify's
    // search gave for it. What the candidate does not carry is left unknown rather than
    // guessed: the duration (0, shown as missing), whether the track is explicit (null), its
    // popularity, and its ISRC or date when the search gave none.
    detailed = false;
    sourceErrors = [errorRecord("spotify", error)];
    log.warn(`Track details not read; using the candidate: ${selectedId}`);
    spotifyData = {
      id: selected.id,
      title: selected.title,
      artist: selected.artist,
      // The separate artists when the candidate carried them; else the joined name is
      // searched as one artist (it cannot be split: names contain commas too).
      ...(selected.artistNames ? { artistNames: selected.artistNames } : {}),
      artistIds: selected.artistIds ?? [],
      album: selected.album,
      // Candidates sent before they carried the date carry its year only.
      releaseDate: selected.releaseDate ?? (selected.releaseYear || null),
      coverUrl: selected.coverUrl,
      ...(typeof selected.popularity === "number" ? { popularity: selected.popularity } : {}),
      isrc: normalizeIsrc(selected.isrc),
      duration: "",
      durationMs: 0,
      explicit: null,
      spotifyUrl: `https://open.spotify.com/track/${selected.id}`,
      previewUrl: null,
    };
  }

  const picked = {
    spotifyData,
    selectedTrackId: selectedId,
    isrc: spotifyData.isrc ?? null,
    selectedBy: "user" as const,
    pickedBy: pick.pickedBy,
    queryMatch: matchTrack(state.songQuery, spotifyData).match,
    candidates: null, // Clear candidates
    ...(sourceErrors.length > 0 ? { sourceErrors } : {}),
  };

  // A result stored for the picked track is served as it is: it is about this track, whatever
  // text led to it (the store is keyed by track, see storedResults.ts).
  const stored = await readStoredResult(getStore(), selectedId, runtime.now());
  config.signal?.throwIfAborted();
  if (stored) {
    log.info(`Stored result for: ${selectedId}`);
    const trackData = servedResult(stored.trackData, shownQueryMatch(picked));
    writer?.({
      type: "status",
      code: "NET-200",
      message: STORED_LINE,
      node: "clarification",
      timestamp: timestampOf(runtime),
    });
    // The sources its run could not read are reported again (missing, not empty), and notes
    // its verifier could not check are said to be unchecked.
    const unread = storedStatus(stored);
    for (const message of unread) {
      writer?.({
        type: "status",
        code: "SYS-WARN",
        message,
        node: "clarification",
        timestamp: timestampOf(runtime),
      });
    }
    writer?.({ type: "complete", data: trackData });
    return {
      ...picked,
      trackData,
      ...(stored.sourceErrors.length > 0
        ? { sourceErrors: [...sourceErrors, ...stored.sourceErrors] }
        : {}),
      ...(unread.length > 0 ? { statusMessages: unread } : {}),
    };
  }

  return {
    ...picked,
    statusMessages: [
      detailed
        ? selectedLine(spotifyData)
        : `Selected: ${selected.title} (its Spotify details could not be read)`,
    ],
  };
}
