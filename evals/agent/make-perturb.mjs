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
// - Negatives are mutations of a positive that its cited excerpts no longer support: another
//   real title or artist, another year, the roles swapped (who samples whom), another relation
//   (sample -> cover), or the claim shown with a real excerpt from another recording.
// Numeric cases ("kind": "numeric"), for the app's numeric check: tempos stated at the measured
// value, at true octave equivalents (x2, x1/2) and at false values (x1.25, x0.8), on each
// recording's measured tempo; and keys stated as the key, its relative key and false keys (a
// whole tone and a tritone away). No committed recording has a measured key (every one was
// withheld by the audio service), so the key cases carry a synthetic key block, marked
// "keySource": "synthetic".

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
    .sort()
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

/** The material mutations draw on: real titles, artists and excerpts of every recording. */
function poolOf(claims) {
  const titles = new Map();
  const artists = new Map();
  const excerpts = new Map();
  for (const c of claims) {
    for (const e of c.evidence) {
      excerpts.set(e.id, { ...e, recording: c.recording });
      for (const t of quotedIn(e.excerpt)) titles.set(`${c.recording}|${t}`, t);
      for (const x of artistsIn(e.excerpt)) artists.set(`${c.recording}|${x}`, x);
    }
  }
  const list = (m) =>
    [...m.entries()]
      .map(([k, value]) => ({ recording: k.split("|")[0], value }))
      .sort((x, y) => `${x.recording}|${x.value}`.localeCompare(`${y.recording}|${y.value}`));
  return {
    titles: list(titles),
    artists: list(artists),
    excerpts: [...excerpts.values()].sort((x, y) => x.id.localeCompare(y.id)),
  };
}

/** The numeric cases of one recording. */
function numericCases(recording, next) {
  const a = recording.analysis;
  const audio = a.audio;
  if (!audio?.gate?.passed || !audio.tempo) return [];
  const context = { title: a.title, artist: a.artist };
  const base = { kind: "numeric", recording: recording.slug, context };
  const tempoAudio = { version: audio.version, gate: audio.gate, tempo: audio.tempo, key: null };
  const m = audio.tempo.bpm;
  const tempo = (bpm) => `The track runs at ${Math.round(bpm)} BPM.`;
  const cases = [
    ["consistent", "not-rejected", m],
    ["equivalent-octave", "not-rejected", m * 2],
    ["equivalent-octave", "not-rejected", m / 2],
    ["false-tempo", "rejected", m * 1.25],
    ["false-tempo", "rejected", m * 0.8],
  ].map(([kind, expect, bpm]) => ({
    ...base,
    case: kind,
    expect,
    claim: { text: tempo(bpm), field: "tempo" },
    audio: tempoAudio,
    keySource: null,
  }));
  const tonic = Math.floor(next() * 12);
  const mode = next() < 0.5 ? "major" : "minor";
  const key = {
    tonic: PITCHES[tonic],
    mode,
    strength: 0.7,
    profile: "synthetic",
    method: "synthetic",
    basis: audio.tempo.basis,
  };
  const keyAudio = { version: audio.version, gate: audio.gate, tempo: null, key };
  const say = (pc, md) => `The track is in ${PITCHES[(pc + 12) % 12]} ${md}.`;
  const relative = mode === "major" ? [tonic + 9, "minor"] : [tonic + 3, "major"];
  for (const [kind, expect, pc, md] of [
    ["consistent", "not-rejected", tonic, mode],
    ["equivalent-relative-key", "not-rejected", ...relative],
    ["false-key", "rejected", tonic + 2, mode],
    ["false-key", "rejected", tonic + 6, mode],
  ]) {
    cases.push({
      ...base,
      case: kind,
      expect,
      claim: { text: say(pc, md), field: "key" },
      audio: keyAudio,
      keySource: "synthetic",
    });
  }
  return cases;
}

/** Every case, in a fixed order with stable ids. */
export function buildPerturb(recordings = readRecordings(), seed = SEED) {
  const next = rng(seed);
  const claims = recordings.flatMap(claimsOf);
  const pool = poolOf(claims);
  const out = [];
  for (const recording of recordings) {
    const mine = claims.filter((c) => c.recording === recording.slug);
    const model = mine.filter((c) => positiveSource(c) === "model-support-check");
    const code = shuffled(
      next,
      mine.filter((c) => positiveSource(c) === "code"),
    ).slice(0, CODE_POSITIVES_PER_RECORDING);
    const positives = [...model, ...code].sort((x, y) => x.claimId.localeCompare(y.claimId));
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
    numericCases(recording, next).forEach((c, i) => {
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
