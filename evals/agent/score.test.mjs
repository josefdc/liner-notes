// The scorer's rules on hand-made runs: strict edge matching against gold, the per-run held-out
// domain exclusion, the hallucinated-sample rate and identity at recording level.
// Run with: node --test 'evals/**/*.test.mjs'

import assert from "node:assert/strict";
import { test } from "node:test";

import { goldTargets, readGolden, site, subsetRows } from "./lib/golden.mjs";
import { edgeMetrics, scoreAll, scoreRun } from "./lib/score.mjs";

const golden = readGolden();
const row = (isrc) => golden.rows.find((r) => r.isrc === isrc);
const OMT = row("GBDUW0000053"); // One More Time: Wikipedia + LA Times + MusicBrainz, exhaustive
const CRAZY = row("GBAHT0600202"); // Crazy: one held-out edge, on Wikipedia only
const GANGSTA = row("USTB10250016"); // interpolation, with sample as an alternative
const HUNG_UP = row("USWB10504319"); // not exhaustive, with otherDocumentedTargets
const DREAMS = row("USWB19900178"); // no-sample control

const uses = (title, artist, relation = "sample", origin = "model") => ({
  direction: "uses",
  relation,
  origin,
  target: { title, artist },
  evidenceIds: [],
});
const run = (r, extra = {}) => ({
  isrc: r.isrc,
  ablation: "d",
  repeat: 0,
  evidence: [],
  edges: [],
  ...extra,
});
const cite = (url) => ({ id: url, url, excerpt: "" });

test("sites fold subdomains, including country-code second levels", () => {
  assert.equal(site("https://en.wikipedia.org/wiki/X"), "wikipedia.org");
  assert.equal(site("https://de.m.wikipedia.org/wiki/X"), "wikipedia.org");
  assert.equal(site("http://news.bbc.co.uk/2/hi/x.stm"), "bbc.co.uk");
  assert.equal(site("https://www.latimes.com/x"), "latimes.com");
});

test("gold targets are grouped per distinct target, however many sources back them", () => {
  const targets = goldTargets(OMT);
  assert.equal(targets.length, 1);
  assert.deepEqual(targets[0].sources.map((s) => s.site).sort(), [
    "latimes.com",
    "musicbrainz.org",
    "wikipedia.org",
  ]);
});

test("recall: same title and artist with the gold relation or an accepted alternative", () => {
  const found = scoreRun(OMT, run(OMT, { edges: [uses("More Spell On You", "Eddie Johns")] }));
  assert.equal(found.targets[0].found, true);
  const wrongRelation = scoreRun(
    OMT,
    run(OMT, { edges: [uses("More Spell on You", "Eddie Johns", "cover")] }),
  );
  assert.equal(wrongRelation.targets[0].found, false);
  const alternative = scoreRun(
    GANGSTA,
    run(GANGSTA, { edges: [uses("Pastime Paradise", "Stevie Wonder", "sample")] }),
  );
  assert.equal(alternative.targets[0].found, true);
  const substring = scoreRun(
    OMT,
    run(OMT, { edges: [uses("More Spell on You (remix)", "Eddie Johns")] }),
  );
  assert.equal(substring.targets[0].found, false, "a different take is not the gold recording");
});

test("reverse edges (the target uses this track) are never scored", () => {
  const reverse = { ...uses("More Spell on You", "Eddie Johns"), direction: "usedBy" };
  const s = scoreRun(OMT, run(OMT, { edges: [reverse] }));
  assert.equal(s.targets[0].found, false);
  assert.equal(s.edges.length, 0);
});

test("precision is strict: exhaustive rows count every other edge as a false positive", () => {
  const s = scoreRun(
    OMT,
    run(OMT, { edges: [uses("More Spell on You", "Eddie Johns"), uses("Invented", "Nobody")] }),
  );
  assert.deepEqual(
    s.edges.map((e) => e.outcome),
    ["tp", "fp"],
  );
});

