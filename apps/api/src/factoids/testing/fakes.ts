/**
 * Test helpers for "more facts": a stored analysis run with its evidence and facts, and a fake
 * model layer that writes one card per focus and judges the statements it is sent. No provider
 * and no cassette is used.
 */

import type {
  Claim,
  ComposerFactoid,
  Evidence,
  Factoid,
  JudgeOutput,
  ReplayRecord,
  TrackAnalysis,
  Verdict,
} from "@liner-notes/contract";
import { messagesOf, type StubCall, type StubLlm, stubLlm } from "../../agent/testing/stubLlm.js";
import { pinnedRecord, readRecording } from "../../replay/testing/recordings.js";

/** The demo recording, read from the replay directory. */
export const demoRecord = (): ReplayRecord => readRecording();

/**
 * The One More Time recording as made before one claim per fact (the pinned copy): a recording
 * whose replay leaves out the model's restatements of code-built claims.
 */
export const restatingRecord = (): ReplayRecord => pinnedRecord();

export const RUN_ID = "run-more-facts-1";

/** An item about this recording (a `track/` primary record). */
export const evidenceItem = (id: string, excerpt: string): Evidence => ({
  id,
  source: "musicbrainz",
  sourceTier: "primary-record",
  url: `https://musicbrainz.org/recording/${id}`,
  title: `Record ${id}`,
  retrievedAt: "2026-10-20T12:00:00.000Z",
  excerpt,
  recordRef: `track/recording/${id}`,
});

/** A stored fact card and its claim (inferred, as the composer leaves an unjudged one). */
export function storedFact(index: number, text: string): { factoid: Factoid; claim: Claim } {
  const claim: Claim = {
    id: `stored-claim-${index}`,
    text,
    about: "trivia",
    kind: "inferred",
    origin: "model",
    evidenceIds: [],
    verdict: null,
    verdictReason: null,
    numericCheck: "n/a",
    scope: "recording",
    factoid: { title: `Stored ${index}`, type: "trivia", entities: [] },
  };
  const factoid: Factoid = {
    id: `stored-${index}`,
    title: `Stored ${index}`,
    content: text,
    type: "trivia",
    claimId: claim.id,
  };
  return { factoid, claim };
}

/** A stored statement that is not a card (a credit, as the code-built claims state one). */
export const storedCredit = (text: string): Claim => ({
  id: "stored-credit-1",
  text,
  about: "credit",
  kind: "sourced",
  origin: "code",
  evidenceIds: [],
  verdict: null,
  verdictReason: null,
  numericCheck: "n/a",
  scope: "recording",
});

/**
 * The demo recording's result as a stored run (`RUN_ID`) with this evidence pack, these stored
 * facts and these other statements in place of its own.
 */
export function storedRun(
  evidence: Evidence[],
  facts: string[] = [],
  otherClaims: Claim[] = [],
): TrackAnalysis {
  const { analysis } = demoRecord();
  const stored = facts.map((text, index) => storedFact(index + 1, text));
  return {
    ...analysis,
    run: analysis.run ? { ...analysis.run, id: RUN_ID } : analysis.run,
    evidence,
    factoids: stored.map((fact) => fact.factoid),
    claims: [...stored.map((fact) => fact.claim), ...otherClaims],
  };
}

/** The request body or query naming the demo track. */
export const DEMO_TRACK = {
  trackId: demoRecord().analysis.id,
  trackTitle: demoRecord().analysis.title,
  trackArtist: demoRecord().analysis.artist,
};

/** A card as the model writes it (ComposerFactoid), naming `entities` (artists). */
export const card = (
  text: string,
  evidenceIds: string[] = [],
  entities?: string[],
): ComposerFactoid => ({
  title: `About ${text.slice(0, 20)}`,
  text,
  type: "production",
  entities: entities
    ? entities.map((name) => ({ text: name, type: "artist" as const }))
    : [{ text: "Roland Juno-106", type: "synth" }],
  evidenceIds,
  scope: "recording",
});

/**
 * The routes' focuses (FACTOID_FOCUSES): a first click asks about the first three, the next
 * click about the next three.
 */
export const FOCUSES = [
  "hidden production techniques or studio secrets",
  "obscure samples, influences, or interpolations",
  "little-known collaborators, session musicians, or equipment used",
  "how the song was written or first put together",
  "the track's release and what became of it later (remixes, covers, uses on screen)",
  "the other records and artists it is tied to",
];

/** The focus a factoid call asks about (its index in FOCUSES), or null when it asks for several. */
export function focusOf(call: StubCall): number | null {
  const { user } = messagesOf(call);
  const match = /Focus: (.+)\.$/m.exec(user);
  return match ? FOCUSES.indexOf(match[1]) : null;
}

/** The statements a judge call was sent: positional id, text and cited ids. */
export function statementsOf(
  call: StubCall,
): Array<{ claimId: string; text: string; cites: string[] }> {
  const { user } = messagesOf(call);
  const block = /<<<SOURCE statements>>>\n([\s\S]*?)\n<<<END SOURCE>>>/.exec(user);
  return block ? block[1].split("\n").map((line) => JSON.parse(line)) : [];
}

/** Whether a call is the judge's (its own call site; "verifier" for the analysis's judge). */
export const isJudge = (call: { callSite: string }) =>
  call.callSite === "factoids-judge" || call.callSite === "verifier";

export interface FakeModel {
  /** The card each focus gets (by its index in FOCUSES): a card, nothing, or a failed call. */
  cards: Array<ComposerFactoid | null | Error>;
  /** The verdict on a statement, by its text; or a failure of the judge call. */
  judge?: ((text: string) => Verdict) | Error;
}

/**
 * A model layer for the factoid routes: a `factoids` call gets the card of its focus (all the
 * cards when it asks for several), a `verifier` call the verdicts `judge` gives.
 */
export function fakeModel(model: FakeModel): StubLlm {
  return stubLlm((call) => {
    if (isJudge(call)) {
      if (model.judge instanceof Error) throw model.judge;
      const judge = model.judge ?? (() => "unsupported" as const);
      const output: JudgeOutput = {
        verdicts: statementsOf(call).map((statement) => ({
          claimId: statement.claimId,
          verdict: judge(statement.text),
          reason: "The cited excerpt decides it.",
        })),
      };
      return output;
    }
    const focus = focusOf(call);
    const chosen = focus === null ? model.cards : [model.cards[focus] ?? null];
    const failed = chosen.find((entry) => entry instanceof Error);
    if (failed) throw failed;
    return { factoids: chosen.filter((entry): entry is ComposerFactoid => entry !== null) };
  });
}
