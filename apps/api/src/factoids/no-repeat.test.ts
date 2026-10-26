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
  RUN_ID,
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

describe("fact ids", () => {
  it("stay unique across two clicks when a fact failed in between", async () => {
    const texts = [
      "The bass line was played on a Fender Precision.",
      "The horns come from a record found in a Paris flea market.",
      "Romanthony recorded the vocal in New Jersey.",
    ];
    const query = (existing: string[]) =>
      new URLSearchParams({
        trackTitle: DEMO_TRACK.trackTitle,
        trackArtist: DEMO_TRACK.trackArtist,
        existingIds: existing.join(","),
      }).toString();

    // First click: the first fact fails, the other two are sent.
    const first = await streamOf(
      routerFor({ cards: [new LlmError("provider", "500"), card(texts[1]), card(texts[2])] })
        .router,
      query(["f1", "f2"]),
    );
    expect(first.filter((message) => message.type === "error")).toMatchObject([{ index: 0 }]);
    const firstIds = idsOf(first);
    expect(firstIds).toHaveLength(2);

    // Second click: the client sends every id it shows; the model writes all three facts.
    const shown = ["f1", "f2", ...firstIds];
    const second = await streamOf(
      routerFor({ cards: texts.map((text) => card(text)) }).router,
      query(shown),
    );
    const secondIds = idsOf(second);
    expect(secondIds).toHaveLength(3);

    const all = [...shown, ...secondIds];
    expect(new Set(all).size).toBe(all.length);
  });
});
