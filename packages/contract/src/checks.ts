/**
 * Producer-side checks, and how readers show what they received.
 *
 * Readers are tolerant: a cross-reference violation or an unknown value never rejects a result
 * (see tolerant.ts). The rules that relate parts of a result to each other are checked here
 * instead, by the code that builds a result, before it is sent or stored. Each function returns
 * one message per problem, prefixed with the path of the offending value; an empty list means
 * the value may be emitted. The `*DisplayKind` functions are the reader side: how to show a
 * claim or link whatever the producer did.
 */

import {
  AUDIO_MEASURED_BLOCKS,
  type AudioFeatures,
  type ModelScore,
  type MusicalKey,
} from "./audio.js";
import {
  type Claim,
  type ClaimField,
  type ClaimKind,
  type ClaimScope,
  EVIDENCE_EXCERPT_MAX,
  type Evidence,
} from "./evidence.js";
import {
  FACTOID_LIMITS,
  type GenealogyLink,
  type LinkKind,
  type RunInfo,
  type TrackAnalysis,
} from "./track.js";

const at = (path: string, message: string) => (path ? `${path}: ${message}` : message);

/**
 * What a claim or link is checked and shown against: the evidence pack, the measurement and
 * the result's claims (by id; the first claim with each id). Without `claims`, no model link
 * can read as sourced.
 */
export interface ResultContext {
  evidenceIds: ReadonlySet<string>;
  audio: AudioFeatures | null | undefined;
  claims?: ReadonlyMap<string, Claim>;
}

/** The context of a result, for `claimDisplayKind` and `linkDisplayKind`. */
export function resultContext(analysis: TrackAnalysis): ResultContext {
  const claims = new Map<string, Claim>();
  for (const claim of analysis.claims ?? []) if (!claims.has(claim.id)) claims.set(claim.id, claim);
  return {
    evidenceIds: new Set((analysis.evidence ?? []).map((item) => item.id)),
    audio: analysis.audio,
    claims,
  };
}

/** True when the measurement passed its gate (it may still lack some blocks). */
export const measuredAudio = (audio: AudioFeatures | null | undefined): audio is AudioFeatures =>
  audio?.gate.passed === true;

/** The measured block a claim field points at, or null when that was not measured. */
function measuredBlock(audio: AudioFeatures | null | undefined, field: ClaimField | undefined) {
  if (!measuredAudio(audio) || field === undefined) return null;
  return audio[field];
}

/** How the measured key is written in the `key` copy of a result, e.g. "A# Minor". */
export function measuredKeyLabel(key: MusicalKey): string {
  return `${key.tonic} ${key.mode === "major" ? "Major" : "Minor"}`;
}

// =============================================================================
// Evidence and audio
// =============================================================================

/**
 * An evidence item names its record (a url or a record reference), keeps a short excerpt, and
 * a web search result is never presented as a primary record.
 */
export function evidenceIssues(evidence: Evidence, path = ""): string[] {
  const issues: string[] = [];
  if (evidence.url === null && evidence.recordRef === null) {
    issues.push(at(path, "needs a url or a recordRef"));
  }
  if (evidence.excerpt.length > EVIDENCE_EXCERPT_MAX) {
    issues.push(at(`${path}.excerpt`, `longer than ${EVIDENCE_EXCERPT_MAX} characters`));
  }
  if (evidence.source === "tavily" && evidence.sourceTier === "primary-record") {
    issues.push(at(`${path}.sourceTier`, "a web search result is not a primary record"));
  }
  return issues;
}

function modelScoreIssues(score: ModelScore | null, path: string): string[] {
  if (!score) return [];
  const [low, high] = score.range;
  if (!Number.isFinite(score.value) || !Number.isFinite(low) || !Number.isFinite(high)) {
    return [at(path, "not a finite number")];
  }
  if (low > high) return [at(`${path}.range`, "minimum above maximum")];
  if (score.value < low || score.value > high) {
    return [at(`${path}.value`, `${score.value} outside its range [${low}, ${high}]`)];
  }
  return [];
}

