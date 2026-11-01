import assert from "node:assert/strict";
import { test } from "node:test";

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { topGenre } from "./fetch-styles.mjs";
import { REPO_ROOT } from "./lib/golden.mjs";
import {
  CURRENT_SHOWCASES,
  chooseShowcase,
  selectShowcase,
  readStyles,
  slugFor,
  slugOf,
  styleKey,
} from "./showcase.mjs";

const row = (isrc, style, links, eligible = true) => ({
  isrc,
  slug: isrc.toLowerCase(),
  style,
  codeSourcedLinks: links,
  eligible,
});
const [omt, bss, hung] = ["GBDUW0000053", "GBAAA9700049", "USWB10504319"];

test("styles are one when equal lower-cased, and no closer", () => {
  assert.equal(styleKey(" Hip Hop "), styleKey("hip hop"));
  assert.notEqual(styleKey("hip hop"), styleKey("hip-hop"));
  assert.notEqual(styleKey("house"), styleKey("electro house"));
});

test("the eligible current showcases come first, then every row that adds a style", () => {
  const rows = [
    row(omt, "house", 9),
    row(bss, "alternative rock", 5),
    row(hung, "pop", 6),
    row("USBB40000359", "hip hop", 11, false), // Juicy, not eligible
    row("AAAAA0000001", "Pop", 12), // richest, but its style is chosen already
    row("AAAAA0000002", "gangsta rap", 9),
    row("AAAAA0000003", "electronic", 8),
    row("AAAAA0000004", "big beat", 8),
    row("AAAAA0000005", "k-pop", 7),
  ];
  const chosen = chooseShowcase(rows).map((r) => r.isrc);
  // Past the bar too: each style once, the richest map of each.
  assert.deepEqual(
    chosen.sort(),
    [omt, bss, hung, "AAAAA0000002", "AAAAA0000003", "AAAAA0000004", "AAAAA0000005"].sort(),
  );
});

test("of two maps as rich with one style, the first ISRC's; nothing when the bar cannot be met", () => {
  const base = [row(omt, "house", 9), row(bss, "rock", 5), row(hung, "pop", 6)];
  const tie = chooseShowcase(
    [
      ...base,
      row("ZZ0000000001", "a", 8),
      row("AA0000000001", "a", 8),
      row("MM0000000001", "a", 7),
    ],
    { minTracks: 4, minStyles: 4 },
  );
  assert.deepEqual(
    tie.map((r) => r.isrc),
    [bss, omt, hung, "AA0000000001"].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1)),
  );
  assert.equal(chooseShowcase([...base, row("AA0000000001", "pop", 8)]), null);
});

test("a current showcase keeps its slug; another row's is its title and first artist", () => {
  assert.equal(
    slugOf({ isrc: omt, title: "One More Time", artist: "Daft Punk" }),
    "one-more-time-daft-punk",
  );
  assert.equal(
    slugOf({ isrc: "USTB10250016", title: "Gangsta's Paradise", artist: "Coolio feat. L.V." }),
    "gangstas-paradise-coolio",
  );
  assert.equal(slugOf({ isrc: "X", title: "Natural Blues", artist: "Moby" }), "natural-blues-moby");
  assert.equal(Object.keys(CURRENT_SHOWCASES).length, 4);
});

