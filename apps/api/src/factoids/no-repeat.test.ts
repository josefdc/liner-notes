/**
 * "More facts" never repeat a fact: the facts of the analysis run the request names are shown to
 * the model and a new fact that repeats one (or another of the batch) is dropped; and a new
 * fact's id is never one the client already has, also after a fact that failed.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Router } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { messagesOf } from "../agent/testing/stubLlm.js";
import { createTestApp } from "../http/testApp.js";
import { createFactoidsRouter } from "../http/routes/factoids.js";
import { LlmError } from "../llm/errors.js";
import {
  card,
  DEMO_TRACK,
  evidenceItem,
  type FakeModel,
  fakeModel,
  focusOf,
  RUN_ID,
  storedCredit,
  storedRun,
} from "./testing/fakes.js";

const STORED = [
  "Thomas Bangalter built the loop from a filtered horn sample.",
  "The vocal was sung by Romanthony through heavy Auto-Tune.",
  "The single came out months before the album Discovery.",
  "The video is part of the anime film Interstella 5555.",
  "The track topped the French singles chart.",
];

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const routerFor = (model: FakeModel) => {
  const llm = fakeModel(model);
  const router = createFactoidsRouter({
    llm,
    loadRun: (id) =>
      id === RUN_ID ? storedRun([evidenceItem("ev-1", "A record.")], STORED) : null,
  });
  return { llm, router };
};

const normalised = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

describe("a run with five stored facts", () => {
  it("sends no fact whose text repeats a stored one or another new one", async () => {
    const fresh = "The talk box part was recorded on a borrowed DigiTech unit.";
    const { llm, router } = routerFor({
      cards: [
        // A stored fact echoed with other case and punctuation.
        card(`  ${STORED[2].toUpperCase().replace(".", "!")}`),
        card(fresh),
        // The same new fact again in other words, in the same batch.
        card("The talk box part was recorded on one borrowed DigiTech unit."),
      ],
    });

    const res = await request(createTestApp(router))
      .post("/api/factoids/decrypt")
      .send({ ...DEMO_TRACK, runId: RUN_ID, existingFactoidIds: [] })
      .timeout(5000);

    expect(res.status).toBe(200);
    const texts: string[] = res.body.factoids.map(
      (factoid: { content: string }) => factoid.content,
    );
    expect(texts).toEqual([fresh]);
    const all = [...STORED, ...texts].map(normalised);
    expect(new Set(all).size).toBe(all.length);
    // The model was shown the stored facts, to write about something else.
    const prompts = llm.calls.filter((call) => call.callSite === "factoids");
    expect(prompts).toHaveLength(3);
    for (const call of prompts) {
      for (const text of STORED) expect(messagesOf(call).user).toContain(text);
    }
  });
});

// =============================================================================
// Ids across clicks
// =============================================================================

let server: http.Server | undefined;

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));
    server = undefined;
  }
});

/** The messages of one whole factoid stream. */
async function streamOf(router: Router, query: string): Promise<Array<Record<string, unknown>>> {
  server = createTestApp(router).listen(0, "127.0.0.1");
  await new Promise((resolve) => server?.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  const body = await new Promise<string>((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}/api/factoids/decrypt/stream?${query}`, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
        });
        res.on("end", () => resolve(text));
      })
      .on("error", reject);
  });
  server.closeAllConnections();
  await new Promise((resolve) => server?.close(resolve));
  server = undefined;
  return body
    .split("\n\n")
    .map((part) => part.split("\n").find((line) => line.startsWith("data: ")))
    .filter((line): line is string => line !== undefined)
    .map((line) => JSON.parse(line.slice("data: ".length)));
}

const idsOf = (messages: Array<Record<string, unknown>>) =>
  messages
    .filter((message) => message.type === "factoid")
    .map((message) => (message.data as { id: string }).id);

const query = (existing: string[]) =>
  new URLSearchParams({
    trackTitle: DEMO_TRACK.trackTitle,
    trackArtist: DEMO_TRACK.trackArtist,
    existingIds: existing.join(","),
  }).toString();

/** The focus each factoid call asked about. */
const focusesAsked = (llm: { calls: Parameters<typeof focusOf>[0][] }) =>
  llm.calls.filter((call) => call.callSite === "factoids").map((call) => focusOf(call));

describe("fact ids and repeats across clicks", () => {
  it("stay unique after a failed fact, and a fact the client shows is not sent again", async () => {
    const texts = [
      "The bass line was played on a Fender Precision.",
      "The horns come from a record found in a Paris flea market.",
      "Romanthony recorded the vocal in New Jersey.",
    ];
    const fresh = "The talk box was borrowed from a session player in Paris.";

    // First click: the first fact fails, the other two are sent.
    const first = await streamOf(
      routerFor({ cards: [new LlmError("provider", "500"), card(texts[1]), card(texts[2])] })
        .router,
      query(["f1", "f2"]),
    );
    expect(first.filter((message) => message.type === "error")).toMatchObject([{ index: 0 }]);
    const firstIds = idsOf(first);
    expect(firstIds).toHaveLength(2);

    // Second click: the client sends every id it shows. Whatever it is asked, the model answers
    // the fact that failed, one it has already sent, and a new one.
    const shown = ["f1", "f2", ...firstIds];
    const answers = [card(texts[0]), card(texts[1]), card(fresh)];
    const { llm, router } = routerFor({ cards: [...answers, ...answers] });
    const second = await streamOf(router, query(shown));
    const sent = second.filter((message) => message.type === "factoid") as Array<{
      data: { id: string; content: string };
    }>;
    expect(sent.map(({ data }) => data.content)).toEqual([texts[0], fresh]);

    const all = [...shown, ...sent.map(({ data }) => data.id)];
    expect(new Set(all).size).toBe(all.length);
    // The second click asked about other angles than the first.
    expect(focusesAsked(llm)).toEqual([3, 4, 5]);
  });

  it("sends nothing on a second click whose facts were all sent on the first", async () => {
    const texts = [
      "The bass line was played on a Fender Precision.",
      "The horns come from a record found in a Paris flea market.",
      "Romanthony recorded the vocal in New Jersey.",
    ];
    const answers = texts.map((text) => card(text));
    const post = (router: Router, existingFactoidIds: string[]) =>
      request(createTestApp(router))
        .post("/api/factoids/decrypt")
        .send({ ...DEMO_TRACK, runId: RUN_ID, existingFactoidIds })
        .timeout(5000);

    const first = await post(routerFor({ cards: answers }).router, ["stored-1"]);
    expect(first.body.factoids).toHaveLength(3);

    // The same three facts again, under the next angles.
    const { llm, router } = routerFor({ cards: [...answers, ...answers] });
    const shown = ["stored-1", ...first.body.factoids.map((factoid: { id: string }) => factoid.id)];
    const second = await post(router, shown);

    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ success: true, factoids: [], claims: [] });
    expect(focusesAsked(llm)).toEqual([3, 4, 5]);
    // Nothing was left to check.
    expect(llm.calls.some((call) => call.callSite === "verifier")).toBe(false);
  });
});

// =============================================================================
// What counts as a repeat
// =============================================================================

describe("repeats", () => {
  it("drops a fact that only restates one of the run's other statements", async () => {
    const credit = "Daft Punk produced the track at their home studio in Paris.";
    const llm = fakeModel({
      cards: [card(`${credit.toUpperCase()}`), null, null],
    });
    const router = createFactoidsRouter({
      llm,
      loadRun: (id) =>
        id === RUN_ID
          ? storedRun([evidenceItem("ev-1", "A record.")], [], [storedCredit(credit)])
          : null,
    });

    const res = await request(createTestApp(router))
      .post("/api/factoids/decrypt")
      .send({ ...DEMO_TRACK, runId: RUN_ID })
      .timeout(5000);

    expect(res.status).toBe(200);
    expect(res.body.factoids).toEqual([]);
  });

  it("keeps two facts in the same words that name different records", async () => {
    const sample = (artist: string) =>
      "The main hook is built on a sample lifted from a 1977 disco single, slowed down and " +
      `filtered so the horns sit under the vocal; the sampled record is by ${artist}.`;
    const { router } = routerFor({
      cards: [
        card(sample("Eddie Johns"), [], ["Eddie Johns"]),
        null,
        card(sample("George Duke"), [], ["George Duke"]),
      ],
    });

    const res = await request(createTestApp(router))
      .post("/api/factoids/decrypt")
      .send({ ...DEMO_TRACK, runId: RUN_ID })
      .timeout(5000);

    expect(res.body.factoids.map((factoid: { content: string }) => factoid.content)).toEqual([
      sample("Eddie Johns"),
      sample("George Duke"),
    ]);
  });
});
