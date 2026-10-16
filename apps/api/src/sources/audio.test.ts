/**
 * Test for Audio Analysis Tool
 *
 * Run with: tsx tools/audio.test.ts
 *
 * Note: Requires the Python audio analysis service to be running:
 *   cd services/audio && uvicorn main:app --port 3002
 */

import { analyzeAudioPreview, checkAudioServiceHealth } from "./audio.js";
import { searchTrack, getTrackDetails } from "./spotify.js";
import dotenv from "dotenv";

dotenv.config();

async function testAudioAnalysis() {
  console.log("🧪 Testing Audio Analysis Tool\n");
  console.log("=".repeat(60));

  // Test 1: Check service health
  console.log("\n📝 Test 1: Check audio service health\n");

  const healthResult = await checkAudioServiceHealth.invoke({});
  const healthData = JSON.parse(healthResult);

  console.log("Service status:", healthData.available ? "✅ Available" : "❌ Unavailable");
  console.log("URL:", healthData.url);
  if (healthData.version) console.log("Version:", healthData.version);
  if (healthData.error) console.log("Error:", healthData.error);

  console.log("\n" + "=".repeat(60));

  // Test 2: Get a real Spotify preview URL
  console.log("\n📝 Test 2: Analyze real Spotify preview\n");

  // First, search for a song with a preview
  const searchResult = await searchTrack.invoke({
    query: "Blinding Lights The Weeknd",
  });

  let previewUrl: string | null = null;
  try {
    const trackData = JSON.parse(searchResult);
    console.log("Found track:", trackData.title, "by", trackData.artist);

    // Get full details to get preview URL
    const detailsResult = await getTrackDetails.invoke({ trackId: trackData.id });
    const details = JSON.parse(detailsResult);
    previewUrl = details.previewUrl;

    console.log("Preview URL:", previewUrl ? "✅ Available" : "❌ Not available");
  } catch (e) {
    console.log("❌ Could not get track:", searchResult);
  }

  // Analyze the preview
  if (previewUrl) {
    console.log("\n🎧 Analyzing audio...\n");

    const analysisResult = await analyzeAudioPreview.invoke({
      previewUrl,
      title: "Blinding Lights",
      artist: "The Weeknd",
    });

    try {
      const analysis = JSON.parse(analysisResult);
      console.log("✅ BPM:", analysis.bpm);
      console.log("✅ Key:", analysis.key, analysis.mode || "");
      console.log("✅ Energy:", analysis.energy);
      console.log("✅ Duration:", analysis.duration, "seconds");
      console.log("✅ Source:", analysis.source);

      if (analysis.source === "analyzed") {
        console.log("\n🎯 Real audio analysis successful!");
      } else {
        console.log("\n📊 Fell back to estimation (service may be offline)");
        if (analysis.message) console.log("Reason:", analysis.message);
      }
    } catch (e) {
      console.log("Result:", analysisResult);
    }
  }

  console.log("\n" + "=".repeat(60));

  // Test 2.5: Test Deezer fallback with real track (no Spotify preview)
  console.log("\n📝 Test 2.5: Deezer fallback with real track\n");

  const deezerFallbackResult = await analyzeAudioPreview.invoke({
    previewUrl: null, // Force Deezer fallback
    title: "Blinding Lights",
    artist: "The Weeknd",
  });

  try {
    const deezerAnalysis = JSON.parse(deezerFallbackResult);
    console.log("✅ BPM:", deezerAnalysis.bpm);
    console.log("✅ Key:", deezerAnalysis.key, deezerAnalysis.mode || "");
    console.log("✅ Energy:", deezerAnalysis.energy);
    console.log("✅ Source:", deezerAnalysis.source);

    if (deezerAnalysis.source === "analyzed") {
      console.log("\n🎯 Real audio analysis via Deezer fallback successful!");
    } else {
      console.log("\n📊 Using estimation (Python service may be offline)");
      if (deezerAnalysis.message) console.log("Reason:", deezerAnalysis.message);
    }
  } catch (e) {
    console.log("Result:", deezerFallbackResult);
  }

  console.log("\n" + "=".repeat(60));

  // Test 3: Test fallback when no preview
  console.log("\n📝 Test 3: Test fallback (no preview URL)\n");

  const fallbackResult = await analyzeAudioPreview.invoke({
    previewUrl: null,
    title: "Some Ballad Song",
    artist: "Jazz Artist",
  });

  try {
    const fallback = JSON.parse(fallbackResult);
    console.log("✅ BPM (estimated):", fallback.bpm);
    console.log("✅ Key (estimated):", fallback.key, fallback.mode || "");
    console.log("✅ Source:", fallback.source);
    console.log("✅ Message:", fallback.message);

    // Verify ballad detection heuristic
    if (fallback.bpm >= 65 && fallback.bpm <= 85) {
      console.log("✅ BPM range matches 'ballad' heuristic");
    }
  } catch (e) {
    console.log("Result:", fallbackResult);
  }

  console.log("\n" + "=".repeat(60));

  // Test 4: Test different genres for estimation
  console.log("\n📝 Test 4: Genre-based estimation heuristics\n");

  const genres = [
    { title: "Dance Club Hit", artist: "DJ Producer", expected: "120-135" },
    { title: "Heavy Metal Anthem", artist: "Rock Band", expected: "130-160" },
    { title: "Hip Hop Flow", artist: "Rap Artist", expected: "80-100" },
    { title: "Drum and Bass Track", artist: "DnB Producer", expected: "170-180" },
  ];

  for (const genre of genres) {
    const result = await analyzeAudioPreview.invoke({
      previewUrl: null,
      title: genre.title,
      artist: genre.artist,
    });

    const data = JSON.parse(result);
    console.log(`${genre.title}: ${data.bpm} BPM (expected: ${genre.expected})`);
  }

  console.log("\n✨ Audio analysis tests complete!\n");
}

// Run if executed directly
testAudioAnalysis().catch(console.error);
