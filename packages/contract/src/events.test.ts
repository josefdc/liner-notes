/**
 * The SSE event unions: every event type survives the trip through the wire format, and the
 * client-side decoder skips what clients must ignore.
 */

import { describe, expect, it } from "vitest";
import {
  AnalyzeStreamEvent,
  decodeSseStream,
  encodeSseEvent,
  FactoidStreamEvent,
  sseData,
} from "./events.js";
import { sampleAnalysis, sampleAudio, sampleClaim, sampleEvidence } from "./testing/samples.js";
import { TrackAnalysis } from "./track.js";

const at = "2026-10-20T12:00:00.000Z";
const candidate = {
  id: "6GyFP1nfCDB8lbD2bG0Hq9",
  title: "Midnight City",
  artist: "M83",
  album: "Hurry Up, We're Dreaming",
  coverUrl: "",
  releaseYear: "2011",
};

/** Adds the envelope as a server does: `seq` counts every event except heartbeats. */
function numbered(runId: string | null) {
  let seq = 0;
  return (event: { type: string }) =>
    event.type === "heartbeat" ? { ...event, runId } : { ...event, runId, seq: seq++ };
}

/** One event of every type of the analysis stream, in a plausible order. */
const analyzeEvents = (): AnalyzeStreamEvent[] =>
  [
    { type: "connected", threadId: "t-1", timestamp: at },
    { type: "status", message: "Searching Spotify", code: "SPOTIFY-SEARCH", node: "scout" },
    {
      type: "interrupt",
      reason: "disambiguation",
      threadId: "t-1",
      candidates: [candidate],
      message: "Pick one",
    },
    { type: "resuming", threadId: "t-1", timestamp: at },
    { type: "heartbeat" },
    { type: "audio", audio: sampleAudio(), unavailableReason: null },
    { type: "audio", audio: null, unavailableReason: "no_preview" },
    { type: "evidence", evidence: sampleEvidence() },
    { type: "claim", claim: sampleClaim() },
    { type: "complete", data: TrackAnalysis.parse(sampleAnalysis()) },
    { type: "error", code: "budget_exhausted", error: "Live analysis is paused." },
    { type: "done", timestamp: at },
  ].map(numbered("run-1")) as AnalyzeStreamEvent[];

const factoidEvents = (): FactoidStreamEvent[] =>
  [
    { type: "connected", timestamp: at },
    { type: "factoid", data: { id: "m1", title: "T", content: "C", type: "sample" } },
    {
      type: "factoid",
      data: { id: "m2", title: "T", content: "C", type: "credits", claimId: "cl-1" },
      claim: sampleClaim(),
    },
    { type: "heartbeat" },
    { type: "error", code: "failed", error: "This fact could not be generated.", index: 2 },
    { type: "done" },
  ].map(numbered(null)) as FactoidStreamEvent[];

