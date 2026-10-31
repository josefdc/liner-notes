// The deterministic support check: does the excerpt a claim cites contain what the claim says?
// It never reads a judge's verdict. A claim passes when every sentence states at least one
// checkable item and every checkable item is found in the cited excerpts:
// - a quoted title ("…", “…”), compared after normalisation (case, accents, punctuation);
// - a name outside quotes: a run of capitalised words ("Coldplay", "Richard Ashcroft", "Jay-Z's"
//   without its "'s"), leaving out the words that open a sentence ("The", "This"…), month names
//   (a date is checked by its year) and the names of the sources themselves ("MusicBrainz");
// - a year (four digits from 1900 to 2099);
// - a relation verb (samples/sampled, covers/covered, remixes/remixed, interpolates…), compared
//   by relation, so "remixes" is found in "is remixed in".
// A sentence with nothing checkable fails the claim: a claim that adds unchecked material ("the
// source describes the arrangement as …") is not taken as supported.

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
const YEAR = /\b(19\d{2}|20\d{2})\b/g;
const RELATION_WORDS = [
  ["sample", /\b(?:samples|sampled|sampling)\b/i],
  ["cover", /\b(?:covers|covered|a cover of)\b/i],
  ["remix", /\b(?:remixes|remixed|a remix of)\b/i],
  ["interpolation", /\b(?:interpolates|interpolated|interpolating)\b/i],
];

/** The relations a text states with a verb ("samples", "is covered by"…). */
export function relationsIn(text) {
  return RELATION_WORDS.filter(([, re]) => re.test(text)).map(([name]) => name);
}

/** Sentences, split after . ! ? when a capital letter, a digit or a quote follows. */
export function sentences(text) {
  return String(text)
    .split(/(?<=[.!?][”"’)]?)\s+(?=[A-Z0-9“"‘(])/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

const NOT_NAMES = new Set(
  (
    "The This That These Those It Its A An In On At Of And Also Both " +
    "MusicBrainz Wikipedia Discogs Genius Spotify Deezer WhoSampled " +
    "January February March April May June July August September October November December"
  ).split(" "),
);
const NAME_RUN = /\p{Lu}[\p{L}\p{N}.'’-]*(?:\s+(?:&\s+)?\p{Lu}[\p{L}\p{N}.'’-]*)*/gu;

/** Names outside quotes: runs of capitalised words, without sentence openers and months. */
export function namesIn(sentence) {
  // A quoted title breaks a run of names: "Jay-Z’s “A Dream,” RBX’s" holds two names.
  const unquoted = sentence.replace(QUOTED, " , ");
  const names = [];
  for (const m of unquoted.matchAll(NAME_RUN)) {
    const words = m[0]
      .replace(/['’]s\b/g, "")
      .replace(/\.$/, "")
      .split(/\s+/)
      .filter((w) => !NOT_NAMES.has(w.replace(/[.'’]+$/, "")));
    const name = words.join(" ").replace(/^&\s*|\s*&$/g, "");
    if (normText(name)) names.push(name);
  }
  return names;
}

/** The checkable items of one sentence. */
export function items(sentence) {
  const quoted = [...sentence.matchAll(QUOTED)].map((m) => m[1]).filter((q) => normText(q));
  const years = [...sentence.matchAll(YEAR)].map((m) => m[1]);
  return { quoted, names: namesIn(sentence), years, relations: relationsIn(sentence) };
}

/**
 * The support check of a claim against the excerpts it cites. Returns { supported, missing,
 * checked }: `missing` lists every item not found (or the sentences with nothing to check).
 */
export function checkSupport(text, excerpts) {
  const cited = excerpts.filter((e) => typeof e === "string" && e.trim());
  if (cited.length === 0) return { supported: false, missing: ["no cited excerpt"], checked: 0 };
  const joined = cited.join("\n");
  const citedRelations = new Set(relationsIn(joined));
  const missing = [];
  let checked = 0;
  for (const sentence of sentences(text)) {
    const found = items(sentence);
    const count =
      found.quoted.length + found.names.length + found.years.length + found.relations.length;
    if (count === 0) {
      missing.push(`nothing checkable in "${sentence}"`);
      continue;
    }
    checked += count;
    for (const q of found.quoted) {
      if (!cited.some((e) => containsWords(e, q))) missing.push(`title "${q}"`);
    }
    for (const name of found.names) {
      if (!cited.some((e) => containsWords(e, name))) missing.push(`name ${name}`);
    }
    for (const y of found.years) if (!joined.includes(y)) missing.push(`year ${y}`);
    for (const r of found.relations) if (!citedRelations.has(r)) missing.push(`relation ${r}`);
  }
  return { supported: missing.length === 0, missing, checked };
}