test("the committed styles name a MusicBrainz lookup for every row that has one", () => {
  for (const [isrc, entry] of readStyles()) {
    if (entry.style === null) continue;
    assert.match(
      entry.url,
      /^https:\/\/musicbrainz\.org\/ws\/2\/[^?]+\?inc=genres[^ ]*&fmt=json$/,
      isrc,
    );
    assert.ok(["recording", "release-group", "artist"].includes(entry.level), isrc);
    assert.ok(Number.isInteger(entry.votes) && entry.votes > 0, isrc);
    // The style is the rule's own reading of the genre lists the file keeps: the top-voted
    // genre of the lookup it names, every earlier genre lookup of the row without a vote.
    const at = entry.lookups.findIndex((lookup) => lookup.url === entry.url);
    assert.ok(at >= 0, isrc);
    assert.deepEqual(topGenre({ genres: entry.lookups[at].genres }), {
      name: entry.style,
      count: entry.votes,
    });
    for (const lookup of entry.lookups.slice(0, at)) {
      if (lookup.genres) assert.equal(topGenre({ genres: lookup.genres }), null, isrc);
    }
    for (const lookup of entry.lookups) assert.ok(lookup.requests >= 1, isrc);
  }
  // Every request the script sent, a retry included, is counted with its lookup.
  const file = JSON.parse(readFileSync(join(REPO_ROOT, "evals/showcase-styles.json"), "utf8"));
  const sent = file.rows.flatMap((r) => r.lookups).reduce((n, l) => n + l.requests, 0);
  assert.equal(file.requests, sent);
});

test("a slug that would hold a query the result does not make public puts the artist first", () => {
  const norm = (text) =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const verve = { isrc: bss, title: "Bitter Sweet Symphony", artist: "The Verve" };
  const remaster = ["Bitter Sweet Symphony - Remastered 2016", "The Verve"];
  assert.equal(
    slugFor(verve, "Bitter Sweet Symphony The Verve", remaster, norm),
    "the-verve-bitter-sweet-symphony",
  );
  // The query is the result's own title and artist: public, so the slug is kept.
  assert.equal(
    slugFor(verve, "Bitter Sweet Symphony The Verve", ["Bitter Sweet Symphony The Verve"], norm),
    "bitter-sweet-symphony-the-verve",
  );
  // A slug that does not hold the query is kept.
  assert.equal(
    slugFor({ isrc: "X", title: "Natural Blues", artist: "Moby" }, "Moby Natural Blues", [], norm),
    "natural-blues-moby",
  );
});

// The committed showcase is the rule's own choice on the committed run and styles: a change to
// either (a style, a threshold, a run record) that would choose another set fails here.
test("the committed showcase recordings are the ones the rule chooses from the committed run", async () => {
  const chosen = chooseShowcase(await selectShowcase());
  assert.ok(chosen, "the rule chooses no showcase");
  const dir = join(REPO_ROOT, "fixtures/replays");
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort();
  assert.deepEqual(
    chosen.map((r) => `${r.slug}.json`),
    files,
  );
  // Each recording is its chosen row's run: the run's track and commit, completed when the
  // recording says (the run's start plus its latency, within 5 s), and that run's id.
  const runs = JSON.parse(
    readFileSync(join(REPO_ROOT, "evals/agent/runs/2026-10-31/d.json"), "utf8"),
  ).filter((run) => (run.repeat ?? 0) === 0);
  for (const row of chosen) {
    const record = JSON.parse(readFileSync(join(dir, `${row.slug}.json`), "utf8"));
    const result = JSON.parse(
      readFileSync(join(REPO_ROOT, `evals/agent/runs/2026-10-31/results/${row.isrc}.json`), "utf8"),
    );
    assert.equal(record.analysis.id, result.id, row.slug);
    const made = runs.filter(
      (run) =>
        run.commit === record.commit &&
        Math.abs(Date.parse(record.recordedAt) - (Date.parse(run.recordedAt) + run.latencyMs)) <=
          5000,
    );
    assert.deepEqual(
      made.map((run) => run.runId),
      [row.runId],
      row.slug,
    );
  }
  // And the API's own list of them (apps/api/src/replay/demo-recording.test.ts).
  const api = readFileSync(join(REPO_ROOT, "apps/api/src/replay/demo-recording.test.ts"), "utf8");
  const listed = /expect\(SLUGS\)\.toEqual\(\[([^\]]*)\]\)/.exec(api);
  assert.ok(listed, "demo-recording.test.ts lists no SLUGS");
  assert.deepEqual(
    [...listed[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]),
    chosen.map((r) => r.slug),
  );
});
