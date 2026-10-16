/**
 * Last.fm tools without an API key
 *
 * Every Last.fm tool must report that the source is not configured instead of
 * throwing or returning made-up data, and must not touch the network.
 *
 * Run: npm run test:lastfm -w apps/api
 */

import {
  getLastfmTrackTags,
  getLastfmArtistTags,
  getLastfmSimilarTracks,
  getLastfmSimilarArtists,
  getLastfmArtistInfo,
} from "./lastfm.js";

// Importing the tools loads apps/api/.env; remove the key afterwards so the
// no-key path is exercised regardless of local configuration.
delete process.env.LASTFM_API_KEY;

let networkCalls = 0;
globalThis.fetch = (async () => {
  networkCalls++;
  throw new Error("network access is not expected without an API key");
}) as typeof fetch;

const cases: Array<
  [string, { invoke: (input: never) => Promise<unknown> }, Record<string, string>]
> = [
  ["track tags", getLastfmTrackTags, { title: "Bohemian Rhapsody", artist: "Queen" }],
  ["artist tags", getLastfmArtistTags, { artist: "Queen" }],
  ["similar tracks", getLastfmSimilarTracks, { title: "Bohemian Rhapsody", artist: "Queen" }],
  ["similar artists", getLastfmSimilarArtists, { artist: "Queen" }],
  ["artist info", getLastfmArtistInfo, { artist: "Queen" }],
];

let failed = 0;

for (const [name, lastfmTool, input] of cases) {
  try {
    const result = await lastfmTool.invoke(input as never);
    const data = JSON.parse(String(result));
    const dataKeys = ["tags", "tracks", "artists", "name"].filter((key) => key in data);
    if (
      typeof data.error === "string" &&
      data.error.includes("not configured") &&
      data.found !== true &&
      dataKeys.length === 0
    ) {
      console.log(`ok   ${name}: reports "not configured"`);
    } else {
      console.log(
        `FAIL ${name}: expected only a "not configured" error, got ${JSON.stringify(data)}`,
      );
      failed++;
    }
  } catch (error) {
    console.log(`FAIL ${name}: threw ${error}`);
    failed++;
  }
}

console.log(`\n${cases.length - failed}/${cases.length} Last.fm tools degrade without a key`);
if (networkCalls > 0) {
  console.log(`FAIL ${networkCalls} network call(s) attempted without an API key`);
}
process.exit(failed > 0 || networkCalls > 0 ? 1 : 0);
