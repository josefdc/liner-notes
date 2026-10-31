// The deterministic support check: does an excerpt a claim cites state what the claim says?
// It never reads a judge's verdict, and it errs towards "not supported". It is a conservative
// heuristic over English sentences, not a reader: it can refuse a supported claim, and a claim
// it passes still needs a person's reading before a report built on it is published.
//
// Each sentence of the claim must:
// - name at least one entity (a quoted title, or a name: a run of capitalised words outside
//   quotes, without a leading article, sentence opener, month or source name; or a name in lower
//   case after "by"), and state a year, a decade or a relation (sample, cover, remix,
//   interpolation);
// - with a relation, name an entity after its verb ("Juicy samples a drum break" names nothing
//   it samples);
// - carry no negation or hedge ("never", "not", "n't", "disputed", "wrongly", "planned",
//   "going to"…).
// Then one sentence of one cited excerpt, itself not negated or hedged, must hold all of it:
// - every entity as a whole entity: it equals a quoted title or a name there ("Fruit" is not
//   "Juicy Fruit");
// - every year as a standalone token (not inside an ISRC or "AR2005-11"), in a clause that names
//   one of the entities the claim gives the year to ("'Juicy' is a 1994 song" does not date
//   "Juicy Fruit"); a decade ("1960s") matches only a decade; a month and day, when the claim
//   gives them, must be the excerpt's (in any of the usual spellings);
// - every relation, with each entity in the same role towards that relation: what comes before
//   a verb uses what comes after it, the other way for a passive ("A samples B" and "B is
//   sampled in A" agree; "B samples A" does not). The words after a verb reach only to the next
//   verb or clause word (and, which, that, who, while, but, ;), so "samples X and was covered by
//   Y" does not make Y sampled; the words before it start after the last relative-clause word
//   (which, that, who, ;), so "X samples Y, which was covered by Z" does not make X covered.

