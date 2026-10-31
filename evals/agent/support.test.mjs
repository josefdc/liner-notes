// The deterministic support check (lib/support.mjs): a claim passes only when one sentence of a
// cited excerpt holds all of it, entities, years and relation with the same roles.
// Run with: node --test 'evals/**/*.test.mjs'

import assert from "node:assert/strict";
import { test } from "node:test";

import { checkSupport, entitiesIn, sentences } from "./lib/support.mjs";
import { readRecordings } from "./make-perturb.mjs";

const supported = (claim, ...excerpts) => checkSupport(claim, excerpts).supported;

const JUICY =
  '"Juicy" is a 1994 song by The Notorious B.I.G. It samples "Juicy Fruit" by Mtume. Puff Daddy covered several songs in 1997.';

test("claims the excerpt does not state are refused", () => {
  for (const claim of [
    "It was released in 1994.", // no entity
    "It samples a disco record.", // nothing named after the relation
    'Mtume never sampled "Juicy".', // negated
    "Mtume samples The Notorious B.I.G.", // roles and entities not in one sentence
    '"Juicy" covers "Juicy Fruit" by Mtume.', // another relation
    'Mtume released "Juicy Fruit" in 1997.', // 1997 is in another sentence
    "Juicy samples a drum break by james brown from 1970s.", // a decade the excerpt lacks
    "It samples Fruit.", // part of an entity is not the entity
    "The Notorious B.I.G. recorded it in 1994. This was later sampled by everyone on earth.",
    '"Juicy" samples "Juicy Fruit" by Prince.', // another artist
  ]) {
    assert.equal(supported(claim, JUICY), false, claim);
  }
});

test("an excerpt that does not state the claim as fact, or states something else, is refused", () => {
  const claim = '"Juicy" samples "Juicy Fruit" by Mtume.';
  const fact = '"Juicy" by The Notorious B.I.G. samples "Juicy Fruit" by Mtume.';
  assert.equal(supported(claim, fact), true, "control");
  for (const excerpt of [
    // Negated or hedged in the excerpt.
    '"Juicy" does not sample "Juicy Fruit" by Mtume.',
    'It is often wrongly claimed that "Juicy" samples "Juicy Fruit" by Mtume.',
    '"Juicy" by The Notorious B.I.G. wrongly samples "Juicy Fruit" by Mtume.',
    '"Juicy" was at first going to sample "Juicy Fruit" by Mtume.',
    '"Juicy" planned to sample "Juicy Fruit" by Mtume.',
    'Some say "Juicy" supposedly samples "Juicy Fruit" by Mtume.',
  ]) {
    assert.equal(supported(claim, excerpt), false, excerpt);
  }
});

test("a year belongs to its clause: the year of one title does not date another", () => {
  const ex = '"Juicy" is a 1994 song by The Notorious B.I.G. that samples "Juicy Fruit" by Mtume.';
  assert.equal(supported('"Juicy Fruit" by Mtume was released in 1994.', ex), false);
  assert.equal(supported('"Juicy" by The Notorious B.I.G. came out in 1994.', ex), true);
});

test("a claim that names nothing after its relation cannot be checked", () => {
  const ex = '"Juicy" by The Notorious B.I.G. samples "Juicy Fruit" by Mtume.';
  assert.equal(supported('"Juicy" samples a drum break.', ex), false);
  assert.equal(supported('"Juicy" samples "Juicy Fruit".', ex), true);
});

test("the verb of a relative clause is not credited to the sentence's subject", () => {
  assert.equal(
    supported(
      '"Bitter Sweet Symphony" is a cover of "This May Be the Last Time" by the Staple Singers.',
      '"Bitter Sweet Symphony" is based on an orchestral version of "The Last Time", which itself was a cover of "This May Be the Last Time" by the Staple Singers.',
    ),
    false,
  );
  const ex = '"Juicy" samples "Juicy Fruit" by Mtume, which was covered by Lil\' Kim.';
  assert.equal(supported('"Juicy" is covered by Lil\' Kim.', ex), false);
  assert.equal(supported('"Juicy" samples "Juicy Fruit" by Mtume.', ex), true);
});

test("an entity after a second verb is not the object of the first", () => {
  const ex =
    '"Juicy" by The Notorious B.I.G. samples "Juicy Fruit" by Mtume and was later covered by Puff Daddy.';
  assert.equal(supported('"Juicy" samples Puff Daddy.', ex), false);
  assert.equal(supported('"Juicy" samples "Juicy Fruit" by Mtume.', ex), true);
  assert.equal(supported('"Juicy" is covered by Puff Daddy.', ex), true);
});

test("a month and day, when the claim gives them, must be the excerpt's", () => {
  const ex =
    'MusicBrainz recording "Bitter Sweet Symphony" by The Verve, first released 1997-06-01.';
  const claim = (date) => `"Bitter Sweet Symphony" by The Verve was first released on ${date}.`;
  assert.equal(supported(claim("June 1, 1997"), ex), true);
  assert.equal(supported(claim("1 June 1997"), ex), true);
  assert.equal(supported(claim("June 1997"), ex), true);
  assert.equal(supported(claim("June 2, 1997"), ex), false);
  assert.equal(supported(claim("July 1, 1997"), ex), false);
  assert.equal(supported(claim("March 1997"), ex), false);
  // A claim's full date against an excerpt that gives only the year: not enough.
  assert.equal(
    supported(claim("June 1, 1997"), '"Bitter Sweet Symphony" by The Verve, released 1997.'),
    false,
  );
});

