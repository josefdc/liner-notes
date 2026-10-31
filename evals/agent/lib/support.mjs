// The deterministic support check: does an excerpt a claim cites state what the claim says?
// It never reads a judge's verdict, and it errs towards "not supported".
//
// Each sentence of the claim must:
// - name at least one entity (a quoted title, or a name: a run of capitalised words outside
//   quotes, without a leading article, sentence opener, month or source name), and state a
//   year, a decade or a relation (sample, cover, remix, interpolation);
// - with a relation, name an entity after its verb ("Juicy samples a drum break" names nothing
//   it samples);
// - carry no negation ("never", "not", "n't", "disputed"…).
// Then one sentence of one cited excerpt, itself not negated, must hold all of it at once:
// - every entity as a whole entity: it equals a quoted title or a name there ("Fruit" is not
//   "Juicy Fruit");
// - every year as a standalone token, not inside an ISRC or "AR2005-11"; a decade ("1960s")
//   matches only a decade;
// - the same relation, with every entity in the same role: "A samples B" and "B is sampled in
//   A" agree, "B samples A" does not.

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
  /\b(?:not|never|no|neither|nor|without|denied|denies|disputed|unconfirmed|unproven|allegedly|reportedly)\b|n['’]t\b/i;
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

/** What one sentence states: entities with their roles, years, decades, relation, negation. */
export function analyse(sentence) {
  const first = [...sentence.matchAll(RELATION)][0];
  const relation = first ? relationOf(first) : null;
  const side = (e) =>
    !relation ? null : e.at < relation.at ? "before" : e.at >= relation.end ? "after" : null;
  const entities = entitiesIn(sentence).map((e) => {
    const s = side(e);
    // Active: what comes before the verb uses what comes after it. Passive: the other way.
    const role = s === null ? null : (s === "before") !== relation.passive ? "user" : "used";
    return { ...e, side: s, role };
  });
  return {
    sentence,
    entities,
    years: [...sentence.matchAll(YEAR)].map((m) => m[1]),
    decades: [...sentence.matchAll(DECADE)].map((m) => m[1]),
    relation,
    negated: NEGATION.test(sentence),
  };
}

const rolesOf = (analysed, key) =>
  new Set(analysed.entities.filter((e) => e.key === key && e.role).map((e) => e.role));

/** Why one excerpt sentence does not back one claim sentence, or null when it does. */
function mismatch(claim, excerpt) {
  if (excerpt.negated) return "the excerpt sentence is negated";
  const keys = new Set(excerpt.entities.map((e) => e.key));
  const missing = claim.entities.filter((e) => !keys.has(e.key)).map((e) => e.text);
  if (missing.length) return `entities ${missing.join(", ")}`;
  for (const y of claim.years) if (!excerpt.years.includes(y)) return `year ${y}`;
  for (const d of claim.decades) if (!excerpt.decades.includes(d)) return `decade ${d}s`;
  if (claim.relation) {
    if (excerpt.relation?.relation !== claim.relation.relation) {
      return `relation ${claim.relation.relation}`;
    }
    for (const e of claim.entities) {
      if (e.role && !rolesOf(excerpt, e.key).has(e.role)) return `the role of ${e.text}`;
    }
  }
  return null;
}

/** Why a claim sentence cannot be checked at all, or null. */
function uncheckable(claim) {
  if (claim.negated) return "negated";
  if (claim.entities.length === 0) return "no entity";
  if (!claim.relation && claim.years.length + claim.decades.length === 0) {
    return "no year or relation";
  }
  if (claim.relation && !claim.entities.some((e) => e.side === "after")) {
    return `nothing named after "${claim.relation.relation}"`;
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