/**
 * A gate that did not pass has a reason and measures nothing (no tempo, no "C major" for
 * silence); a gate that passed has no reason. Measured numbers are finite, and every model
 * score lies within the range its model produces.
 */
export function audioFeaturesIssues(audio: AudioFeatures, path = "audio"): string[] {
  const issues: string[] = [];
  if (audio.gate.passed) {
    if (audio.gate.reason !== null) issues.push(at(`${path}.gate.reason`, "set on a passed gate"));
  } else {
    if (audio.gate.reason === null) issues.push(at(`${path}.gate.reason`, "missing"));
    for (const block of AUDIO_MEASURED_BLOCKS) {
      if (audio[block] !== null) issues.push(at(`${path}.${block}`, "must be null when gated"));
    }
    if (audio.keyMoments.length > 0) {
      issues.push(at(`${path}.keyMoments`, "must be empty when gated"));
    }
  }
  const finite: Array<[string, number | null | undefined]> = [
    ["tempo.bpm", audio.tempo?.bpm],
    ["tempo.confidence", audio.tempo?.confidence],
    ["key.strength", audio.key?.strength],
    ["loudness.rmsMean", audio.loudness?.rmsMean],
  ];
  for (const [field, value] of finite) {
    if (value != null && !Number.isFinite(value)) {
      issues.push(at(`${path}.${field}`, "not a finite number"));
    }
  }
  const moods = audio.fingerprint?.moods;
  if (moods) {
    for (const head of [
      "danceability",
      "acoustic",
      "instrumental",
      "valence",
      "arousal",
    ] as const) {
      issues.push(...modelScoreIssues(moods[head], `${path}.fingerprint.moods.${head}`));
    }
  }
  return issues;
}

// =============================================================================
// Claims and links
// =============================================================================

/**
 * True for a claim the verifier rejected: the judge found it contradicted by its cited
 * excerpts (`verdict`), or the numeric check found its number contradicted by the measurement
 * (`numericCheck`). A rejected claim is shown only in the rejected panel, with why, whatever
 * its kind and whoever wrote it (code or model), and a model link that states it never reads
 * as sourced (`linkDisplayKind`). A numeric `conflict` is not a rejection. It takes any object, read by the contract
 * or not, so a reader can keep a rejected claim it cannot read out of the main view too.
 */
export function claimIsRejected(claim: { verdict?: unknown; numericCheck?: unknown }): boolean {
  return claim.verdict === "contradicted" || claim.numericCheck === "contradicted";
}

/** The claim scope a primary record's recordRef carries (its first path segment), or null. */
const RECORD_SCOPES: Readonly<Record<string, ClaimScope>> = {
  track: "recording",
  work: "work",
  release: "release",
};

/**
 * Whether an evidence item may support a claim of the given scope (a claim without one is
 * read as a claim about this recording). A primary record supports only claims of its own
 * scope: a `track/` record a recording claim, a `work/` record a claim about the song, a
 * `release/` record a claim about a whole release. So a release-wide credit or the album a
 * recording appears on never supports a claim about this recording, and another artist's cover
 * of the song never does either. A primary record without a scope the contract knows supports
 * nothing. An item that is not a primary record (a web page, an article) names no record and
 * so no scope: it may support a claim of any scope, and whether its excerpt does is the judge's
 * call.
 */
export function scopeSupports(
  claimScope: ClaimScope | null | undefined,
  evidence: Pick<Evidence, "sourceTier" | "recordRef">,
): boolean {
  if (evidence.sourceTier !== "primary-record") return true;
  const prefix = evidence.recordRef?.split("/", 1)[0] ?? "";
  const recordScope = Object.hasOwn(RECORD_SCOPES, prefix) ? RECORD_SCOPES[prefix] : null;
  return recordScope === (claimScope ?? "recording");
}

/**
 * A measured claim comes from code, names its field, and that field was measured (a passed
 * gate and a non-null block). A sourced claim cites at least one item of the evidence pack,
 * and every id it cites is in the pack; a model-written sourced claim also needs a supported
 * or partial verdict. A code-built claim (from a source record) is supported by construction:
 * the judge may disagree, and its verdict is kept for the record.
 */