test("precision on a row that is not exhaustive: other documented targets and named edges are left out", () => {
  const other = HUNG_UP.labels.otherDocumentedTargets[0].target;
  const s = scoreRun(
    HUNG_UP,
    run(HUNG_UP, {
      evidence: [
        { id: "e", url: "https://musicbrainz.org/x", excerpt: 'It samples "Named Elsewhere".' },
      ],
      edges: [
        uses(other.title, other.artist),
        uses("Named Elsewhere", "Somebody"),
        uses("Not Named Anywhere", "Somebody"),
      ],
    }),
  );
  assert.deepEqual(
    s.edges.map((e) => e.outcome),
    ["other-documented", "unresolved", "fp"],
  );
});

test("held-out: a run citing the gold source's site loses held-out credit for that target", () => {
  const edges = [uses("Last Men Standing", "Gian Piero Reverberi & Gian Franco Reverberi")];
  const clean = scoreRun(CRAZY, run(CRAZY, { edges }));
  assert.equal(clean.targets[0].heldOut, true);
  const citing = scoreRun(
    CRAZY,
    run(CRAZY, { edges, evidence: [cite("https://en.wikipedia.org/wiki/Crazy")] }),
  );
  assert.equal(citing.targets[0].heldOutDefault, true);
  assert.equal(citing.targets[0].heldOut, false, "the only held-out source is on a cited site");
  // Another Wikipedia language is the same site.
  const otherLanguage = scoreRun(
    CRAZY,
    run(CRAZY, { edges, evidence: [cite("https://de.wikipedia.org/wiki/Crazy")] }),
  );
  assert.equal(otherLanguage.targets[0].heldOut, false);
  // One More Time keeps held-out credit through its LA Times edge.
  const omt = scoreRun(
    OMT,
    run(OMT, { evidence: [cite("https://en.wikipedia.org/wiki/One_More_Time")] }),
  );
  assert.equal(omt.targets[0].heldOut, true);
});

test("held-out n is counted after the per-run exclusion, and the report uses it", () => {
  const runs = [
    run(CRAZY, { evidence: [cite("https://en.wikipedia.org/wiki/Crazy")] }),
    run(OMT, { edges: [uses("More Spell on You", "Eddie Johns")] }),
  ];
  const scored = runs.map((r) => scoreRun(row(r.isrc), r));
  const m = edgeMetrics(scored);
  assert.equal(m.heldOut.gold, 2);
  assert.equal(m.heldOut.excluded, 1);
  assert.equal(m.heldOut.n, 1);
  assert.equal(m.heldOut.k, 1);
});

test("hallucinated-sample rate: any forward sample, interpolation or cover on a no-sample control", () => {
  const none = scoreRun(
    DREAMS,
    run(DREAMS, { edges: [{ ...uses("Something", "Someone"), direction: "usedBy" }] }),
  );
  assert.equal(none.hallucinated, false);
  const one = scoreRun(
    DREAMS,
    run(DREAMS, { edges: [uses("Something", "Someone", "interpolation")] }),
  );
  assert.equal(one.hallucinated, true);
  const m = edgeMetrics([none, one]);
  assert.deepEqual([m.hallucination.k, m.hallucination.n], [1, 2]);
  assert.equal(m.edgesPerControl.value, 0.5);
});

test("identity is scored at recording level: another ISRC of the same MusicBrainz recording is correct", () => {
  const runs = [
    run(OMT, { identity: { isrc: "GBDUW0000059", mbid: OMT.mbid } }),
    run(DREAMS, { identity: { isrc: DREAMS.isrc, mbid: "00000000-0000-0000-0000-000000000000" } }),
  ];
  const result = scoreAll(golden, runs);
  assert.deepEqual([result.pipeline.identity.k, result.pipeline.identity.n], [1, 2]);
});

test("the CI subset is six live rows; runs for rows outside the live subset are refused", () => {
  assert.equal(subsetRows(golden, "ci").length, 6);
  const notLive = golden.rows.find((r) => !r.liveSubset);
  assert.throws(() => scoreAll(golden, [run(notLive)]), /not live golden rows/);
});
