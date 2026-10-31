#!/usr/bin/env node
// Writes evals/perturb.jsonl, the set the verifier is measured on as a classifier, from the
// committed recordings (fixtures/replays/*.json) at a fixed seed. Running it twice writes the
// same bytes.
//
//   node evals/agent/make-perturb.mjs            write evals/perturb.jsonl
//   node evals/agent/make-perturb.mjs --stdout   print it instead
//
// Claim cases ("kind": "claim"):
// - Positives never come from the judge's verdict: the generator does not read it. A positive is
//   a code-built sourced claim (supported by construction: the app wrote it from the record it
//   cites) or a model claim that passes the deterministic support check (lib/support.mjs: every
//   sentence's titles, years and relation verbs are in the excerpts it cites).
// - Negatives are mutations of a positive that its cited excerpts do not support: another real
//   title or artist (from a MusicBrainz excerpt or another recording's own title and artist),
//   another year, the roles swapped (who samples whom), another relation (sample -> cover), or
//   the claim shown with a real excerpt from another recording. "Unsupported" means unsupported
//   by the cited excerpts, not false in the world.
// Numeric cases ("kind": "numeric"), for the app's numeric check (checkNumbers). Each states the
// exact result the check must give ("expect": consistent, conflict or contradicted), and has a
// category:
// - "equivalent": the measured value restated (exact, within the band, a range around it, a
//   flat spelling of the key, the key with no mode) is consistent; an octave (x2, x1/2, x1/4,
//   x4 when it stays under 400 BPM) or the relative key is a conflict, both values shown;
// - "estimator-error": a value an estimator could have produced instead (x1.5, x2/3, +3 %, the
//   parallel key, a fifth either way) is a conflict;
// - "false-caught": a false value the claim gives as the track's own, against a confident
//   measurement (x1.25, x0.8; a whole tone or a tritone away), is contradicted;
// - "false-shown-both": a false value the check shows next to the measurement instead of
//   rejecting it, by design: the claim is not marked as giving the track's own value, or the
//   measurement is below its estimator's confidence floor.
// Tempo cases use each recording's measured tempo block unchanged ("synthetic": []), except the
// confidence-floor cases, which set its confidence and method ("synthetic": ["tempo.confidence",
// "tempo.method"]). No committed recording has a measured key (the audio service withheld every
// one), so every key case carries a synthetic key block ("synthetic": ["key"], with
// "basis": "synthetic").

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EVALS_DIR, REPO_ROOT } from "./lib/golden.mjs";
import { rng } from "./lib/stats.mjs";
import { checkSupport, containsWords } from "./lib/support.mjs";

export const SEED = 33;
export const RECORDINGS_DIR = join(REPO_ROOT, "fixtures", "replays");
export const PERTURB_PATH = join(EVALS_DIR, "perturb.jsonl");
/** Code-built positives kept per recording (model positives are all kept). */
export const CODE_POSITIVES_PER_RECORDING = 5;
/** Mutations made of each positive. */
export const MUTATIONS_PER_POSITIVE = 2;
export const MUTATIONS = ["artist-or-title", "year", "role", "relation", "irrelevant-excerpt"];

const PITCHES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** The recordings, by file name order. */
export function readRecordings(dir = RECORDINGS_DIR) {
  return readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .sort(byCodePoint)
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")));
}

const pick = (next, xs) => xs[Math.floor(next() * xs.length)];

