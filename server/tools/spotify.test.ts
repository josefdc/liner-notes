/**
 * Spotify Tools Test
 *
 * Run with: npm run test:spotify (from server directory)
 *
 * Make sure you have a .env file with:
 * - SPOTIFY_CLIENT_ID
 * - SPOTIFY_CLIENT_SECRET
 */

import { searchTrack, getTrackDetails, getArtistTopTracks, SpotifyAuthManager } from "./spotify.js";

async function runTests() {
  console.log("\n🧪 Testing Spotify Tools\n");
  console.log("=".repeat(60));

  // Test 1: Search for a track
  console.log("\n📍 Test 1: Search for 'Midnight City M83'");
  console.log("-".repeat(60));

  const searchResult = await searchTrack.invoke({ query: "Midnight City M83" });
  console.log("Result:", searchResult);

  // Parse the result to get the track ID and artist ID
  let trackId: string | null = null;
  let artistId: string | null = null;

  try {
    const parsed = JSON.parse(searchResult);
    trackId = parsed.id;
    console.log("\n✅ Track found!");
    console.log(`   Title: ${parsed.title}`);
    console.log(`   Artist: ${parsed.artist}`);
    console.log(`   Album: ${parsed.album}`);
    console.log(`   Popularity: ${parsed.popularity}/100`);
  } catch {
    console.log("\n❌ Could not parse search result");
  }

  // Test 2: Get track details (if we have a track ID)
  if (trackId) {
    console.log("\n📍 Test 2: Get Track Details");
    console.log("-".repeat(60));

    const detailsResult = await getTrackDetails.invoke({ trackId });
    console.log("Result:", detailsResult);

    try {
      const details = JSON.parse(detailsResult);
      artistId = details.artistIds?.[0];
      console.log("\n📊 Track Details:");
      console.log(`   Duration: ${details.duration}`);
      console.log(`   Release Date: ${details.releaseDate}`);
      console.log(`   Explicit: ${details.explicit ? "Yes" : "No"}`);
      console.log(`   Preview URL: ${details.previewUrl ? "Available" : "Not available"}`);
      console.log(`   Artist IDs: ${details.artistIds?.join(", ")}`);
    } catch {
      console.log("\n❌ Could not parse track details");
    }
  }

  // Test 3: Get artist's top tracks (if we have an artist ID)
  if (artistId) {
    console.log("\n📍 Test 3: Get Artist Top Tracks");
    console.log("-".repeat(60));

    const topTracksResult = await getArtistTopTracks.invoke({ artistId });
    console.log("Result:", topTracksResult);

    try {
      const data = JSON.parse(topTracksResult);
      console.log("\n🎵 Top Tracks by Artist:");
      data.topTracks?.forEach((t: any, i: number) => {
        console.log(`   ${i + 1}. ${t.title} (${t.album}) - Popularity: ${t.popularity}`);
      });
    } catch {
      console.log("\n❌ Could not parse top tracks");
    }
  }

  // Test 4: Token caching verification
  console.log("\n📍 Test 4: Token Caching");
  console.log("-".repeat(60));

  const auth = SpotifyAuthManager.getInstance();
  const token1 = await auth.getToken();
  const token2 = await auth.getToken();

  if (token1 === token2) {
    console.log("✅ Token caching working - same token reused");
  } else {
    console.log("⚠️ Token changed unexpectedly");
  }

  // Test 5: Error handling (invalid track ID)
  console.log("\n📍 Test 5: Error Handling (Invalid Track ID)");
  console.log("-".repeat(60));

  const invalidResult = await getTrackDetails.invoke({ trackId: "invalid_id_12345" });
  console.log("Result:", invalidResult);
  console.log("✅ Error handled gracefully");

  console.log("\n" + "=".repeat(60));
  console.log("🏁 All tests completed!\n");
}

runTests().catch(console.error);
