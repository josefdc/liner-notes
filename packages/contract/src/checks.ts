/**
 * Producer-side checks, and how readers show what they received.
 *
 * Reader schemas are lenient: one bad claim, evidence item or audio block must not reject a
 * whole result. The rules that relate parts of a result to each other are checked here
 * instead, by the code that builds a result, before it is sent or stored. Each function
 * returns one message per problem, prefixed with the path of the offending value; an empty
 * list means the value may be emitted.
 */

import { AUDIO_MEASURED_BLOCKS, type AudioFeatures } from "./audio.js";
import { type Claim, type ClaimKind, EVIDENCE_EXCERPT_MAX, type Evidence } from "./evidence.js";
import { FACTOID_LIMITS, type RunInfo, type TrackAnalysis } from "./track.js";

const at = (path: string, message: string) => (path ? `${path}: ${message}` : message);

/** An evidence item names its record (a url or a record reference) and keeps a short excerpt. */
export function evidenceIssues(evidence: Evidence, path = ""): string[] {
  const issues: string[] = [];
  if (evidence.url === null && evidence.recordRef === null) {
    issues.push(at(path, "needs a url or a recordRef"));
  }
  if (evidence.excerpt.length > EVIDENCE_EXCERPT_MAX) {
    issues.push(at(`${path}.excerpt`, `longer than ${EVIDENCE_EXCERPT_MAX} characters`));
  }
  return issues;
}

/**
 * A gate that did not pass has a reason and measures nothing (no tempo, no "C major" for
 * silence); a gate that passed has no reason.
 */
export function audioFeaturesIssues(audio: AudioFeatures, path = "audio"): string[] {
  const issues: string[] = [];
  if (audio.gate.passed) {
    if (audio.gate.reason !== null) issues.push(at(`${path}.gate.reason`, "set on a passed gate"));
    return issues;
  }
  if (audio.gate.reason === null) issues.push(at(`${path}.gate.reason`, "missing"));
  for (const block of AUDIO_MEASURED_BLOCKS) {
    if (audio[block] !== null) issues.push(at(`${path}.${block}`, "must be null when gated"));
  }
  if (audio.keyMoments.length > 0) {
    issues.push(at(`${path}.keyMoments`, "must be empty when gated"));
  }
  return issues;
}

/**
 * Measured claims come from code. A sourced claim cites at least one item of the evidence
 * pack, and every id it cites is in the pack; a model-written sourced claim also needs a
 * supported or partial verdict. A code-built claim (from a source record) is supported by
 * construction: the judge may disagree, and its verdict is kept for the record.
 */
export function claimIssues(claim: Claim, evidenceIds: ReadonlySet<string>, path = ""): string[] {
  const issues: string[] = [];
  if (claim.kind === "measured" && claim.origin !== "code") {
    issues.push(at(`${path}.origin`, "measured claims come from code"));
  }
  if (claim.kind !== "sourced") return issues;
  if (claim.evidenceIds.length === 0) issues.push(at(`${path}.evidenceIds`, "cites nothing"));
  for (const id of claim.evidenceIds) {
    if (!evidenceIds.has(id)) {
      issues.push(at(`${path}.evidenceIds`, `cites "${id}", which is not in the evidence pack`));
    }
  }
  if (claim.origin === "model" && claim.verdict !== "supported" && claim.verdict !== "partial") {
    issues.push(at(`${path}.verdict`, "a model claim is sourced only when supported or partial"));
  }
  return issues;
}

/**
 * How a reader shows a claim. A sourced claim that cites nothing, cites evidence missing from
 * the pack, or is a model claim the judge did not support reads as model inference; so does a
 * "measured" claim the model wrote. Everything else keeps its kind.
 */
export function claimDisplayKind(claim: Claim, evidenceIds: ReadonlySet<string>): ClaimKind {
  if (claim.kind === "measured") return claim.origin === "code" ? "measured" : "inferred";
  if (claim.kind !== "sourced") return claim.kind;
  const cited =
    claim.evidenceIds.length > 0 && claim.evidenceIds.every((id) => evidenceIds.has(id));
  const judged =
    claim.origin === "code" || claim.verdict === "supported" || claim.verdict === "partial";
  return cited && judged ? "sourced" : "inferred";
}

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
  }
  const measured = audio?.gate.passed === true;
  if (run.mode === "replay" && run.analyzerVersion === null && measured) {
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
  const evidence = analysis.evidence ?? [];
  const evidenceIds = new Set(evidence.map((item) => item.id));
  const claimIds = new Set((analysis.claims ?? []).map((claim) => claim.id));

  evidence.forEach((item, i) => {
    issues.push(...evidenceIssues(item, `evidence[${i}]`));
  });
  analysis.claims?.forEach((claim, i) => {
    issues.push(...claimIssues(claim, evidenceIds, `claims[${i}]`));
  });
  if (analysis.audio) issues.push(...audioFeaturesIssues(analysis.audio));
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
    for (const id of link.evidenceIds ?? []) {
      if (!evidenceIds.has(id)) {
        issues.push(at(`genealogy.links[${i}].evidenceIds`, `cites "${id}", not in the pack`));
      }
    }
    if (link.claimId !== undefined && !claimIds.has(link.claimId)) {
      issues.push(at(`genealogy.links[${i}].claimId`, `unknown claim "${link.claimId}"`));
    }
  });
  return issues;
}
