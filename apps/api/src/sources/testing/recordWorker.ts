/**
 * Test helper run as a separate process: records `count` stubbed answers into the cassette
 * directory given as the first argument, so a test can run two recorders at once.
 *
 *   node --import tsx recordWorker.ts <cassetteDir> <prefix> <count>
 */

export {};

const [dir, prefix, count] = process.argv.slice(2);
process.env.SOURCE_CASSETTE = "record";
process.env.SOURCE_CASSETTE_DIR = dir;
globalThis.fetch = (async () => Response.json({ ok: true })) as typeof fetch;

const { fetchJson } = await import("../http.js");

await Promise.all(
  Array.from({ length: Number(count) }, (_, i) =>
    fetchJson({ source: "deezer", url: `https://api.deezer.test/${prefix}/${i}` }),
  ),
);