export function claimIssues(claim: Claim, context: ResultContext, path = ""): string[] {
  const issues: string[] = [];
  if (claim.kind === "measured") {
    if (claim.origin !== "code")
      issues.push(at(`${path}.origin`, "measured claims come from code"));
    if (claim.field === undefined) {
      issues.push(at(`${path}.field`, "a measured claim names the field it reports"));
    } else if (measuredBlock(context.audio, claim.field) === null) {
      issues.push(at(`${path}.field`, `${claim.field} was not measured`));
    }
    return issues;
  }
  if (claim.kind !== "sourced") return issues;
  if (claim.evidenceIds.length === 0) issues.push(at(`${path}.evidenceIds`, "cites nothing"));
  for (const id of claim.evidenceIds) {
    if (!context.evidenceIds.has(id)) {
      issues.push(at(`${path}.evidenceIds`, `cites "${id}", which is not in the evidence pack`));
    }
  }
  if (claim.origin === "model" && claim.verdict !== "supported" && claim.verdict !== "partial") {
    issues.push(at(`${path}.verdict`, "a model claim is sourced only when supported or partial"));
  }
  return issues;
}

const citesOnlyKnown = (ids: readonly string[], context: ResultContext) =>
  ids.length > 0 && ids.every((id) => context.evidenceIds.has(id));

/**
 * How a reader shows a claim. A measured claim reads as measured only when code wrote it and
 * its field was measured. A sourced claim that cites nothing, cites evidence missing from the
 * pack, or is a model claim the judge did not support reads as model inference. Everything
 * else keeps its kind. Where it is shown is a separate rule: a rejected claim
 * (`claimIsRejected`) appears only in the rejected panel, with the kind this function gives.
 */
export function claimDisplayKind(claim: Claim, context: ResultContext): ClaimKind {
  if (claim.kind === "measured") {
    const measured = claim.origin === "code" && measuredBlock(context.audio, claim.field) !== null;
    return measured ? "measured" : "inferred";
  }
  if (claim.kind !== "sourced") return claim.kind;
  const judged =
    claim.origin === "code" || claim.verdict === "supported" || claim.verdict === "partial";
  return citesOnlyKnown(claim.evidenceIds, context) && judged ? "sourced" : "inferred";
}

/**
 * True when a model-written link has a claim (`claimId`) in the context that is not rejected
 * and reads as sourced: only the verifier's support makes a model link sourced, never citing.
 */
function modelLinkSupported(link: GenealogyLink, context: ResultContext): boolean {
  const claim = link.claimId === undefined ? undefined : context.claims?.get(link.claimId);
  return (
    claim !== undefined && !claimIsRejected(claim) && claimDisplayKind(claim, context) === "sourced"
  );
}

/**
 * A sourced link cites at least one evidence item, and every id a link cites is in the pack. A
 * sourced link the model wrote also states a claim (`claimId`) that is not rejected and reads
 * as sourced (`claimDisplayKind`).
 */
export function linkIssues(link: GenealogyLink, context: ResultContext, path = ""): string[] {
  const issues: string[] = [];
  const ids = link.evidenceIds ?? [];
  if (link.kind === "sourced" && ids.length === 0) {
    issues.push(at(`${path}.evidenceIds`, "a sourced link cites nothing"));
  }
  if (link.kind === "sourced" && link.origin === "model" && !modelLinkSupported(link, context)) {
    issues.push(at(`${path}.kind`, "model link marked sourced without a supported claim"));
  }
  for (const id of ids) {
    if (!context.evidenceIds.has(id)) {
      issues.push(at(`${path}.evidenceIds`, `cites "${id}", not in the pack`));
    }
  }
  return issues;
}

