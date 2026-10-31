import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CURRENT_SHOWCASES,
  chooseShowcase,
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

test("the eligible current showcases come first, then the richest maps that add a style", () => {
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
  assert.deepEqual(chosen.sort(), [omt, bss, hung, "AAAAA0000002", "AAAAA0000003"].sort());
});

test("ties between maps go by ISRC, and nothing is chosen when the bar cannot be met", () => {
  const base = [row(omt, "house", 9), row(bss, "rock", 5), row(hung, "pop", 6)];
  const tie = chooseShowcase([...base, row("ZZ0000000001", "a", 8), row("AA0000000001", "b", 8)], {
    minTracks: 4,
    minStyles: 4,
  });
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
    assert.ok(entry.lookups.includes(entry.url), isrc);
  }
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
