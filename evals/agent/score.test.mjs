// The scorer's rules on hand-made runs: strict edge matching against gold (one true positive per
// target, wrong relations and the track itself counted false), the per-run held-out domain
// exclusion, the hallucinated-sample rate, identity at recording level and the run-record shape.
// Run with: node --test 'evals/**/*.test.mjs'

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { ANY_SITE, citedSite, goldTargets, readGolden, site, subsetRows } from "./lib/golden.mjs";
import {
  edgeMetrics,
  identityCorrect,
  readRuns,
  scoreAll,
  scoreRun,
  supportRate,
  validateRun,
} from "./lib/score.mjs";

const golden = readGolden();
const row = (isrc) => golden.rows.find((r) => r.isrc === isrc);
const OMT = row("GBDUW0000053"); // One More Time: Wikipedia + LA Times + MusicBrainz, exhaustive
const CRAZY = row("GBAHT0600202"); // Crazy: one held-out edge, on Wikipedia only
const GANGSTA = row("USTB10250016"); // interpolation, with sample as an alternative
const HUNG_UP = row("USWB10504319"); // not exhaustive, with otherDocumentedTargets
const DREAMS = row("USWB19900178"); // no-sample control
const JUICY = row("USBB40000359"); // two targets; Juicy Fruit held out on Wikipedia and Rolling Stone

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
const cite = (url, excerpt = "") => ({ id: url, url, excerpt });
const outcomes = (s) => s.edges.map((e) => e.outcome);

test("sites fold subdomains, including country-code second levels", () => {
  assert.equal(site("https://en.wikipedia.org/wiki/X"), "wikipedia.org");
  assert.equal(site("https://de.m.wikipedia.org/wiki/X"), "wikipedia.org");
  assert.equal(site("http://news.bbc.co.uk/2/hi/x.stm"), "bbc.co.uk");
  assert.equal(site("https://www.latimes.com/x"), "latimes.com");
});

test("a cited page's site fails closed: archives count as the original, unknowns as every site", () => {
  assert.equal(citedSite("https://en.wikipedia.org./wiki/X"), "wikipedia.org");
  assert.equal(
    citedSite("https://web.archive.org/web/20200101000000/https://en.wikipedia.org/wiki/X"),
    "wikipedia.org",
  );
  assert.equal(citedSite("https://archive.ph/2020/http://www.latimes.com/x"), "latimes.com");
  assert.equal(
    citedSite("https://webcache.googleusercontent.com/search?q=cache:abc:https://www.bbc.co.uk/x"),
    "bbc.co.uk",
  );
  assert.equal(citedSite("en.wikipedia.org/wiki/X"), "wikipedia.org");
  for (const unknown of [
    "https://bit.ly/abc",
    "https://localhost/x",
    "not a url at all",
    "",
    null,
  ]) {
    assert.equal(citedSite(unknown), ANY_SITE, String(unknown));
  }
  assert.equal(
    citedSite("https://archive.ph/AbCdE"),
    ANY_SITE,
    "an archive id without its original",
  );
  // Mirrors, translation proxies and AMP caches count as the page they carry.
  for (const [url, expected] of [
    ["https://www.wikiwand.com/en/articles/Juicy_(The_Notorious_B.I.G._song)", "wikipedia.org"],
    ["https://en-m-wikipedia-org.translate.goog/wiki/Juicy?_x_tr_sl=en", "wikipedia.org"],
    ["https://www-latimes-com.cdn.ampproject.org/c/s/www.latimes.com/x", "latimes.com"],
    [
      "https://translate.google.com/translate?u=https://en.wikipedia.org/wiki/Juicy",
      "wikipedia.org",
    ],
    ["https://news-bbc-co-uk.translate.goog/x", "bbc.co.uk"],
  ]) {
    assert.equal(citedSite(url), expected, url);
  }
  // Any other URL that carries another URL is a proxy the rule does not know: every site.
  for (const url of [
    "https://proxy.example.net/fetch?url=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FJuicy",
    "https://reader.example.com/read/https://en.wikipedia.org/wiki/Juicy",
    "https://translate.google.com/translate?sl=auto",
  ]) {
    assert.equal(citedSite(url), ANY_SITE, url);
  }
  // Ordinary pages, MusicBrainz API calls included, keep their own site.
  assert.equal(
    citedSite("https://musicbrainz.org/ws/2/recording/x?inc=recording-rels+url-rels&fmt=json"),
    "musicbrainz.org",
  );
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
  assert.deepEqual(
    wrongRelation.edges.map((e) => [e.outcome, e.why]),
    [["fp", "right target, wrong relation"]],
  );
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
  assert.deepEqual(outcomes(s), ["tp", "fp"]);
});

