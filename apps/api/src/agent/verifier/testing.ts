/**
 * Test helpers for the verifier: a draft as the composer hands it, the state around it, and a
 * model layer that answers the judge.
 */

import type { Claim, Evidence, JudgeOutput } from "@liner-notes/contract";
import type { ComposedDraft, SonicAgentStateType } from "../state.js";
import { measurementOf, audioV2 } from "../testing/measuredAudio.js";
import { type StubCall, stubLlm } from "../testing/stubLlm.js";

/** A primary record about this recording (its recordRef starts with track/). */
export function trackRecord(id: string, excerpt = `MusicBrainz: ${id}`): Evidence {
  return {
    id,
    source: "musicbrainz",
    sourceTier: "primary-record",
    url: `https://musicbrainz.org/recording/${id}`,
    title: `Record ${id}`,
    retrievedAt: "2026-01-01T00:00:00.000Z",
    excerpt,
    recordRef: `track/recording/${id}`,
  };
}

/** A model claim as the composer writes it: inferred, unjudged, numbers not checked. */
export function modelClaim(id: string, change: Partial<Claim> = {}): Claim {
  return {
    id,
    text: `Statement ${id}.`,
    about: "history",
    kind: "inferred",
    origin: "model",
    evidenceIds: [],
    verdict: null,
    verdictReason: null,
    numericCheck: "n/a",
    scope: "recording",
    ...change,
  };
}

/** A draft holding `claims` and, optionally, links; nodes for every link end. */
export function draftOf(
  claims: Claim[],
  links: ComposedDraft["genealogy"]["links"] = [],
  change: Partial<ComposedDraft> = {},
): ComposedDraft {
  const ends = new Set(links.flatMap((link) => [link.source, link.target]));
  ends.delete("current");
  return {
    modelUnavailableReason: null,
    factoids: [],
    claims,
    genealogy: {
      nodes: [
        { id: "current", group: 1, label: "Ice Ice Baby", size: 40 },
        ...[...ends].map((id) => ({ id, group: 4, label: `${id} - Artist`, size: 22 })),
      ],
      links,
    },
    nodeYears: {},
    segments: [{ label: "Main", start: 0, end: 100 }],
    segmentsSource: "template",
    samples: [],
    ...change,
  };
}

/** The state the verifier runs on: the track, a measured clip (115.8 BPM, D minor), `draft`. */
export function stateFor(
  draft: ComposedDraft,
  evidence: Evidence[],
  change: Record<string, unknown> = {},
): SonicAgentStateType {
  return {
    songQuery: "ice ice baby",
    spotifyData: {
      id: "x",
      title: "Ice Ice Baby",
      artist: "Vanilla Ice",
      artistIds: ["a1"],
      album: "To the Extreme",
      releaseDate: "1990-09-10",
      coverUrl: "https://i.scdn.co/image/x",
      duration: "4:30",
      durationMs: 270000,
      explicit: false,
      spotifyUrl: "https://open.spotify.com/track/x",
      previewUrl: null,
    },
    audioFeatures: measurementOf(audioV2()),
    evidence,
    draft,
    claims: [],
    usage: [
      {
        callSite: "composer",
        tier: "main",
        status: "ok",
        deployment: "stub-main",
        attempts: 1,
        mode: "live",
        inputTokens: 100,
        outputTokens: 20,
        reasoningTokens: 0,
        usdEst: 0,
      },
    ],
    sourceErrors: [],
    lastingSourceErrors: [],
    primaryNotAsked: [],
    isrc: null,
    preview: null,
    previewUrl: null,
    queryMatch: null,
    selectedBy: "match",
    ...change,
  } as unknown as SonicAgentStateType;
}

/** The statements a judge call was sent, as the prompt lists them. */
export function sentStatements(call: StubCall): Array<{ claimId: string; text: string }> {
  const user = (call.input as ReadonlyArray<{ role: string; content: string }>).find(
    (message) => message.role === "user",
  )?.content;
  const block = user?.split("<<<SOURCE statements>>>\n")[1]?.split("\n<<<END SOURCE>>>")[0];
  return (block ?? "")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** A model layer whose judge answers `verdicts(sent)` for the statements it was sent. */
export function judging(
  verdicts: (sent: Array<{ claimId: string; text: string }>) => JudgeOutput["verdicts"],
) {
  return stubLlm((call) => {
    if (call.callSite !== "verifier") throw new Error(`unexpected call ${call.callSite}`);
    return { verdicts: verdicts(sentStatements(call)) };
  });
}
