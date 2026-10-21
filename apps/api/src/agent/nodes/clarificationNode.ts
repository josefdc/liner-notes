/**
 * Clarification Node — Human-in-the-loop
 * Pauses execution until user selects a track
 */

import { interrupt, getStore } from "@langchain/langgraph";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { getTrackDetails } from "../../sources/spotify.js";
import type { SonicAgentStateType, SpotifyData } from "../state.js";
import type { SearchCandidate } from "../schema.js";

interface DisambiguationInterrupt {
  type: string;
  candidates: SearchCandidate[];
  message: string;
}

export async function clarificationNode(
  state: SonicAgentStateType,
  config: LangGraphRunnableConfig,
): Promise<Partial<SonicAgentStateType>> {
  console.log("⏸️ [Clarification] Waiting for user to select track...");
  const store = getStore();

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
    timestamp: new Date().toISOString(),
  });

  // Save disambiguation preference in long-term memory
  if (store && state.candidates) {
    const normalizedQuery = state.songQuery.toLowerCase().trim();
    const candidateIds = state.candidates
      .map((c) => c.id)
      .sort()
      .join(",");
    try {
      await store.put(["disambiguation"], normalizedQuery, {
        selectedTrackId: selectedId,
        candidateIds,
        timestamp: Date.now(),
      });
    } catch (e) {
      console.warn("⚠️ [Clarification] Store write error:", e);
    }
  }

  // Fetch full Spotify data for selected track
  try {
    const detailsResult = await getTrackDetails.invoke({ trackId: selectedId });
    const spotifyData = JSON.parse(detailsResult) as SpotifyData;

    console.log("✅ [Clarification] User selected:", spotifyData.title);

    return {
      spotifyData,
      selectedTrackId: selectedId,
      candidates: null, // Clear candidates
      statusMessages: [`✅ Selected: "${spotifyData.title}" by ${spotifyData.artist}`],
    };
  } catch {
    // Fallback: minimal SpotifyData from the candidate. What the candidate does not carry is
    // left unknown rather than guessed: the duration (0, shown as missing) and whether the
    // track is explicit (null).
    return {
      spotifyData: {
        id: selected.id,
        title: selected.title,
        artist: selected.artist,
        artistIds: [],
        album: selected.album,
        releaseDate: selected.releaseYear || "",
        coverUrl: selected.coverUrl,
        popularity: selected.popularity,
        duration: "",
        durationMs: 0,
        explicit: null,
        spotifyUrl: `https://open.spotify.com/track/${selected.id}`,
        previewUrl: null,
      },
      selectedTrackId: selectedId,
      candidates: null,
      statusMessages: [`✅ Selected: "${selected.title}"`],
    };
  }
}