test("one true positive per gold target: other spellings of it are duplicates, the code's copy first", () => {
  const s = scoreRun(
    OMT,
    run(OMT, {
      edges: [
        uses("More Spell on You", "Eddie Johns"),
        uses("More Spell On You (Remastered 2014)", "Eddie Johns"),
        {
          ...uses("Untitled", "Unknown"),
          target: { isrc: "FR10F1200080", title: "x", artist: "y" },
        },
        uses("More Spell on You", "Eddie Johns", "sample", "code"),
      ],
    }),
  );
  // The model's plain copy of the code's edge is merged into it; the remaster title and the
  // ISRC-only match are duplicates of the one credited target.
  assert.deepEqual(outcomes(s), ["tp", "duplicate", "duplicate"]);
  assert.equal(s.edges[0].edge.origin, "code", "the code-built copy is the one credited");
  const m = edgeMetrics([s]);
  assert.deepEqual([m.precision.k, m.precision.n, m.precision.duplicates], [1, 1, 2]);
  // Model precision covers only edges the code did not also build.
  assert.deepEqual([m.modelPrecision.k, m.modelPrecision.n], [0, 0]);
});

test("when code and model spell one target differently, the code's edge is credited", () => {
  const s = scoreRun(
    OMT,
    run(OMT, {
      edges: [
        uses("More Spell On You (Remastered 2014)", "Eddie Johns"),
        uses("More Spell on You", "Eddie Johns", "sample", "code"),
      ],
    }),
  );
  const credited = s.edges.find((e) => e.outcome === "tp");
  assert.equal(credited.edge.origin, "code");
  const m = edgeMetrics([s]);
  assert.deepEqual(
    [m.modelPrecision.k, m.modelPrecision.n, m.modelPrecision.duplicates],
    [0, 0, 1],
  );
});

test("a wrong-relation copy of a credited target is a false positive, not a duplicate", () => {
  const s = scoreRun(
    OMT,
    run(OMT, {
      edges: [
        uses("More Spell on You", "Eddie Johns"),
        uses("More Spell on You", "Eddie Johns", "cover"),
      ],
    }),
  );
  assert.deepEqual(
    s.edges.map((e) => [e.outcome, e.why ?? null]),
    [
      ["tp", null],
      ["fp", "right target, wrong relation"],
    ],
  );
});

test("the track itself proposed as its own sample is a false positive", () => {
  const s = scoreRun(HUNG_UP, run(HUNG_UP, { edges: [uses("Hung Up", "Madonna")] }));
  assert.deepEqual(
    s.edges.map((e) => [e.outcome, e.why]),
    [["fp", "the track itself"]],
  );
});

test("precision on a row that is not exhaustive: other documented targets and edges named in the evidence are left out", () => {
  const other = HUNG_UP.labels.otherDocumentedTargets[0].target;
  const s = scoreRun(
    HUNG_UP,
    run(HUNG_UP, {
      evidence: [
        cite("https://musicbrainz.org/x", 'Hung Up samples "Named Elsewhere" by Somebody Real.'),
      ],
      edges: [
        uses(other.title, other.artist),
        uses("Named Elsewhere", "Somebody Real"),
        uses("Not Named Anywhere", "Somebody"),
      ],
    }),
  );
  assert.deepEqual(outcomes(s), ["other-documented", "unresolved", "fp"]);
});

