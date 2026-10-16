/**
 * Sonic Agent Graph Test
 *
 * Run with: npm run test:agent (from server directory)
 *
 * Tests the complete LangGraph workflow:
 * scout → [clarification] → engineer/historian → composer
 */

import { createSonicAgentGraph } from "./graph.js";
import { Command } from "@langchain/langgraph";
import type { TrackData } from "./schema.js";

async function runTest() {
  console.log("\n🧪 Testing Sonic Agent Graph\n");
  console.log("=".repeat(60));

  // Use a very popular track to avoid HITL triggering
  const testQuery = "Bohemian Rhapsody Queen";

  console.log(`\n📍 Analyzing: "${testQuery}"\n`);

  // Create graph and run with HITL handling
  const graph = createSonicAgentGraph();
  const threadId = `test-${Date.now()}`;

  let result = await graph.invoke(
    { songQuery: testQuery },
    { configurable: { thread_id: threadId } }
  );

  // Check if HITL triggered (candidates returned, waiting for selection)
  if (result.candidates && result.candidates.length > 0 && !result.trackData) {
    console.log(`\n⏸️ HITL triggered: ${result.candidates.length} candidates found`);
    console.log("   Auto-selecting top candidate for testing...\n");

    const topCandidate = result.candidates[0];
    console.log(`   Selected: "${topCandidate.title}" by ${topCandidate.artist}`);

    // Resume graph with user selection using Command
    result = await graph.invoke(
      new Command({ resume: topCandidate.id }),
      { configurable: { thread_id: threadId } }
    );
  }

  const trackData: TrackData | null = result.trackData;

  if (!trackData) {
    console.log("\n❌ Analysis failed - no result returned");
    if (result.error) {
      console.log(`   Error: ${result.error}`);
    }
    return;
  }

  console.log("\n📊 Result Summary:");
  console.log("-".repeat(40));
  console.log(`Title: ${trackData.title}`);
  console.log(`Artist: ${trackData.artist}`);
  console.log(`Album: ${trackData.album}`);
  console.log(`BPM: ${trackData.bpm}`);
  console.log(`Key: ${trackData.key || "N/A"}`);
  console.log(`Cover URL: ${trackData.coverUrl ? "✅" : "❌"}`);

  console.log("\n🎭 Factoids:");
  trackData.factoids?.forEach((f, i) => {
    console.log(`  ${i + 1}. [${f.type}] ${f.title}`);
    console.log(`     ${f.content.substring(0, 80)}...`);
  });

  console.log("\n🔗 Genealogy:");
  console.log(`  Nodes: ${trackData.genealogy?.nodes?.length || 0}`);
  console.log(`  Links: ${trackData.genealogy?.links?.length || 0}`);

  console.log("\n🎵 Segments:");
  trackData.segments?.forEach((s) => {
    console.log(`  ${s.label}: ${s.start}% - ${s.end}%`);
  });

  console.log("\n" + "=".repeat(60));
  console.log("🏁 Test completed!\n");

  // Output full JSON for inspection
  console.log("\n📄 Full TrackData JSON:");
  console.log(JSON.stringify(trackData, null, 2));
}

runTest().catch(console.error);
