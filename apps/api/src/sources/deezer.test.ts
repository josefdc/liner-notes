/**
 * Test for Deezer Preview Tool
 *
 * Run with: cd apps/api && npx tsx src/sources/deezer.test.ts
 */

import { searchDeezerPreview } from "./deezer.js";
import type { DeezerSearchResult } from "./deezer.js";

async function testDeezerSearch() {
  console.log("🧪 Testing Deezer Preview Tool\n");
  console.log("=".repeat(60));

  // Test 1: Search for a popular track
  console.log("\n📝 Test 1: Search for popular track (Blinding Lights)\n");

  const result1 = await searchDeezerPreview.invoke({
    title: "Blinding Lights",
    artist: "The Weeknd",
  });

  const data1 = JSON.parse(result1) as DeezerSearchResult;
  console.log("Found:", data1.found);
  if (data1.found && data1.previewUrl) {
    console.log("✅ Preview URL:", data1.previewUrl);
    console.log("   Title:", data1.title);
    console.log("   Artist:", data1.artist);
    console.log("   Album:", data1.album);
  } else {
    console.log("❌ No preview found");
    if (data1.error) console.log("   Error:", data1.error);
  }

  console.log("\n" + "=".repeat(60));

  // Test 2: Search for another track
  console.log("\n📝 Test 2: Search for another track (Bohemian Rhapsody)\n");

  const result2 = await searchDeezerPreview.invoke({
    title: "Bohemian Rhapsody",
    artist: "Queen",
  });

  const data2 = JSON.parse(result2) as DeezerSearchResult;
  console.log("Found:", data2.found);
  if (data2.found && data2.previewUrl) {
    console.log("✅ Preview URL:", data2.previewUrl);
    console.log("   Title:", data2.title);
    console.log("   Artist:", data2.artist);
  } else {
    console.log("❌ No preview found");
  }

  console.log("\n" + "=".repeat(60));

  // Test 3: Search for non-existent track
  console.log("\n📝 Test 3: Search for non-existent track\n");

  const result3 = await searchDeezerPreview.invoke({
    title: "asdfjklqwert12345nonexistent",
    artist: "NotARealArtist99999",
  });

  const data3 = JSON.parse(result3) as DeezerSearchResult;
  console.log("Found:", data3.found);
  if (!data3.found) {
    console.log("✅ Correctly returned not found");
    console.log("   Message:", data3.message);
  } else {
    console.log("⚠️ Unexpectedly found something");
  }

  console.log("\n" + "=".repeat(60));

  // Test 4: Verify the preview URL format
  console.log("\n📝 Test 4: Verify preview URL format\n");

  if (data1.previewUrl) {
    const isDeezerCDN = data1.previewUrl.includes("dzcdn.net") ||
                        data1.previewUrl.includes("cdns-preview");
    console.log("URL contains Deezer CDN domain:", isDeezerCDN ? "✅ Yes" : "❌ No");
    console.log("URL ends with .mp3:", data1.previewUrl.endsWith(".mp3") ? "✅ Yes" : "❌ No");
  } else {
    console.log("⚠️ No preview URL to verify");
  }

  console.log("\n✨ Deezer tool tests complete!\n");
}

// Run if executed directly
testDeezerSearch().catch(console.error);