test("an unmatched edge leaves precision only when one evidence sentence names its title and artist", () => {
  const excerpt =
    'Hung Up samples "Dancing Queen" by ABBA. Love and Time are themes of the song. The song covers dance and pop.';
  const score = (target) =>
    scoreRun(
      HUNG_UP,
      run(HUNG_UP, {
        evidence: [cite("https://en.wikipedia.org/wiki/Hung_Up", excerpt)],
        edges: [uses(...target)],
      }),
    ).edges[0];
  // Common words that appear in the excerpt, but not as a named title with its artist.
  assert.equal(score(["Love", "Somebody"]).outcome, "fp");
  assert.equal(score(["Time", "Madonna"]).outcome, "fp");
  // Title named, but by another artist.
  assert.equal(score(["Dancing Queen", "Björn Again"]).outcome, "fp");
  // Title and artist named in one sentence with a relation.
  assert.equal(score(["Dancing Queen", "ABBA"]).outcome, "unresolved");
  // Named only in a negated sentence.
  const negated = scoreRun(
    HUNG_UP,
    run(HUNG_UP, {
      evidence: [
        cite("https://x.example.org/a", 'Hung Up does not sample "Holiday Two" by Somebody.'),
      ],
      edges: [uses("Holiday Two", "Somebody")],
    }),
  );
  assert.equal(negated.edges[0].outcome, "fp");
  // Title and artist named, but no relation, the other role, or another song's relation.
  for (const sentence of [
    'Hung Up and "Dancing Queen" by ABBA are both dance songs.',
    '"Dancing Queen" by ABBA samples Hung Up.',
    'Hung Up samples "Holiday" by Madonna, and "Dancing Queen" by ABBA is covered by Somebody.',
    '"Another Song" by Somebody Else samples "Dancing Queen" by ABBA.',
  ]) {
    const s = scoreRun(
      HUNG_UP,
      run(HUNG_UP, {
        evidence: [cite("https://x.example.org/a", sentence)],
        edges: [uses("Dancing Queen", "ABBA")],
      }),
    );
    assert.equal(s.edges[0].outcome, "fp", sentence);
  }
  // Bitter Sweet Symphony: a sentence about "The Last Time" covering "This May Be the Last Time"
  // says nothing about what Bitter Sweet Symphony samples.
  const bss = row("GBAAA9700049");
  const lineage = scoreRun(
    bss,
    run(bss, {
      evidence: [
        cite(
          "https://www.example-blog.com/x",
          '"The Last Time" by The Rolling Stones is a cover of "This May Be the Last Time" by the Staple Singers.',
        ),
      ],
      edges: [uses("This May Be the Last Time", "The Staple Singers")],
    }),
  );
  assert.equal(lineage.edges[0].outcome, "fp");
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
  // An archived copy of the page is the page.
  const archived = scoreRun(
    CRAZY,
    run(CRAZY, {
      edges,
      evidence: [cite("https://web.archive.org/web/2020/https://en.wikipedia.org/wiki/Crazy")],
    }),
  );
  assert.equal(archived.targets[0].heldOut, false);
  // A page whose site cannot be placed counts as citing every site.
  const shortened = scoreRun(CRAZY, run(CRAZY, { edges, evidence: [cite("https://bit.ly/x")] }));
  assert.equal(shortened.targets[0].heldOut, false);
  assert.deepEqual(shortened.targets[0].excludedBy, ["wikipedia.org"]);
  // MusicBrainz, which the pipeline queries, does not take held-out credit away.
  const mb = scoreRun(CRAZY, run(CRAZY, { edges, evidence: [cite("https://musicbrainz.org/x")] }));
  assert.equal(mb.targets[0].heldOut, true);
});

test("held-out: only a target that no queried source documents is held-out", () => {
  // One More Time and Juicy's targets also have a MusicBrainz source, which the pipeline queries:
  // a run that only echoes MusicBrainz must get no held-out credit for them.
  for (const r of [OMT, JUICY, HUNG_UP, GANGSTA]) {
    const s = scoreRun(r, run(r, { evidence: [cite("https://musicbrainz.org/recording/x")] }));
    for (const t of s.targets) {
      assert.equal(t.heldOutDefault, false, t.key);
      assert.equal(t.heldOut, false, t.key);
    }
  }
  // Crazy's target has only a Wikipedia source: held-out, until a run cites Wikipedia.
  const page = CRAZY.labels.edges[0].sourceUrl;
  assert.equal(scoreRun(CRAZY, run(CRAZY)).targets[0].heldOut, true);
  const cited = scoreRun(CRAZY, run(CRAZY, { evidence: [cite(page)] }));
  assert.equal(cited.targets[0].heldOut, false);
  assert.deepEqual(cited.targets[0].excludedBy, ["wikipedia.org"]);
  // The live set has one such target: held-out recall rests on it and is shown as counts.
  const live = golden.rows.filter((r) => r.liveSubset);
  const all = live.flatMap((r) => goldTargets(r));
  assert.equal(all.filter((t) => t.sources.every((x) => x.heldOut)).length, 1);
});

test("held-out n is counted after the per-run exclusion", () => {
  const edges = [uses("Last Men Standing", "Gian Piero Reverberi & Gian Franco Reverberi")];
  const runs = [
    run(CRAZY, { evidence: [cite("https://en.wikipedia.org/wiki/Crazy")] }),
    run(CRAZY, { edges }),
    run(OMT, { edges: [uses("More Spell on You", "Eddie Johns")] }),
  ];
  const scored = runs.map((r) => scoreRun(row(r.isrc), r));
  const m = edgeMetrics(scored);
  assert.deepEqual([m.heldOut.gold, m.heldOut.excluded, m.heldOut.n, m.heldOut.k], [2, 1, 1, 1]);
});

test("in the test data the deterministic row finds no held-out target", () => {
  const runs = readRuns(join(dirname(fileURLToPath(import.meta.url)), "testdata", "runs"));
  const result = scoreAll(golden, runs, { subset: "all" });
  assert.equal(result.ablations.b.heldOut.k, 0);
  assert.ok(result.ablations.b.heldOut.gold > 0);
});