export function normText(s) {
  return String(s ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .normalize("NFC")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Does `haystack` contain `needle` as whole words, after normalisation? */
export function containsWords(haystack, needle) {
  const n = normText(needle);
  if (!n) return false;
  return ` ${normText(haystack)} `.includes(` ${n} `);
}

const QUOTED = /[“"]([^”"]+)[”"]/g;
const YEAR = /(?<![\p{L}\p{N}])(1[89]\d{2}|20\d{2})(?![\p{L}\p{N}])/gu;
const DECADE = /(?<![\p{L}\p{N}])((?:1[89]|20)\d0)s(?![\p{L}\p{N}])/gu;
const NEGATION =
  /\b(?:not|never|no|neither|nor|without|denied|denies|deny|disputed|disputes|unconfirmed|unproven|allegedly|reportedly|wrongly|falsely|mistakenly|erroneously|incorrectly|misattributed|rumou?r(?:ed|s)?|myth|apocryphal|supposedly|claimed|planned|plans|planning|intended|intends|meant|considered|proposed|attempted|tried|wanted|hoped|would|could|might)\b|\b(?:going|was|were)\s+to\s+(?:sampl|cover|remix|interpolat)|n['’]t\b/i;
const MONTH_NAMES =
  "january february march april may june july august september october november december".split(
    " ",
  );
const MONTH = `(${MONTH_NAMES.join("|")})`;
const DATE_FORMS = [
  // 1997-06-01, 1997-06
  [
    /(?<![\p{L}\p{N}])(1[89]\d{2}|20\d{2})-(\d{2})(?:-(\d{2}))?(?![\p{L}\p{N}])/gu,
    (m) => [m[1], +m[2], m[3] ? +m[3] : null],
  ],
  // June 1, 1997 · June 1st 1997
  [
    new RegExp(
      String.raw`\b${MONTH}\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(1[89]\d{2}|20\d{2})\b`,
      "giu",
    ),
    (m) => [m[3], MONTH_NAMES.indexOf(m[1].toLowerCase()) + 1, +m[2]],
  ],
  // 1 June 1997
  [
    new RegExp(
      String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+${MONTH},?\s+(1[89]\d{2}|20\d{2})\b`,
      "giu",
    ),
    (m) => [m[3], MONTH_NAMES.indexOf(m[2].toLowerCase()) + 1, +m[1]],
  ],
  // June 1997
  [
    new RegExp(String.raw`\b${MONTH},?\s+(1[89]\d{2}|20\d{2})\b`, "giu"),
    (m) => [m[2], MONTH_NAMES.indexOf(m[1].toLowerCase()) + 1, null],
  ],
];

/** The dates a sentence states with at least a month: { year, month, day | null }. */
export function datesIn(sentence) {
  const out = [];
  for (const [re, parse] of DATE_FORMS) {
    for (const m of sentence.matchAll(re)) {
      const [year, month, day] = parse(m);
      if (month >= 1 && month <= 12) out.push({ year, month, day });
    }
  }
  return out;
}

// Words that start a new clause: the words after a relation verb stop there.
const CLAUSE =
  /\s(?:and|which|that|who|whom|whose|while|whereas|but|although|though|before|after)\s|;/gi;

// Words that start a relative clause: the words before a relation verb stop there, so the verb
// of "X samples Y, which was covered by Z" is not credited to X.
const RELATIVE = /\s(?:which|that|who|whom|whose)\s|;/gi;

// A relation: a verb, or "a/the <noun> of". A past participle followed by in, by or on is
// passive ("is sampled in", "has been covered by", "a source sampled in").
const RELATION =
  /\b(sampl|cover|remix|interpolat)(es|ed|ing|s|e)?\b(\s+(?:in|by|on)\b)?|\b(?:a|the)\s+(sample|cover|remix|interpolation)\s+of\b/giu;
const RELATION_CLASS = {
  sampl: "sample",
  sample: "sample",
  cover: "cover",
  remix: "remix",
  interpolat: "interpolation",
  interpolation: "interpolation",
};

function relationOf(m) {
  const stem = (m[1] ?? m[4]).toLowerCase();
  const passive = m[1] !== undefined && m[2]?.toLowerCase() === "ed" && m[3] !== undefined;
  return { relation: RELATION_CLASS[stem], passive, at: m.index, end: m.index + m[0].length };
}

/** The relations a text states ("samples", "is covered by"…), by class. */
export function relationsIn(text) {
  return [...new Set([...String(text).matchAll(RELATION)].map((m) => relationOf(m).relation))];
}

const ABBREVIATIONS = new Set("feat ft vs mr mrs dr st no jr sr vol op".split(" "));

/** Sentences, split after . ! ? before a capital, a digit or a quote, except after "feat." etc. */
export function sentences(text) {
  const s = String(text);
  const out = [];
  let start = 0;
  for (const m of s.matchAll(/[.!?][”"’)]?\s+(?=[\p{Lu}\p{N}“"‘])/gu)) {
    const head = s.slice(start, m.index + 1);
    const before = head.match(/(\p{L}+)[.!?]$/u)?.[1]?.toLowerCase();
    if (before && ABBREVIATIONS.has(before)) continue;
    // Inside a quoted title ("Gimme! Gimme! Gimme!") there is no sentence end.
    const curly = (head.match(/“/g) ?? []).length - (head.match(/”/g) ?? []).length;
    if (curly > 0 || (head.match(/"/g) ?? []).length % 2 === 1) continue;
    out.push(s.slice(start, m.index + 1).trim());
    start = m.index + m[0].length;
  }
  out.push(s.slice(start).trim());
  return out.filter(Boolean);
}

// Words that open a run of capitalised words without being part of a name, and the sources' own
// names. Only a leading one is dropped: "Daft Punk & The Chemical Brothers" keeps its "The".
const OPENERS = new Set(
  (
    "The This That These Those It Its A An In On At Of And Also Both He She They His Her Their " +
    "MusicBrainz Wikipedia Discogs Genius Spotify Deezer WhoSampled"
  ).split(" "),
);
const MONTHS = new Set(
  "January February March April May June July August September October November December".split(
    " ",
  ),
);
const NAME_RUN = /\p{Lu}[\p{L}\p{N}.'’‐-]*(?:\s+(?:&\s+)?\p{Lu}[\p{L}\p{N}.'’‐-]*)*/gu;

const LOWER_NAME_AFTER_BY = /\bby ([\p{Ll}\p{N}][\p{L}\p{N}^_'’-]*(?:\.[\p{L}\p{N}]+)*)/gu;
const LOWER_WORDS = new Set("the a an his her their its our this that these those".split(" "));

/** The key a name has as an entity: without a leading article ("The Verve" is "verve"). */
export function nameKey(text) {
  const words = String(text ?? "")
    .trim()
    .split(/\s+/);
  while (words.length > 1 && OPENERS.has(words[0])) words.shift();
  return normText(words.join(" ").replace(/['’]s$/, ""));
}

/** The entities of a sentence: quoted titles and names, each with its key and position. */
export function entitiesIn(sentence) {
  const out = [];
  for (const m of sentence.matchAll(QUOTED)) {
    const key = normText(m[1]);
    if (key) out.push({ key, text: m[1], at: m.index, kind: "title" });
  }
  // Quoted titles are blanked out (same length, so positions hold); a blank breaks a run of
  // names: "Jay-Z’s “A Dream,” RBX’s" holds two names.
  const unquoted = sentence.replace(QUOTED, (q) => ` ${",".repeat(q.length - 2)} `);
  for (const m of unquoted.matchAll(NAME_RUN)) {
    const words = m[0]
      .replace(/['’]s\b/g, "")
      .replace(/\.+$/, "")
      .split(/\s+/);
    let skipped = 0;
    while (words.length && OPENERS.has(words[0].replace(/[.'’]+$/, ""))) {
      skipped += words.shift().length + 1;
    }
    if (words.length === 0 || (words.length === 1 && MONTHS.has(words[0]))) continue;
    const text = words.join(" ");
    const key = normText(text);
    if (key.length >= 2) out.push({ key, text, at: m.index + skipped, kind: "name" });
  }
  // A name in lower case after "by" ("by verymilkee"), which the capitalised runs miss.
  for (const m of unquoted.matchAll(LOWER_NAME_AFTER_BY)) {
    if (LOWER_WORDS.has(m[1])) continue;
    const key = normText(m[1]);
    if (key.length >= 2) out.push({ key, text: m[1], at: m.index + 3, kind: "name" });
  }
  return out;
}

/** What one sentence states: entities with their roles per relation, years, dates, negation. */
export function analyse(sentence) {
  const unquoted = sentence.replace(QUOTED, (q) => ` ${",".repeat(q.length - 2)} `);
  const relations = [...sentence.matchAll(RELATION)].map(relationOf);
  const clauses = [...unquoted.matchAll(CLAUSE)].map((m) => m.index);
  const relatives = [...unquoted.matchAll(RELATIVE)].map((m) => m.index);
  // Where each relation's object ends: the next verb or clause word.
  for (const [i, r] of relations.entries()) {
    const next = [relations[i + 1]?.at, ...clauses.filter((c) => c >= r.end)].filter(
      (x) => x !== undefined,
    );
    r.stop = next.length ? Math.min(...next) : sentence.length;
  }
  // Segments, for binding a year to its clause: split at every verb and clause word.
  const cuts = [...relations.map((r) => r.at), ...clauses].sort((x, y) => x - y);
  const segmentOf = (at) => cuts.filter((c) => c <= at).length;
  const entities = entitiesIn(sentence).map((e) => ({ ...e, segment: segmentOf(e.at) }));
  const triples = [];
  for (const [i, r] of relations.entries()) {
    const earlierObjects = relations.slice(0, i).map((x) => [x.end, x.stop]);
    // Where the verb's subject can start: after the last relative-clause word before it.
    const start = Math.max(-1, ...relatives.filter((c) => c < r.at));
    for (const e of entities) {
      let side = null;
      if (e.at >= r.end && e.at < r.stop) side = "after";
      else if (
        e.at > start &&
        e.at < r.at &&
        !earlierObjects.some(([from, to]) => e.at >= from && e.at < to)
      ) {
        side = "before";
      }
      if (!side) continue;
      // Active: what comes before the verb uses what comes after it. Passive: the other way.
      const role = (side === "before") !== r.passive ? "user" : "used";
      triples.push({ relation: r.relation, key: e.key, role, side, text: e.text });
    }
  }
  return {
    sentence,
    entities,
    relations,
    triples,
    years: [...sentence.matchAll(YEAR)].map((m) => ({ year: m[1], segment: segmentOf(m.index) })),
    decades: [...sentence.matchAll(DECADE)].map((m) => m[1]),
    dates: datesIn(sentence),
    negated: NEGATION.test(sentence),
  };
}

const hasTriple = (analysed, t) =>
  analysed.triples.some((x) => x.relation === t.relation && x.key === t.key && x.role === t.role);

/** Why one excerpt sentence does not back one claim sentence, or null when it does. */
function mismatch(claim, excerpt) {
  if (excerpt.negated) return "the excerpt sentence is negated or hedged";
  const keys = new Set(excerpt.entities.map((e) => e.key));
  const missing = claim.entities.filter((e) => !keys.has(e.key)).map((e) => e.text);
  if (missing.length) return `entities ${missing.join(", ")}`;
  for (const { year, segment } of claim.years) {
    const own = claim.entities.filter((e) => e.segment === segment).map((e) => e.key);
    const bound = new Set(own.length ? own : claim.entities.map((e) => e.key));
    const ok = excerpt.years.some(
      (y) =>
        y.year === year &&
        excerpt.entities.some((e) => e.segment === y.segment && bound.has(e.key)),
    );
    if (!ok) return `year ${year} with ${[...bound].join(", ")}`;
  }
  for (const d of claim.decades) if (!excerpt.decades.includes(d)) return `decade ${d}s`;
  for (const d of claim.dates) {
    const ok = excerpt.dates.some(
      (x) => x.year === d.year && x.month === d.month && (d.day === null || x.day === d.day),
    );
    if (!ok) return `date ${d.year}-${d.month}${d.day ? `-${d.day}` : ""}`;
  }
  for (const r of claim.relations) {
    if (!excerpt.relations.some((x) => x.relation === r.relation)) {
      return `relation ${r.relation}`;
    }
  }
  for (const t of claim.triples) {
    if (!hasTriple(excerpt, t)) return `${t.text} as ${t.role} in ${t.relation}`;
  }
  return null;
}

/** Why a claim sentence cannot be checked at all, or null. */
function uncheckable(claim) {
  if (claim.negated) return "negated or hedged";
  if (claim.entities.length === 0) return "no entity";
  if (claim.relations.length === 0 && claim.years.length + claim.decades.length === 0) {
    return "no year or relation";
  }
  for (const r of claim.relations) {
    const named = claim.triples.some((t) => t.relation === r.relation && t.side === "after");
    if (!named) return `nothing named after "${r.relation}"`;
  }
  return null;
}

/**
 * The support check of a claim against the excerpts it cites. Returns { supported, missing,
 * checked }: `missing` says, per claim sentence, why no excerpt sentence backs it.
 */
export function checkSupport(text, excerpts) {
  const cited = excerpts.filter((e) => typeof e === "string" && e.trim());
  if (cited.length === 0) return { supported: false, missing: ["no cited excerpt"], checked: 0 };
  const excerptSentences = cited.flatMap(sentences).map(analyse);
  const missing = [];
  let checked = 0;
  for (const sentence of sentences(text)) {
    const claim = analyse(sentence);
    const why = uncheckable(claim);
    if (why) {
      missing.push(`${why}: "${sentence}"`);
      continue;
    }
    checked++;
    const reasons = excerptSentences.map((x) => mismatch(claim, x));
    if (!reasons.includes(null)) {
      missing.push(`no excerpt sentence holds "${sentence}" (${[...new Set(reasons)].join("; ")})`);
    }
  }
  return { supported: missing.length === 0, missing, checked };
}