/**
 * How a reader shows a link: sourced only when it says so and cites evidence that is all in
 * the pack, and, when the model wrote it (`origin: "model"`), its claim (`claimId`) is in the
 * context's claims, is not rejected (`claimIsRejected`) and reads as sourced
 * (`claimDisplayKind`): citing is not support, the verifier's verdict is. Otherwise (no kind,
 * no citation, an unknown citation, no supported claim) a model inference. A sample link shown
 * as inferred is an inferred influence, not a documented sample.
 */
export function linkDisplayKind(link: GenealogyLink, context: ResultContext): LinkKind {
  if (link.kind !== "sourced" || !citesOnlyKnown(link.evidenceIds ?? [], context)) {
    return "inferred";
  }
  if (link.origin === "model" && !modelLinkSupported(link, context)) return "inferred";
  return "sourced";
}

// =============================================================================
// Measured copies
// =============================================================================

/** The copies of the measurement at the top of a result, as the web app displays them. */
const COPIES = ["bpm", "key", "energy", "valence", "danceability", "acousticness"] as const;

/** The measured value each copy is taken from; a copy is set only when its source is. */
function copySource(audio: AudioFeatures, copy: (typeof COPIES)[number]): unknown {
  const moods = audio.fingerprint?.moods;
  switch (copy) {
    case "bpm":
      return audio.tempo;
    case "key":
      return audio.key;
    case "energy":
      return audio.loudness;
    case "valence":
      return moods?.valence ?? null;
    case "danceability":
      return moods?.danceability ?? null;
    case "acousticness":
      return moods?.acoustic ?? null;
  }
}

/**
 * The measured copies at the top of a result (bpm, key, energy, valence, danceability,
 * acousticness, keyMoments, audioSource, audioConfidence, segmentsSource) agree with `audio`:
 * - with no measurement, or a gate that did not pass: every copy is null or absent, no key
 *   moments, audioSource is not "analyzed", audioConfidence is not "high" and segments are not
 *   "measured";
 * - with a passed gate: each copy is set only when the value it is taken from was measured
 *   (energy from loudness; valence, danceability and acousticness from their mood heads).
 *   `bpm` is `audio.tempo.bpm` as measured or rounded to the nearest integer (the rounding the
 *   first service version applied), and null without a tempo. `key` is null exactly when
 *   `audio.key` is, and otherwise names the same tonic and mode (`measuredKeyLabel`, case
 *   ignored). `keyMoments`, when present, equal `audio.keyMoments`. audioSource "analyzed"
 *   needs a tempo and a key; audioConfidence "high" needs audioSource "analyzed"; "measured"
 *   segments need `audio.sections`.
 */
export function measuredCopyIssues(analysis: TrackAnalysis): string[] {
  const issues: string[] = [];
  const audio = analysis.audio;

  if (!measuredAudio(audio)) {
    for (const copy of COPIES) {
      if (analysis[copy] != null) issues.push(at(copy, "set although nothing was measured"));
    }
    if ((analysis.keyMoments ?? []).length > 0) {
      issues.push(at("keyMoments", "set although nothing was measured"));
    }
    if (analysis.audioSource === "analyzed") {
      issues.push(at("audioSource", '"analyzed" although nothing was measured'));
    }
    if (analysis.audioConfidence === "high") {
      issues.push(at("audioConfidence", '"high" although nothing was measured'));
    }
    if (analysis.segmentsSource === "measured") {
      issues.push(at("segmentsSource", '"measured" although nothing was measured'));
    }
    return issues;
  }

  for (const copy of COPIES) {
    if (analysis[copy] != null && copySource(audio, copy) === null) {
      issues.push(at(copy, "set although its value was not measured"));
    }
  }
  const tempo = audio.tempo?.bpm;
  if (tempo !== undefined) {
    if (analysis.bpm == null) {
      issues.push(at("bpm", "missing although the tempo was measured"));
    } else if (analysis.bpm !== tempo && analysis.bpm !== Math.round(tempo)) {
      issues.push(at("bpm", `${analysis.bpm} differs from the measured ${tempo}`));
    }
  }
  if (audio.key) {
    const label = measuredKeyLabel(audio.key);
    if (analysis.key == null) {
      issues.push(at("key", "missing although the key was measured"));
    } else if (analysis.key.toLowerCase() !== label.toLowerCase()) {
      issues.push(at("key", `"${analysis.key}" differs from the measured "${label}"`));
    }
  }
  if (
    analysis.keyMoments !== undefined &&
    JSON.stringify(analysis.keyMoments) !== JSON.stringify(audio.keyMoments)
  ) {
    issues.push(at("keyMoments", "differ from the measured key moments"));
  }
  if (analysis.audioSource === "analyzed" && (!audio.tempo || !audio.key)) {
    issues.push(at("audioSource", '"analyzed" needs a measured tempo and key'));
  }
  if (analysis.audioConfidence === "high" && analysis.audioSource !== "analyzed") {
    issues.push(at("audioConfidence", '"high" needs audioSource "analyzed"'));
  }
  if (analysis.segmentsSource === "measured" && !audio.sections) {
    issues.push(at("segmentsSource", '"measured" needs measured sections'));
  }
  return issues;
}

