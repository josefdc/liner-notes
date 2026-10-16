/**
 * Test for Genius Lyrics Tool
 *
 * Run with: npm run test:tools (or tsx src/sources/genius.test.ts)
 */

import { fetchLyrics, getGeniusAnnotations } from "./genius.js";
import dotenv from "dotenv";

dotenv.config();

async function testGenius() {
  console.log("🧪 Testing Genius Lyrics Tool\n");
  console.log("=".repeat(60));

  // Test 1: Fetch lyrics for a popular song
  console.log("\n📝 Test 1: Fetch lyrics for 'Bohemian Rhapsody' by Queen\n");

  const lyricsResult = await fetchLyrics.invoke({
    title: "Bohemian Rhapsody",
    artist: "Queen",
  });

  try {
    const data = JSON.parse(lyricsResult);
    console.log("✅ Title:", data.title);
    console.log("✅ Artist:", data.artist);
    console.log("✅ Genius URL:", data.geniusUrl);
    console.log("✅ Lyrics length:", data.lyrics?.length || 0, "chars");
    console.log("✅ Truncated:", data.truncated);
    console.log("\n📜 First 500 chars of lyrics:");
    console.log(data.lyrics?.substring(0, 500) || "No lyrics found");
  } catch (e) {
    console.log("❌ Parse error:", lyricsResult);
  }

  console.log("\n" + "=".repeat(60));

  // Test 2: Fetch annotations
  console.log("\n📝 Test 2: Get annotations for 'Lose Yourself' by Eminem\n");

  const annotResult = await getGeniusAnnotations.invoke({
    title: "Lose Yourself",
    artist: "Eminem",
  });

  try {
    const data = JSON.parse(annotResult);
    console.log("✅ Title:", data.title);
    console.log("✅ Annotation count:", data.annotationCount);
    console.log("\n📋 Top annotations:");
    data.topAnnotations?.forEach((a: { fragment: string; annotation: string }, i: number) => {
      console.log(`\n${i + 1}. Fragment: "${a.fragment?.substring(0, 50)}..."`);
      console.log(`   Annotation: ${a.annotation?.substring(0, 100)}...`);
    });
  } catch (e) {
    console.log("❌ Parse error:", annotResult);
  }

  console.log("\n" + "=".repeat(60));

  // Test 3: Song not found
  console.log("\n📝 Test 3: Non-existent song\n");

  const notFoundResult = await fetchLyrics.invoke({
    title: "This Song Does Not Exist 12345",
    artist: "Unknown Artist 99999",
  });

  const notFoundData = JSON.parse(notFoundResult);
  console.log("Expected error:", notFoundData.error ? "✅ Got error" : "❌ Should have error");
  console.log("Error message:", notFoundData.error);

  console.log("\n✨ Genius tests complete!\n");
}

// Run if executed directly
testGenius().catch(console.error);
