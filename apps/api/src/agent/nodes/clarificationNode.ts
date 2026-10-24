/**
 * Clarification Node — Human-in-the-loop
 * Pauses execution until user selects a track
 */

import { interrupt } from "@langchain/langgraph";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { getTrackDetails } from "../../sources/spotify.js";
import type { SonicAgentStateType, SpotifyData } from "../state.js";
import type { SearchCandidate } from "../schema.js";
import { isAbortError } from "../errors.js";
import { type AgentRuntime, defaultAgentRuntime, timestampOf } from "../runtime.js";
import { matchTrack } from "../trackMatch.js";

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
  console.log("⏸️ [Clarification] Waiting for user to select track...");

  // Pauses the run: the first time through, interrupt() stops the graph and the route sends the
  // payload's candidates to the client. On resume (Command({ resume })) the node runs again from
  // the top and interrupt() returns the selected track id instead.
  // Type parameters: <payload, resume value> — compile-time hint only
  const selectedId = interrupt<DisambiguationInterrupt, string>({
    type: "disambiguation",
    candidates: state.candidates!, // non-null: routing guarantees candidates exist here
    message: "Multiple songs found. Please select the correct one.",
  });

  // Keep the runtime guard — Command({ resume }) could pass any value at runtime
  if (!selectedId || typeof selectedId !== "string") {
    return {
      error: "No track selected during disambiguation",
      statusMessages: ["❌ No track was selected"],
    };
  }

  // Find the selected candidate and convert to SpotifyData
  const selected = state.candidates?.find((c) => c.id === selectedId);

  if (!selected) {
    return {
      error: "Invalid selection",
      statusMessages: ["❌ Selected track not found"],
    };
  }

  const writer = config.writer;
  writer?.({
    type: "status",
    code: "SPOTIFY-FOUND",
    message: `User confirmed: "${selected.title}" // ${selected.artist}`,
    node: "clarification",
    timestamp: timestampOf(runtime),
  });

  // The pick is not remembered for the query's text: it is this user's choice, and the next
  // search of the same text asks again.

  // Fetch full Spotify data for selected track
  try {
    config.signal?.throwIfAborted();
    const detailsResult = await getTrackDetails.invoke(
      { trackId: selectedId },
      { signal: config.signal },
    );
    const spotifyData = JSON.parse(detailsResult) as SpotifyData;

    console.log("✅ [Clarification] User selected:", spotifyData.title);

    return {
      spotifyData,
      selectedTrackId: selectedId,
      isrc: spotifyData.isrc ?? null,
      selectedBy: "user",
      queryMatch: matchTrack(state.songQuery, spotifyData).match,
      candidates: null, // Clear candidates
      statusMessages: [`✅ Selected: "${spotifyData.title}" by ${spotifyData.artist}`],
    };
  } catch (error) {
    if (config.signal?.aborted || isAbortError(error)) throw error;
    // Fallback: minimal SpotifyData from the candidate. What the candidate does not carry is
    // left unknown rather than guessed: the duration (0, shown as missing), whether the track
    // is explicit (null), its ISRC and its popularity.
    const spotifyData: SpotifyData = {
      id: selected.id,
      title: selected.title,
      artist: selected.artist,
      // The separate artists when the candidate carried them; else the joined name is
      // searched as one artist (it cannot be split: names contain commas too).
      ...(selected.artistNames ? { artistNames: selected.artistNames } : {}),
      artistIds: selected.artistIds ?? [],
      album: selected.album,
      releaseDate: selected.releaseYear || "",
      coverUrl: selected.coverUrl,
      ...(typeof selected.popularity === "number" ? { popularity: selected.popularity } : {}),
      isrc: null,
      duration: "",
      durationMs: 0,
      explicit: null,
      spotifyUrl: `https://open.spotify.com/track/${selected.id}`,
      previewUrl: null,
    };
    return {
      spotifyData,
      selectedTrackId: selectedId,
      isrc: null,
      selectedBy: "user",
      queryMatch: matchTrack(state.songQuery, spotifyData).match,
      candidates: null,
      statusMessages: [`✅ Selected: "${selected.title}"`],
    };
  }
}