// =============================================================================
// Runs and results
// =============================================================================

/**
 * A replayed run says when it was recorded and from which commit; a live run carries neither.
 * A replay's analyzerVersion is null only when nothing was measured, and otherwise matches the
 * measurement's.
 */
export function runIssues(
  run: RunInfo,
  audio: AudioFeatures | null | undefined,
  path = "run",
): string[] {
  const issues: string[] = [];
  if (run.mode === "replay") {
    if (run.recordedAt === null) issues.push(at(`${path}.recordedAt`, "a replay says when"));
    if (run.commit === null) issues.push(at(`${path}.commit`, "a replay names its commit"));
  } else {
    if (run.recordedAt !== null) issues.push(at(`${path}.recordedAt`, "set on a live run"));
    if (run.commit !== null) issues.push(at(`${path}.commit`, "set on a live run"));
    if (run.replayed !== undefined) issues.push(at(`${path}.replayed`, "set on a live run"));
  }
  if (run.mode === "replay" && run.analyzerVersion === null && measuredAudio(audio)) {
    issues.push(at(`${path}.analyzerVersion`, "null although audio was measured"));
  }
  if (audio && run.analyzerVersion !== null && run.analyzerVersion !== audio.analyzerVersion) {
    issues.push(at(`${path}.analyzerVersion`, "differs from the measurement's"));
  }
  return issues;
}

/** Every producer-side rule of a result. Empty when the result may be sent or stored. */
export function analysisIssues(analysis: TrackAnalysis): string[] {
  const issues: string[] = [];
  const context = resultContext(analysis);
  const claimIds = new Set((analysis.claims ?? []).map((claim) => claim.id));

  (analysis.evidence ?? []).forEach((item, i) => {
    issues.push(...evidenceIssues(item, `evidence[${i}]`));
  });
  analysis.claims?.forEach((claim, i) => {
    issues.push(...claimIssues(claim, context, `claims[${i}]`));
  });
  if (analysis.audio) issues.push(...audioFeaturesIssues(analysis.audio));
  issues.push(...measuredCopyIssues(analysis));
  if (analysis.run) issues.push(...runIssues(analysis.run, analysis.audio));

  if (analysis.factoids.length > FACTOID_LIMITS.max) {
    issues.push(at("factoids", `${analysis.factoids.length} > ${FACTOID_LIMITS.max}`));
  }
  analysis.factoids.forEach((factoid, i) => {
    if (factoid.claimId !== undefined && !claimIds.has(factoid.claimId)) {
      issues.push(at(`factoids[${i}].claimId`, `unknown claim "${factoid.claimId}"`));
    }
  });
  analysis.genealogy.links.forEach((link, i) => {
    issues.push(...linkIssues(link, context, `genealogy.links[${i}]`));
    if (link.claimId !== undefined && !claimIds.has(link.claimId)) {
      issues.push(at(`genealogy.links[${i}].claimId`, `unknown claim "${link.claimId}"`));
    }
  });
  return issues;
}
