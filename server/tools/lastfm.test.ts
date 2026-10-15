/**
 * Last.fm Tools Test
 *
 * Tests all 5 Last.fm tools against the live API.
 * Requires LASTFM_API_KEY to be set in server/.env
 *
 * Run: cd server && npx tsx tools/lastfm.test.ts
 */

import dotenv from "dotenv";
dotenv.config();

import {
  getLastfmTrackTags,
  getLastfmArtistTags,
  getLastfmSimilarTracks,
  getLastfmSimilarArtists,
  getLastfmArtistInfo,
} from "./lastfm.js";

const TEST_TRACK = "Bohemian Rhapsody";
const TEST_ARTIST = "Queen";

async function runTests() {
  console.log("=".repeat(60));
  console.log("Last.fm Tools Test Suite");
  console.log("=".repeat(60));

  if (!process.env.LASTFM_API_KEY) {
    console.log("\n⚠️  LASTFM_API_KEY not set — testing graceful degradation\n");
  }

  let passed = 0;
  let failed = 0;

  // Test 1: Track Tags
  console.log("\n--- Test 1: Track Tags ---");
  try {
    const result = await getLastfmTrackTags.invoke({
      title: TEST_TRACK,
      artist: TEST_ARTIST,
    });
    const data = JSON.parse(result);
    console.log("Result:", JSON.stringify(data, null, 2));

    if (!process.env.LASTFM_API_KEY) {
      if (data.error?.includes("not configured")) {
        console.log("✅ Graceful degradation works");
        passed++;
      } else {
        console.log("❌ Expected graceful degradation error");
        failed++;
      }
    } else if (data.found && data.tags.length > 0) {
      console.log("✅ PASSED — found", data.tags.length, "tags");
      passed++;
    } else {
      console.log("❌ FAILED — no tags found");
      failed++;
    }
  } catch (error) {
    console.log("❌ FAILED —", error);
    failed++;
  }

  // Test 2: Artist Tags
  console.log("\n--- Test 2: Artist Tags ---");
  try {
    const result = await getLastfmArtistTags.invoke({
      artist: TEST_ARTIST,
    });
    const data = JSON.parse(result);
    console.log("Result:", JSON.stringify(data, null, 2));

    if (!process.env.LASTFM_API_KEY) {
      if (data.error?.includes("not configured")) {
        console.log("✅ Graceful degradation works");
        passed++;
      } else {
        console.log("❌ Expected graceful degradation error");
        failed++;
      }
    } else if (data.found && data.tags.length > 0) {
      console.log("✅ PASSED — found", data.tags.length, "tags");
      passed++;
    } else {
      console.log("❌ FAILED — no tags found");
      failed++;
    }
  } catch (error) {
    console.log("❌ FAILED —", error);
    failed++;
  }

  // Test 3: Similar Tracks
  console.log("\n--- Test 3: Similar Tracks ---");
  try {
    const result = await getLastfmSimilarTracks.invoke({
      title: TEST_TRACK,
      artist: TEST_ARTIST,
    });
    const data = JSON.parse(result);
    console.log("Result:", JSON.stringify(data, null, 2));

    if (!process.env.LASTFM_API_KEY) {
      if (data.error?.includes("not configured")) {
        console.log("✅ Graceful degradation works");
        passed++;
      } else {
        console.log("❌ Expected graceful degradation error");
        failed++;
      }
    } else if (data.found && data.tracks.length > 0) {
      console.log("✅ PASSED — found", data.tracks.length, "similar tracks");
      passed++;
    } else {
      console.log("❌ FAILED — no similar tracks found");
      failed++;
    }
  } catch (error) {
    console.log("❌ FAILED —", error);
    failed++;
  }

  // Test 4: Similar Artists
  console.log("\n--- Test 4: Similar Artists ---");
  try {
    const result = await getLastfmSimilarArtists.invoke({
      artist: TEST_ARTIST,
    });
    const data = JSON.parse(result);
    console.log("Result:", JSON.stringify(data, null, 2));

    if (!process.env.LASTFM_API_KEY) {
      if (data.error?.includes("not configured")) {
        console.log("✅ Graceful degradation works");
        passed++;
      } else {
        console.log("❌ Expected graceful degradation error");
        failed++;
      }
    } else if (data.found && data.artists.length > 0) {
      console.log("✅ PASSED — found", data.artists.length, "similar artists");
      passed++;
    } else {
      console.log("❌ FAILED — no similar artists found");
      failed++;
    }
  } catch (error) {
    console.log("❌ FAILED —", error);
    failed++;
  }

  // Test 5: Artist Info
  console.log("\n--- Test 5: Artist Info ---");
  try {
    const result = await getLastfmArtistInfo.invoke({
      artist: TEST_ARTIST,
    });
    const data = JSON.parse(result);
    console.log("Result:", JSON.stringify(data, null, 2));

    if (!process.env.LASTFM_API_KEY) {
      if (data.error?.includes("not configured")) {
        console.log("✅ Graceful degradation works");
        passed++;
      } else {
        console.log("❌ Expected graceful degradation error");
        failed++;
      }
    } else if (data.found && data.name) {
      console.log("✅ PASSED — got info for", data.name);
      passed++;
    } else {
      console.log("❌ FAILED — no artist info found");
      failed++;
    }
  } catch (error) {
    console.log("❌ FAILED —", error);
    failed++;
  }

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed out of 5 tests`);
  console.log("=".repeat(60));

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((error) => {
  console.error("Test runner error:", error);
  process.exit(1);
});
