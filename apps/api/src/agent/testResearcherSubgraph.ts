/**
 * Quick test for the Deep Dive Researcher Subgraph
 * Run with: cd apps/api && npx tsx src/agent/testResearcherSubgraph.ts
 */

import dotenv from "dotenv";
import { createResearcherSubgraph } from "./researcherSubgraph.js";
import type { SpotifyData } from "./state.js";

dotenv.config();

async function testResearcherSubgraph() {
  console.log("\n🔬 Testing Deep Dive Researcher Subgraph\n");
  console.log("=" .repeat(60));

  // Create mock Spotify data
  const mockSpotifyData: SpotifyData = {
    id: "0DiWol3AO6WpXZgp0goxAV",
    title: "Harder Better Faster Stronger",
    artist: "Daft Punk",
    artistIds: ["4tZwfgrHOc3mvqYlEYSvVi"],
    album: "Discovery",
    releaseDate: "2001-03-13",
    coverUrl: "https://i.scdn.co/image/ab67616d0000b273b33d46dfa2f8e36a289e8a7f",
    popularity: 75,
    duration: "3:44",
    durationMs: 224667,
    explicit: false,
    spotifyUrl: "https://open.spotify.com/track/0DiWol3AO6WpXZgp0goxAV",
    previewUrl: null,
  };

  console.log(`\n📀 Track: "${mockSpotifyData.title}" by ${mockSpotifyData.artist}`);
  console.log("   This song is known for sampling Edwin Birdsong's 'Cola Bottle Baby'\n");

  try {
    const researcherGraph = createResearcherSubgraph();

    console.log("🚀 Starting researcher subgraph...\n");

    const result = await researcherGraph.invoke({
      spotifyData: mockSpotifyData,
      researchData: {
        samples: [],
        productionTrivia: [],
        songMeaning: [],
        relatedArtists: [],
      },
    });

    console.log("\n" + "=" .repeat(60));
    console.log("✅ Researcher Subgraph Complete!\n");

    console.log(`📊 Research Iterations: ${result.researchIteration}`);
    console.log(`📝 Research Complete: ${result.researchComplete}`);

    console.log("\n📚 Research Data Collected:");
    console.log(`   • Samples: ${result.researchData.samples.length} entries`);
    console.log(`   • Production Trivia: ${result.researchData.productionTrivia.length} entries`);
    console.log(`   • Song Meaning: ${result.researchData.songMeaning.length} entries`);
    console.log(`   • Related Artists: ${result.researchData.relatedArtists.length} entries`);

    console.log("\n📋 Status Messages:");
    result.statusMessages.forEach((msg) => {
      console.log(`   ${msg}`);
    });

    // Show preview of samples data if found
    if (result.researchData.samples.length > 0) {
      console.log("\n🔗 Sample Preview:");
      const preview = result.researchData.samples[0].substring(0, 300);
      console.log(`   ${preview}...`);
    }

    console.log("\n" + "=" .repeat(60));
    console.log("🎉 Deep Dive Researcher is working correctly!\n");

    return true;
  } catch (error) {
    console.error("\n❌ Test failed:", error);
    return false;
  }
}

testResearcherSubgraph().then((success) => {
  process.exit(success ? 0 : 1);
});