describe("AnalyzeStreamEvent", () => {
  it("the round-trip sample covers every event type", () => {
    const types = new Set(analyzeEvents().map((event) => event.type));
    expect([...types].sort()).toEqual(
      AnalyzeStreamEvent.options.map((option) => option.shape.type.value).sort(),
    );
  });

  it("every event survives encode, decode and parse unchanged", () => {
    const events = analyzeEvents();
    for (const event of events) expect(AnalyzeStreamEvent.parse(event)).toEqual(event);
    const body = events.map(encodeSseEvent).join("");
    expect(decodeSseStream(body, AnalyzeStreamEvent)).toEqual(events);
  });

  it("numbers events without counting heartbeats, so numbering does not depend on timing", () => {
    const events = analyzeEvents();
    const numbers = events.flatMap((event) => (event.type === "heartbeat" ? [] : [event.seq]));
    expect(numbers).toEqual(numbers.map((_, i) => i));
    const heartbeat = AnalyzeStreamEvent.parse({ type: "heartbeat", runId: "r", seq: 4 });
    expect(heartbeat).toEqual({ type: "heartbeat", runId: "r" });
  });

  it("keeps an error with a code it does not know, so the error is still shown", () => {
    const event = {
      type: "error",
      runId: "r",
      seq: 4,
      code: "quota_exceeded",
      error: "Try later.",
    };
    const [decoded] = decodeSseStream(encodeSseEvent(event as never), AnalyzeStreamEvent);
    expect(decoded).toEqual(event);
    const factoidError = { type: "error", runId: null, seq: 0, code: "new_code", error: "x" };
    expect(FactoidStreamEvent.parse(factoidError)).toEqual(factoidError);
  });

  it("keeps a status code it does not know", () => {
    const event = { type: "status", runId: "r", seq: 0, message: "m", code: "NEW-CODE-1" };
    expect(AnalyzeStreamEvent.parse(event)).toEqual(event);
  });

  it("decodes two CRLF-terminated events in a row and data split over several lines", () => {
    const [first, second, third] = analyzeEvents();
    const crlf = (event: AnalyzeStreamEvent) => encodeSseEvent(event).replace(/\n\n$/, "\r\n\r\n");
    const split = JSON.stringify(third).replace('","', '",\ndata: "');
    const body = `${crlf(first)}${crlf(second)}data: ${split}\r\n\r\n`;
    expect(split).toContain("\ndata: ");
    expect(decodeSseStream(body, AnalyzeStreamEvent)).toEqual([first, second, third]);
  });

  it("joins multi-line data with a newline and ignores other fields", () => {
    expect(sseData("event: x\r\ndata: a\r\ndata:b\nid: 3")).toBe("a\nb");
  });

  it("decoding skips comments, unknown types, malformed JSON and invalid events", () => {
    const [first, second] = analyzeEvents();
    const body = [
      ": keep-alive comment\n\n",
      encodeSseEvent(first),
      'data: {"type":"telemetry","runId":"run-1","seq":1}\n\n',
      "data: {not json\n\n",
      'data: {"type":"status","message":"no envelope"}\n\n',
      `event: heartbeat\r\n${encodeSseEvent(second).replace(/\n\n$/, "\r\n\r\n")}`,
    ].join("");
    expect(decodeSseStream(body, AnalyzeStreamEvent)).toEqual([first, second]);
  });

  it.each([
    ["without runId", { type: "status", seq: 0, message: "m" }],
    ["with an empty runId", { type: "status", runId: "", seq: 0, message: "m" }],
    ["without runId", { type: "heartbeat" }],
    ["without seq", { type: "status", runId: "r", message: "m" }],
    ["with a negative seq", { type: "status", runId: "r", seq: -1, message: "m" }],
    ["with a fractional seq", { type: "status", runId: "r", seq: 1.5, message: "m" }],
    ["with the legacy candidates type", { type: "candidates", runId: "r", seq: 0, candidates: [] }],
    [
      "with a complete event without data",
      { type: "complete", runId: "r", seq: 0, data: undefined },
    ],
  ])("rejects an event %s", (_name, event) => {
    expect(AnalyzeStreamEvent.safeParse(event).success).toBe(false);
  });
});

describe("FactoidStreamEvent", () => {
  it("every event survives encode, decode and parse unchanged", () => {
    const events = factoidEvents();
    const types = new Set(events.map((event) => event.type));
    expect([...types].sort()).toEqual(
      FactoidStreamEvent.options.map((option) => option.shape.type.value).sort(),
    );
    const body = events.map(encodeSseEvent).join("");
    expect(decodeSseStream(body, FactoidStreamEvent)).toEqual(events);
  });

  it("rejects a factoid with the removed lyrics type", () => {
    const event = {
      type: "factoid",
      runId: null,
      seq: 0,
      data: { id: "m", title: "T", content: "C", type: "lyrics" },
    };
    expect(FactoidStreamEvent.safeParse(event).success).toBe(false);
  });
});
