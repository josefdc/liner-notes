/**
 * LLM cassettes: a replay miss is a hard error with no network call, record then replay gives
 * the same answer, the key ignores ids and timestamps, and cassettes hold no credentials.
 * Run: npm test -w apps/api -- llm/cassette
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  cassetteKey,
  knownSecrets,
  type LlmMessage,
  normaliseMessages,
  scrubSecrets,
  writeCassette,
} from "./cassette.js";
import { isLlmError } from "./errors.js";
import { createLlm } from "./invoke.js";
import { answer, FAKE_API_KEY, testSettings } from "./testing/providerStub.js";

const Schema = z.object({ summary: z.string(), count: z.number() });
const OPTIONS = { purpose: "dev" as const, runId: "run-1", maxOutputTokens: 500, schemaName: "S" };

let dir: string;
let globalFetch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llm-cassette-"));
  writeFileSync(join(dir, "spend.jsonl"), "");
  globalFetch = vi.fn(() => {
    throw new Error("network denied");
  });
  vi.stubGlobal("fetch", globalFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

const settings = (mode: "record" | "replay", extra: Record<string, string> = {}) =>
  testSettings({
    LLM_CASSETTE: mode,
    LLM_CASSETTE_DIR: join(dir, "cassettes"),
    LLM_SPEND_LOG: join(dir, "spend.jsonl"),
    ...extra,
  });

describe("replay", () => {
  it("is the default in api tests", () => {
    expect(process.env.LLM_CASSETTE).toBe("replay");
  });

  it("fails a call with no cassette, without any network request or spending", async () => {
    const net = answer({ summary: "x", count: 1 });
    const llm = createLlm({
      settings: settings("replay"),
      fetch: net.fetch,
      recordUsage: () => {},
    });
    const error = await llm.invoke("composer", "main", "hello", Schema, OPTIONS).catch((e) => e);
    expect(isLlmError(error, "cassette_miss")).toBe(true);
    expect(error.message).toContain("LLM_CASSETTE=record");
    expect(net.calls).toHaveLength(0);
    expect(globalFetch).not.toHaveBeenCalled();
    // Nothing recorded, nothing spent.
    expect(readdirSync(dir)).toEqual(["spend.jsonl"]);
    expect(readFileSync(join(dir, "spend.jsonl"), "utf8")).toBe("");
  });

  it("needs neither credentials nor a spend log", async () => {
    const replaySettings = {
      ...settings("replay"),
      azureApiKey: null,
      azureBaseUrl: null,
      spendLog: null,
    };
    const llm = createLlm({ settings: replaySettings, recordUsage: () => {} });
    const error = await llm.invoke("composer", "main", "hello", Schema, OPTIONS).catch((e) => e);
    expect(isLlmError(error, "cassette_miss")).toBe(true);
  });

  it("replays a recorded answer with no network and no spending", async () => {
    const net = answer({ summary: "recorded", count: 3 }, { input: 40, output: 12, reasoning: 5 });
    const recorder = createLlm({
      settings: settings("record"),
      fetch: net.fetch,
      recordUsage: () => {},
    });
    const messages: LlmMessage[] = [
      { role: "system", content: "You summarise. Run run-1 at 2026-10-21T10:00:00.000Z." },
      { role: "user", content: "Count the samples." },
    ];
    const live = await recorder.invoke("composer", "main", messages, Schema, OPTIONS);
    expect(live.mode).toBe("record");
    expect(net.calls).toHaveLength(1);
    const spendBefore = readFileSync(join(dir, "spend.jsonl"), "utf8");

    const rows: unknown[] = [];
    const replayer = createLlm({
      settings: settings("replay"),
      recordUsage: (row) => rows.push(row),
    });
    // Another run, another time: same key.
    const again: LlmMessage[] = [
      { role: "system", content: "You summarise. Run run-2 at 2026-10-22T08:30:00Z." },
      { role: "user", content: "Count the samples.\r\n" },
    ];
    const replayed = await replayer.invoke("composer", "main", again, Schema, {
      ...OPTIONS,
      runId: "run-2",
    });
    expect(replayed.mode).toBe("replay");
    expect(replayed.output).toEqual(live.output);
    expect(replayed.usage).toMatchObject({
      inputTokens: 40,
      outputTokens: 12,
      reasoningTokens: 5,
      usdEst: 0,
    });
    expect(rows).toMatchObject([{ mode: "replay", usdEst: 0, status: "ok" }]);
    expect(globalFetch).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, "spend.jsonl"), "utf8")).toBe(spendBefore);

    // A changed prompt, tier or schema is a miss.
    const changed = await replayer
      .invoke("composer", "main", "Count the samples twice.", Schema, OPTIONS)
      .catch((e) => e);
    expect(isLlmError(changed, "cassette_miss")).toBe(true);
    const otherTier = await replayer
      .invoke("composer", "research", messages, Schema, OPTIONS)
      .catch((e) => e);
    expect(isLlmError(otherTier, "cassette_miss")).toBe(true);
  });

  it("rejects a recorded answer that no longer matches the schema", async () => {
    const net = answer({ summary: "recorded", count: 3 });
    const recorder = createLlm({
      settings: settings("record"),
      fetch: net.fetch,
      recordUsage: () => {},
    });
    await recorder.invoke("composer", "main", "hi", Schema, OPTIONS);
    const [file] = readdirSync(join(dir, "cassettes"));
    const path = join(dir, "cassettes", file);
    const entry = JSON.parse(readFileSync(path, "utf8"));
    entry.output = { summary: 1 };
    writeFileSync(path, JSON.stringify(entry));
    const replayer = createLlm({ settings: settings("replay"), recordUsage: () => {} });
    const error = await replayer.invoke("composer", "main", "hi", Schema, OPTIONS).catch((e) => e);
    expect(isLlmError(error, "invalid_output")).toBe(true);
  });
});

describe("record and replay with the same deployment map", () => {
  it("replays, under the default map, answers recorded with the resource's FAST and PRO settings", async () => {
    const net = answer({ summary: "s", count: 1 });
    const recorder = createLlm({
      settings: settings("record", {
        AZURE_OPENAI_DEPLOYMENT_FAST: "gpt-6-luna",
        AZURE_OPENAI_DEPLOYMENT_PRO: "gpt-6-sol",
      }),
      fetch: net.fetch,
      recordUsage: () => {},
    });
    const replayer = createLlm({ settings: settings("replay"), recordUsage: () => {} });
    for (const tier of ["fast", "main", "research", "judge"] as const) {
      await recorder.invoke("scout", tier, "classify", Schema, OPTIONS);
      const replayed = await replayer.invoke("scout", tier, "classify", Schema, OPTIONS);
      expect(replayed.mode).toBe("replay");
    }
  });

  it("pins the test process to the default deployments", () => {
    expect(process.env.AZURE_OPENAI_DEPLOYMENT_FAST).toBe("gpt-6-luna");
    expect(process.env.AZURE_OPENAI_DEPLOYMENT_MAIN).toBe("gpt-6-luna");
    expect(process.env.AZURE_OPENAI_DEPLOYMENT_RESEARCH).toBe("gpt-6-sol");
    expect(process.env.AZURE_OPENAI_DEPLOYMENT_JUDGE).toBe("gpt-6-sol");
    expect(process.env.AZURE_OPENAI_DEPLOYMENT_PRO).toBeUndefined();
  });
});

describe("recording provenance", () => {
  it("records when and from which commit, and replays it; an older entry says neither", async () => {
    const net = answer({ summary: "s", count: 1 });
    const recorder = createLlm({
      settings: settings("record"),
      fetch: net.fetch,
      recordUsage: () => {},
      now: () => new Date("2026-03-01T10:00:00.000Z"),
      commit: () => "abc123def456",
    });
    await recorder.invoke("scout", "main", "classify", Schema, OPTIONS);
    const [file] = readdirSync(join(dir, "cassettes"));
    const path = join(dir, "cassettes", file);
    const entry = JSON.parse(readFileSync(path, "utf8"));
    expect(entry).toMatchObject({ recordedAt: "2026-03-01T10:00:00.000Z", commit: "abc123def456" });

    const replayer = createLlm({ settings: settings("replay"), recordUsage: () => {} });
    const replayed = await replayer.invoke("scout", "main", "classify", Schema, OPTIONS);
    expect(replayed.recording).toEqual({
      recordedAt: "2026-03-01T10:00:00.000Z",
      commit: "abc123def456",
    });

    // Written before provenance was kept, or with values that are not one: unknown, not made up.
    const { recordedAt: _at, commit: _commit, ...older } = entry;
    writeFileSync(path, JSON.stringify(older));
    expect((await replayer.invoke("scout", "main", "classify", Schema, OPTIONS)).recording).toEqual(
      { recordedAt: null, commit: null },
    );
    writeFileSync(path, JSON.stringify({ ...older, recordedAt: "yesterday", commit: " " }));
    expect((await replayer.invoke("scout", "main", "classify", Schema, OPTIONS)).recording).toEqual(
      { recordedAt: null, commit: null },
    );
  });

  it("records a null commit when the checkout's cannot be read", async () => {
    const net = answer({ summary: "s", count: 1 });
    const commit = vi.fn(() => null);
    const recorder = createLlm({
      settings: settings("record"),
      fetch: net.fetch,
      recordUsage: () => {},
      commit,
    });
    await recorder.invoke("scout", "main", "classify", Schema, OPTIONS);
    await recorder.invoke("scout", "fast", "classify", Schema, OPTIONS);
    for (const file of readdirSync(join(dir, "cassettes"))) {
      const entry = JSON.parse(readFileSync(join(dir, "cassettes", file), "utf8"));
      expect(entry.commit).toBeNull();
      expect(Number.isNaN(Date.parse(entry.recordedAt))).toBe(false);
    }
    // Read once per session.
    expect(commit).toHaveBeenCalledTimes(1);
  });
});

describe("cassette key", () => {
  const base = {
    tier: "main" as const,
    deployment: "gpt-6-luna",
    schemaName: "ComposerOutput",
    jsonSchema: { type: "object" },
    reasoningEffort: "low",
    maxOutputTokens: 4000,
  };

  it("drops message ids and metadata, timestamps, the run id and line-ending differences", () => {
    const a = [
      { role: "user", content: "Run abc-123 at 2026-10-21T10:00:00.123Z\r\n", id: "msg_1" },
    ] as unknown as LlmMessage[];
    const b = [
      { role: "user", content: "  Run xyz-789 at 2026-11-02 07:15:00+02:00\n", id: "msg_2" },
    ] as unknown as LlmMessage[];
    expect(cassetteKey({ ...base, messages: a, volatile: ["abc-123"] })).toBe(
      cassetteKey({ ...base, messages: b, volatile: ["xyz-789"] }),
    );
    expect(normaliseMessages(a, ["abc-123"])).toEqual([
      { role: "user", content: "Run <id> at <timestamp>" },
    ]);
  });

  it("keeps everything that changes the answer: text, role, tier, deployment, schema", () => {
    const messages: LlmMessage[] = [{ role: "user", content: "Ice Ice Baby" }];
    const key = cassetteKey({ ...base, messages });
    expect(
      cassetteKey({ ...base, messages: [{ role: "user", content: "Under Pressure" }] }),
    ).not.toBe(key);
    expect(
      cassetteKey({ ...base, messages: [{ role: "system", content: "Ice Ice Baby" }] }),
    ).not.toBe(key);
    expect(cassetteKey({ ...base, tier: "fast", messages })).not.toBe(key);
    expect(cassetteKey({ ...base, deployment: "gpt-6-sol", messages })).not.toBe(key);
    expect(cassetteKey({ ...base, schemaName: "JudgeOutput", messages })).not.toBe(key);
  });

  it("changes with the JSON Schema sent, the reasoning effort and the output budget", () => {
    const messages: LlmMessage[] = [{ role: "user", content: "Ice Ice Baby" }];
    const key = cassetteKey({ ...base, messages });
    expect(
      cassetteKey({ ...base, messages, jsonSchema: { type: "object", description: "changed" } }),
    ).not.toBe(key);
    expect(cassetteKey({ ...base, messages, reasoningEffort: "medium" })).not.toBe(key);
    expect(cassetteKey({ ...base, messages, maxOutputTokens: 8000 })).not.toBe(key);
  });

  it("keeps ids that identify the music (MBIDs, Spotify ids, ISRCs) and dates without a time", () => {
    const mbid = "0b52ae1b-5bd1-4d1a-9d5c-8b8f4a6c2d11";
    const text = `recording ${mbid} isrc USSM18900468 spotify 3Bvm6HIJ1n8yuJ3GmkSZBa released 1990-09-10`;
    expect(normaliseMessages([{ role: "user", content: text }])[0].content).toBe(text);
  });
});

describe("secrets", () => {
  it("never writes the API key or an auth header to a cassette", async () => {
    const env = { AZURE_OPENAI_API_KEY: FAKE_API_KEY, SOME_SERVICE_TOKEN: "tok-fake-1234567890" };
    const net = answer({ summary: `echo ${FAKE_API_KEY}`, count: 1 });
    const recorder = createLlm({
      settings: settings("record"),
      fetch: net.fetch,
      recordUsage: () => {},
      env,
    });
    await recorder.invoke(
      "composer",
      "main",
      `key ${FAKE_API_KEY} token tok-fake-1234567890 header Authorization: Bearer abcdefghijklmnop1234`,
      Schema,
      OPTIONS,
    );
    // The request itself carried the key in its auth header (that is how it authenticates)…
    expect(net.calls[0].headers.authorization).toBe(`Bearer ${FAKE_API_KEY}`);
    // …and none of it reaches the cassette.
    const [file] = readdirSync(join(dir, "cassettes"));
    const text = readFileSync(join(dir, "cassettes", file), "utf8");
    expect(text).not.toContain(FAKE_API_KEY);
    expect(text).not.toContain("tok-fake-1234567890");
    expect(text).not.toContain("abcdefghijklmnop1234");
    expect(text.toLowerCase()).not.toContain("authorization: bearer a");
    expect(text).toContain("[redacted]");
  });

  it("scrubs the key as the client sends it, trimmed, even with stray whitespace in the env", async () => {
    const key = "abcdef0123456789abcdef0123456789";
    expect(
      scrubSecrets(`echo ${key} here`, knownSecrets({ AZURE_OPENAI_API_KEY: ` ${key}\n` })),
    ).toBe("echo [redacted] here");
    const path = await writeCassette(
      join(dir, "c"),
      {
        version: 1,
        key: "k".repeat(64),
        tier: "fast",
        deployment: "d",
        schemaName: "Ok",
        messages: [{ role: "user", content: `the key is ${key}` }],
        output: { ok: true },
        usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: null },
      },
      [],
      key,
    );
    expect(readFileSync(path, "utf8")).not.toContain(key);
  });

  it("scrubs nested values, known secrets first and token shapes after", () => {
    const scrubbed = scrubSecrets(
      {
        a: ["x my-secret-value y"],
        b: { c: "api_key=abc123def456", d: 3 },
        e: "sk-abcdefghijklmnopqrstu",
      },
      ["my-secret-value"],
    );
    expect(scrubbed).toEqual({
      a: ["x [redacted] y"],
      b: { c: "api_key=[redacted]", d: 3 },
      e: "sk-[redacted]",
    });
  });
});
