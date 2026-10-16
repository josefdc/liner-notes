/**
 * Test for MusicBrainz Tool
 *
 * Run with: tsx tools/musicbrainz.test.ts
 */

import { getMusicBrainzRelations, getMusicBrainzArtist } from "./musicbrainz.js";
import dotenv from "dotenv";

dotenv.config();

async function testMusicBrainz() {
  console.log("🧪 Testing MusicBrainz Tool\n");
  console.log("=".repeat(60));

  // Test 1: Song with known samples (Harder Better Faster Stronger samples "Cola Bottle Baby")
  console.log("\n📝 Test 1: Daft Punk - 'Harder, Better, Faster, Stronger'\n");
  console.log("(Known to sample Edwin Birdsong - 'Cola Bottle Baby')\n");

  const result1 = await getMusicBrainzRelations.invoke({
    title: "Harder, Better, Faster, Stronger",
    artist: "Daft Punk",
  });

  try {
    const data = JSON.parse(result1);
    console.log("✅ Found:", data.found);
    console.log("✅ MBID:", data.mbid);
    console.log("✅ Title:", data.title);
    console.log("✅ Total relations:", data.totalRelations);
    console.log("\n🧬 Genealogy:");
    console.log("  Samples:", JSON.stringify(data.genealogy?.samples || [], null, 2));
    console.log("  Covers:", JSON.stringify(data.genealogy?.covers || [], null, 2));
    console.log("  Remixes:", JSON.stringify(data.genealogy?.remixes || [], null, 2));
    console.log("\n📋 Relation types found:", data.relationTypes);
  } catch (e) {
    console.log("❌ Parse error:", result1);
  }

  console.log("\n" + "=".repeat(60));

  // Test 2: Classic hip-hop song with many samples
  console.log("\n📝 Test 2: Kanye West - 'Stronger'\n");
  console.log("(Samples 'Harder, Better, Faster, Stronger')\n");

  const result2 = await getMusicBrainzRelations.invoke({
    title: "Stronger",
    artist: "Kanye West",
  });

  try {
    const data = JSON.parse(result2);
    console.log("✅ Found:", data.found);
    console.log("✅ MBID:", data.mbid);
    console.log("✅ Title:", data.title);
    console.log("\n🧬 Sample relationships:");
    console.log(JSON.stringify(data.genealogy?.samples || [], null, 2));
  } catch (e) {
    console.log("❌ Parse error:", result2);
  }

  console.log("\n" + "=".repeat(60));

  // Test 3: Artist lookup
  console.log("\n📝 Test 3: Artist lookup - Daft Punk\n");

  const artistResult = await getMusicBrainzArtist.invoke({
    artistName: "Daft Punk",
  });

  try {
    const data = JSON.parse(artistResult);
    console.log("✅ Found:", data.found);
    console.log("✅ MBID:", data.mbid);
    console.log("✅ Name:", data.name);
    console.log("✅ Type:", data.type);
    console.log("✅ Country:", data.country);
    console.log("\n👥 Collaborators:", data.collaborators?.slice(0, 5));
  } catch (e) {
    console.log("❌ Parse error:", artistResult);
  }

  console.log("\n" + "=".repeat(60));

  // Test 4: Song not found
  console.log("\n📝 Test 4: Non-existent song\n");

  const notFoundResult = await getMusicBrainzRelations.invoke({
    title: "Nonexistent Song XYZ 12345",
    artist: "Fake Artist 99999",
  });

  try {
    const data = JSON.parse(notFoundResult);
    console.log("Expected not found:", !data.found ? "✅" : "❌");
    console.log("Message:", data.message || data.error);
  } catch (e) {
    console.log("Result:", notFoundResult);
  }

  console.log("\n✨ MusicBrainz tests complete!\n");
}

// Run if executed directly
testMusicBrainz().catch(console.error);