test("what one excerpt sentence states passes", () => {
  assert.equal(supported('It samples "Juicy Fruit" by Mtume.', JUICY), true);
  assert.equal(supported('"Juicy" by The Notorious B.I.G. dates from 1994.', JUICY), true);
});

test("direction: who samples whom must match, active or passive", () => {
  const ex = 'MusicBrainz: "Juicy" by The Notorious B.I.G. samples "Juicy Fruit" by Mtume.';
  assert.equal(supported('"Juicy Fruit" by Mtume is sampled in "Juicy".', ex), true);
  assert.equal(
    supported('"Juicy Fruit" by Mtume samples "Juicy" by The Notorious B.I.G.', ex),
    false,
  );
  assert.equal(supported('"Juicy" is sampled in "Juicy Fruit".', ex), false);
  assert.equal(
    supported('MusicBrainz credits "Juicy" with sampling Mtume’s "Juicy Fruit."', ex),
    true,
  );
});

test("only the relation differs: refused", () => {
  const ex =
    'MusicBrainz: the work "Bitter Sweet Symphony" is covered by "Bitter Sweet Symphony" by London Grammar.';
  assert.equal(
    supported(
      'The work "Bitter Sweet Symphony" is covered by "Bitter Sweet Symphony" by London Grammar.',
      ex,
    ),
    true,
  );
  for (const relation of ["sampled in", "remixed in", "interpolated in"]) {
    assert.equal(
      supported(
        `The work "Bitter Sweet Symphony" is ${relation} "Bitter Sweet Symphony" by London Grammar.`,
        ex,
      ),
      false,
      relation,
    );
  }
});

test("only the role differs: refused", () => {
  const ex =
    'MusicBrainz: the work "Bitter Sweet Symphony" is covered by "Bitter Sweet Symphony" by E^ST.';
  assert.equal(
    supported(
      'The work "Bitter Sweet Symphony" is a cover of "Bitter Sweet Symphony" by E^ST.',
      ex,
    ),
    false,
  );
});

test("years are standalone tokens: not inside an ISRC or a catalogue number", () => {
  const ex =
    'MusicBrainz recording "Juicy" by The Notorious B.I.G., ISRC USUM71920161, catalogue AR2005-11.';
  assert.equal(supported('"Juicy" by The Notorious B.I.G. came out in 1920.', ex), false);
  assert.equal(supported('"Juicy" by The Notorious B.I.G. came out in 2005.', ex), false);
  assert.equal(
    supported(
      '"Juicy" by The Notorious B.I.G. came out in 1994.',
      '"Juicy" by The Notorious B.I.G., 1994-08-09.',
    ),
    true,
  );
});

test("a decade matches only a decade", () => {
  const decade = '"Juicy Fruit" by Mtume is a 1980s record.';
  const year = '"Juicy Fruit" by Mtume is a 1980 record.';
  assert.equal(supported('"Juicy Fruit" by Mtume is from the 1980s.', decade), true);
  assert.equal(supported('"Juicy Fruit" by Mtume is from the 1980s.', year), false);
  assert.equal(supported('"Juicy Fruit" by Mtume is from 1980.', decade), false);
});

test("entities are whole: an inner The is kept, a name in lower case after by is a name", () => {
  assert.deepEqual(
    entitiesIn("Daft Punk & The Chemical Brothers remix it").map((e) => e.text),
    ["Daft Punk & The Chemical Brothers"],
  );
  assert.ok(entitiesIn('"Hung Up" by verymilkee.').some((e) => e.text === "verymilkee"));
  const ex =
    'MusicBrainz: "Hung Up" by Madonna is remixed in "Hung Up (Chus & Ceballos remix)" by Madonna.';
  assert.equal(
    supported(
      '"Hung Up" by verymilkee is remixed in "Hung Up (Chus & Ceballos remix)" by Madonna.',
      ex,
    ),
    false,
  );
});

test("sentences split after a full stop but not after feat. or inside a quoted title", () => {
  assert.deepEqual(
    sentences('A song by Mos Def feat. Talib Kweli. It samples "Gimme! Gimme! Gimme!" by ABBA.'),
    ["A song by Mos Def feat. Talib Kweli.", 'It samples "Gimme! Gimme! Gimme!" by ABBA.'],
  );
});

test("every code-built sourced claim of the recordings passes against what it cites", () => {
  let n = 0;
  for (const r of readRecordings()) {
    const byId = new Map(r.analysis.evidence.map((e) => [e.id, e.excerpt]));
    for (const c of r.analysis.claims.filter((x) => x.origin === "code" && x.kind === "sourced")) {
      const excerpts = c.evidenceIds.map((id) => byId.get(id)).filter(Boolean);
      if (excerpts.length === 0) continue;
      n++;
      assert.equal(checkSupport(c.text, excerpts).supported, true, `${r.slug}: ${c.text}`);
    }
  }
  assert.ok(n >= 20, `${n} code-built claims`);
});