function shuffled(next, xs) {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const QUOTED = /[“"]([^”"]+)[”"]/g;
const quotedIn = (text) => [...text.matchAll(QUOTED)].map((m) => m[1].replace(/[,.]$/, ""));
const ARTIST_AFTER_BY = /\bby ([^."“”]+?)(?=\.$|\.\s|,|$| feat\.| is | samples | appears )/g;
const artistsIn = (text) => [...text.matchAll(ARTIST_AFTER_BY)].map((m) => m[1].trim());

/** The claims of one recording with their cited excerpts. Verdicts are not copied. */
function claimsOf(recording) {
  const a = recording.analysis;
  const byId = new Map(a.evidence.map((e) => [e.id, e]));
  return a.claims
    .map((c) => ({
      recording: recording.slug,
      claimId: c.id,
      origin: c.origin,
      kind: c.kind,
      about: c.about,
      text: c.text,
      evidence: c.evidenceIds
        .map((id) => byId.get(id))
        .filter(Boolean)
        .map((e) => ({ id: e.id, source: e.source, url: e.url, excerpt: e.excerpt })),
    }))
    .filter((c) => c.evidence.length > 0);
}

/**
 * Whether a claim is a positive, and why. It reads only the claim's origin, kind, text and cited
 * excerpts: never a verdict.
 */
export function positiveSource(claim) {
  if (claim.origin === "code" && claim.kind === "sourced") return "code";
  if (claim.origin === "model") {
    const excerpts = claim.evidence.map((e) => e.excerpt);
    if (checkSupport(claim.text, excerpts).supported) return "model-support-check";
  }
  return null;
}

const ROLE_SWAPS = [
  [/ is sampled in /, " samples "],
  [/ samples /, " is sampled in "],
  [/ is covered by /, " is a cover of "],
  [/ is remixed in /, " is a remix of "],
];
const RELATION_SWAPS = [
  [/ is sampled in /, " is covered by "],
  [/ samples /, " is a cover of "],
  [/\bsampling\b/, "covering"],
  [/ is covered by /, " is sampled in "],
  [/ has been covered by /, " has been sampled by "],
  [/ is remixed in /, " is covered by "],
  [/ as a cover\b/, " as a sample"],
];

/** One mutation of a positive, or null when it does not apply to this claim. */
function mutate(kind, claim, pool, next) {
  const excerpts = claim.evidence.map((e) => e.excerpt);
  const joined = excerpts.join("\n");
  if (kind === "artist-or-title") {
    const titles = quotedIn(claim.text).filter((t) => containsWords(joined, t));
    const artists = artistsIn(joined).filter((x) => containsWords(claim.text, x));
    const options = [...titles.map((t) => ["title", t]), ...artists.map((x) => ["artist", x])];
    if (options.length === 0) return null;
    const [type, from] = pick(next, options);
    const replacements = (type === "title" ? pool.titles : pool.artists).filter(
      (r) => r.recording !== claim.recording && !containsWords(joined, r.value),
    );
    if (replacements.length === 0) return null;
    const to = pick(next, replacements).value;
    const at = claim.text.indexOf(from);
    if (at < 0) return null;
    return { text: claim.text.slice(0, at) + to + claim.text.slice(at + from.length) };
  }
  if (kind === "year") {
    const years = [...claim.text.matchAll(/\b(19\d{2}|20\d{2})\b/g)].map((m) => m[1]);
    if (years.length === 0) return null;
    const from = pick(next, years);
    for (let tries = 0; tries < 20; tries++) {
      const shift = 1 + Math.floor(next() * 9);
      const to = String(Number(from) + (next() < 0.5 ? -shift : shift));
      if (!joined.includes(to)) return { text: claim.text.replaceAll(from, to) };
    }
    return null;
  }
  if (kind === "role" || kind === "relation") {
    for (const [re, to] of kind === "role" ? ROLE_SWAPS : RELATION_SWAPS) {
      // Role: "A samples B" becomes "A is sampled in B" (B now uses A), and back.
      if (re.test(claim.text)) return { text: claim.text.replace(re, to) };
    }
    return null;
  }
  if (kind === "irrelevant-excerpt") {
    const titles = quotedIn(claim.text);
    const others = pool.excerpts.filter(
      (e) =>
        e.recording !== claim.recording &&
        !titles.some((t) => containsWords(e.excerpt, t)) &&
        !containsWords(e.excerpt, claim.text),
    );
    if (others.length === 0) return null;
    const e = pick(next, others);
    return {
      text: claim.text,
      evidence: [{ id: e.id, source: e.source, url: e.url, excerpt: e.excerpt }],
    };
  }
  throw new Error(`unknown mutation ${kind}`);
}

/** Code-point order, the same in every locale (localeCompare is not). */
export const byCodePoint = (x, y) => (x < y ? -1 : x > y ? 1 : 0);

/**
 * The material mutations draw on: real titles and artists from MusicBrainz excerpts and from
 * each recording's own title and artist, and every recording's excerpts.
 */
function poolOf(claims, recordings) {
  const titles = new Map();
  const artists = new Map();
  const excerpts = new Map();
  for (const r of recordings) {
    titles.set(`${r.slug}|${r.analysis.title}`, r.analysis.title);
    artists.set(`${r.slug}|${r.analysis.artist}`, r.analysis.artist);
  }
  for (const c of claims) {
    for (const e of c.evidence) {
      excerpts.set(e.id, { ...e, recording: c.recording });
      if (e.source !== "musicbrainz") continue;
      for (const t of quotedIn(e.excerpt)) titles.set(`${c.recording}|${t}`, t);
      for (const x of artistsIn(e.excerpt)) artists.set(`${c.recording}|${x}`, x);
    }
  }
  const list = (m) =>
    [...m.entries()]
      .map(([k, value]) => ({ key: k, recording: k.split("|")[0], value }))
      .sort((x, y) => byCodePoint(x.key, y.key))
      .map(({ recording, value }) => ({ recording, value }));
  return {
    titles: list(titles),
    artists: list(artists),
    excerpts: [...excerpts.values()].sort((x, y) => byCodePoint(x.id, y.id)),
  };
}

const FLATS = { "C#": "Db", "D#": "Eb", "F#": "Gb", "G#": "Ab", "A#": "Bb" };
const SHARP_TONICS = Object.keys(FLATS);
const round1 = (x) => Math.round(x * 10) / 10;
const other = (mode) => (mode === "major" ? "minor" : "major");

/**
 * The numeric cases of one recording, each with its exact expected result. `first` adds the
 * confidence-floor cases, which are about the floors, not the recording, so are made once.
 */
function numericCases(recording, next, first) {
  const a = recording.analysis;
  const audio = a.audio;
  if (!audio?.gate?.passed || !audio.tempo) return [];
  const context = { title: a.title, artist: a.artist };
  const base = { kind: "numeric", recording: recording.slug, context };
  const block = (tempo, key) => ({ version: audio.version, gate: audio.gate, tempo, key });
  const m = audio.tempo.bpm;
  const band = Math.max(2, 0.02 * m);
  const bpm = (x) => `The track runs at ${round1(x)} BPM.`;
  const cases = [];
  const add = (category, name, expect, text, field, audioBlock, synthetic) =>
    cases.push({
      ...base,
      category,
      case: name,
      expect,
      claim: { text, field },
      audio: audioBlock,
      synthetic,
    });
  const measured = block(audio.tempo, null);
  const tempo = (category, name, expect, text, field = "tempo") =>
    add(category, name, expect, text, field, measured, []);
  tempo("equivalent", "tempo-measured", "consistent", bpm(m));
  tempo("equivalent", "tempo-within-band", "consistent", bpm(m + 0.75 * band));
  tempo(
    "equivalent",
    "tempo-range-around",
    "consistent",
    `The track runs between ${Math.floor(m - 4)} and ${Math.ceil(m + 4)} BPM.`,
  );
  tempo("equivalent", "tempo-octave-x2", "conflict", bpm(m * 2));
  tempo("equivalent", "tempo-octave-x0.5", "conflict", bpm(m / 2));
  tempo("equivalent", "tempo-octave-x0.25", "conflict", bpm(m / 4));
  if (m * 4 < 400) tempo("equivalent", "tempo-octave-x4", "conflict", bpm(m * 4));
  tempo("estimator-error", "tempo-x1.5", "conflict", bpm(m * 1.5));
  tempo("estimator-error", "tempo-x2/3", "conflict", bpm((m * 2) / 3));
  tempo("estimator-error", "tempo-plus-3-percent", "conflict", bpm(m * 1.03));
  tempo("false-caught", "tempo-x1.25", "contradicted", bpm(m * 1.25));
  tempo("false-caught", "tempo-x0.8", "contradicted", bpm(m * 0.8));
  tempo("false-shown-both", "tempo-x1.25-unmarked", "conflict", bpm(m * 1.25), null);
  if (first) {
    const floor = [
      // The librosa floor is 0.3, Essentia's 1.5/5.32 (0.282); an unknown method takes the higher.
      [
        "false-shown-both",
        "tempo-librosa-below-floor",
        "conflict",
        "librosa.beat.beat_track",
        0.29,
      ],
      ["false-caught", "tempo-librosa-at-floor", "contradicted", "librosa.beat.beat_track", 0.3],
      ["false-caught", "tempo-essentia-above-floor", "contradicted", audio.tempo.method, 0.29],
      ["false-shown-both", "tempo-essentia-below-floor", "conflict", audio.tempo.method, 0.28],
      ["false-shown-both", "tempo-unknown-method-below-floor", "conflict", "synthetic", 0.29],
      ["false-shown-both", "tempo-no-confidence", "conflict", audio.tempo.method, null],
    ];
    for (const [category, name, expect, method, confidence] of floor) {
      const changed = block({ ...audio.tempo, method, confidence }, null);
      add(category, name, expect, bpm(m * 1.25), "tempo", changed, [
        "tempo.confidence",
        "tempo.method",
      ]);
    }
  }
  // A synthetic key with a sharp tonic, so a flat spelling exists.
  const tonic = PITCHES.indexOf(SHARP_TONICS[Math.floor(next() * SHARP_TONICS.length)]);
  const mode = next() < 0.5 ? "major" : "minor";
  const keyBlock = (strength) =>
    block(null, {
      tonic: PITCHES[tonic],
      mode,
      strength,
      profile: "synthetic",
      method: "synthetic",
      basis: "synthetic",
    });
  const confident = keyBlock(0.7);
  const name = (pc) => PITCHES[(pc + 12) % 12];
  const say = (pc, md) => `The track is in ${name(pc)} ${md}.`;
  const key = (category, caseName, expect, text, field = "key", audioBlock = confident) =>
    add(category, caseName, expect, text, field, audioBlock, ["key"]);
  key("equivalent", "key-measured", "consistent", say(tonic, mode));
  key(
    "equivalent",
    "key-flat-spelling",
    "consistent",
    `The track is in ${FLATS[PITCHES[tonic]]} ${mode}.`,
  );
  key("equivalent", "key-no-mode", "consistent", `The track is in the key of ${name(tonic)}.`);
  key(
    "equivalent",
    "key-relative",
    "conflict",
    say(tonic + (mode === "major" ? 9 : 3), other(mode)),
  );
  key("estimator-error", "key-parallel", "conflict", say(tonic, other(mode)));
  key("estimator-error", "key-fifth-up", "conflict", say(tonic + 7, mode));
  key("estimator-error", "key-fourth-up-other-mode", "conflict", say(tonic + 5, other(mode)));
  key("false-caught", "key-whole-tone", "contradicted", say(tonic + 2, mode));
  key("false-caught", "key-tritone", "contradicted", say(tonic + 6, mode));
  key("false-shown-both", "key-whole-tone-unmarked", "conflict", say(tonic + 2, mode), null);
  key(
    "false-shown-both",
    "key-whole-tone-weak",
    "conflict",
    say(tonic + 2, mode),
    "key",
    keyBlock(0.3),
  );
  if (first) {
    key(
      "false-caught",
      "key-whole-tone-at-floor",
      "contradicted",
      say(tonic + 2, mode),
      "key",
      keyBlock(0.4),
    );
    key(
      "false-shown-both",
      "key-whole-tone-no-strength",
      "conflict",
      say(tonic + 2, mode),
      "key",
      keyBlock(null),
    );
  }
  return cases;
}

/** Every case, in a fixed order with stable ids. */
export function buildPerturb(recordings = readRecordings(), seed = SEED) {
  const next = rng(seed);
  const claims = recordings.flatMap(claimsOf);
  const pool = poolOf(claims, recordings);
  const out = [];
  for (const recording of recordings) {
    const mine = claims.filter((c) => c.recording === recording.slug);
    const model = mine.filter((c) => positiveSource(c) === "model-support-check");
    const code = shuffled(
      next,
      mine.filter((c) => positiveSource(c) === "code"),
    ).slice(0, CODE_POSITIVES_PER_RECORDING);
    const positives = [...model, ...code].sort((x, y) => byCodePoint(x.claimId, y.claimId));
    for (const p of positives) {
      const id = `${recording.slug}:${p.claimId.slice(0, 8)}`;
      const shown = {
        recording: p.recording,
        claim: { text: p.text, about: p.about, kind: p.kind, origin: p.origin },
        evidence: p.evidence,
      };
      out.push({
        id,
        kind: "claim",
        label: "supported",
        positiveSource: positiveSource(p),
        mutation: null,
        parentId: null,
        ...shown,
      });
      let made = 0;
      for (const kind of shuffled(next, MUTATIONS)) {
        if (made === MUTATIONS_PER_POSITIVE) break;
        const m = mutate(kind, p, pool, next);
        if (!m || (m.text === p.text && !m.evidence)) continue;
        made++;
        out.push({
          id: `${id}:${kind}`,
          kind: "claim",
          label: "unsupported",
          positiveSource: null,
          mutation: kind,
          parentId: id,
          recording: p.recording,
          claim: { ...shown.claim, text: m.text },
          evidence: m.evidence ?? p.evidence,
        });
      }
    }
    numericCases(recording, next, recording === recordings[0]).forEach((c, i) => {
      out.push({ id: `${recording.slug}:numeric-${String(i + 1).padStart(2, "0")}`, ...c });
    });
  }
  return out;
}

export const serialise = (cases) =>
  cases
    .map((c) => JSON.stringify(c))
    .join("\n")
    .concat("\n");

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const text = serialise(buildPerturb());
  if (process.argv.includes("--stdout")) process.stdout.write(text);
  else {
    writeFileSync(PERTURB_PATH, text);
    console.log(`wrote evals/perturb.jsonl (${text.trimEnd().split("\n").length} cases)`);
  }
}