test("two records for one row, ablation and repeat are refused, naming both files", () => {
  const dir = mkdtempSync(join(tmpdir(), "evals-runs-"));
  try {
    const d = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "testdata", "runs", "ablation-d.json"),
    );
    writeFileSync(join(dir, "ablation-d.json"), d);
    writeFileSync(join(dir, "ablation-d-rerun.json"), d);
    assert.throws(
      () => scoreAll(golden, readRuns(dir)),
      /two run records for \w+, ablation d, repeat 0: ablation-d-rerun\.json\[\d+\] and ablation-d\.json\[\d+\]/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one synthetic record makes the whole result synthetic; the flag must be a boolean", () => {
  const real = run(OMT, { commit: "abc1234" });
  assert.equal(scoreAll(golden, [real]).synthetic, false);
  assert.equal(scoreAll(golden, [real, run(CRAZY, { synthetic: true })]).synthetic, true);
  assert.throws(
    () => validateRun(run(OMT, { synthetic: "true" })),
    /synthetic must be true or false/,
  );
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
  assert.deepEqual(m.edgesPerControl.values, [0, 1]);
  assert.equal(m.edgesPerControl.ci, null, "no bootstrap below n = 10");
});

test("identity is scored at recording level: another ISRC of the same MusicBrainz recording is correct", () => {
  const runs = [
    run(OMT, { identity: { isrc: "GBDUW0000059", mbid: OMT.mbid } }),
    run(DREAMS, { identity: { isrc: DREAMS.isrc, mbid: "00000000-0000-0000-0000-000000000000" } }),
  ];
  const result = scoreAll(golden, runs);
  assert.deepEqual([result.pipeline.identity.k, result.pipeline.identity.n], [1, 2]);
  // Per run: the MusicBrainz recording decides when both sides know it, else the ISRC.
  assert.equal(identityCorrect(OMT, { identity: { isrc: "GBDUW0000059", mbid: OMT.mbid } }), true);
  assert.equal(
    identityCorrect(DREAMS, { identity: { isrc: DREAMS.isrc, mbid: "not-the-recording" } }),
    false,
    "the same ISRC with another recording is wrong",
  );
  assert.equal(identityCorrect(OMT, { identity: { isrc: OMT.isrc } }), true);
  assert.equal(identityCorrect(OMT, { identity: { isrc: "GBDUW0000059" } }), false);
  assert.equal(identityCorrect(OMT, {}), false);
});

test("the pre-verifier support rate is over row c model claims; unjudged claims count as not supported", () => {
  const claims = [
    { text: "a", origin: "model", verdict: "supported" },
    { text: "b", origin: "model", verdict: "unsupported" },
    { text: "c", origin: "model", verdict: null },
    { text: "d", origin: "code", verdict: "supported" },
  ];
  const r = supportRate([run(OMT, { ablation: "c", claims })]);
  assert.deepEqual([r.k, r.n, r.unjudged], [1, 3, 1]);
  const result = scoreAll(golden, [
    run(OMT, { ablation: "c", claims }),
    run(OMT, { ablation: "d", claims: [{ text: "a", origin: "model", verdict: "supported" }] }),
  ]);
  assert.deepEqual([result.pipeline.support.k, result.pipeline.support.n], [1, 3]);
});

test("run records in an unknown shape are refused, naming the field", () => {
  assert.throws(() => validateRun(run(OMT, { ablation: "e" })), /ablation "e"/);
  assert.throws(
    () => validateRun(run(OMT, { edges: [{ ...uses("A", "B"), relation: "smaple" }] })),
    /relation "smaple"/,
  );
  assert.throws(
    () => validateRun(run(OMT, { edges: [{ ...uses("A", "B"), direction: "forward" }] })),
    /direction "forward"/,
  );
  assert.throws(
    () => validateRun(run(OMT, { edges: [{ ...uses("A", "B"), origin: "llm" }] })),
    /origin "llm"/,
  );
  assert.doesNotThrow(() => validateRun(run(OMT, { edges: [uses("A", "B", "remix")] })));
  assert.throws(
    () => validateRun(run(OMT, { edges: [uses("A\n## Injected", "B")] })),
    /control character/,
  );
  const dir = mkdtempSync(join(tmpdir(), "evals-runs-"));
  try {
    writeFileSync(
      join(dir, "x.json"),
      JSON.stringify([run(OMT, { edges: [{ ...uses("A", "B"), relation: "x" }] })]),
    );
    assert.throws(() => readRuns(dir), /x\.json\[0\].*relation "x"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the CI subset is six live rows; runs for rows outside the live subset are refused", () => {
  assert.equal(subsetRows(golden, "ci").length, 6);
  const notLive = golden.rows.find((r) => !r.liveSubset);
  assert.throws(() => scoreAll(golden, [run(notLive)]), /not live golden rows/);
});
