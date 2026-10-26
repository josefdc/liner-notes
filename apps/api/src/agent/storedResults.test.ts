/**
 * Stored results: served for 24 hours, and a result whose claims the verifier could not check
 * for an hour only, so a later run checks them.
 */

import { InMemoryStore } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { createEmptyTrackData } from "./schema.js";
import {
  readStoredResult,
  STORED_RESULT_TTL_MS,
  storeResult,
  UNCHECKED_RESULT_TTL_MS,
} from "./storedResults.js";

const at = new Date("2026-01-01T00:00:00.000Z");
const later = (ms: number) => new Date(at.getTime() + ms);

describe("stored results", () => {
  it("serve a checked result for 24 hours and an unchecked one for an hour", async () => {
    const store = new InMemoryStore();
    await storeResult(store, createEmptyTrackData("checked", "T", "A"), at);
    await storeResult(
      store,
      createEmptyTrackData("unchecked", "T", "A"),
      at,
      [],
      UNCHECKED_RESULT_TTL_MS,
    );

    expect(UNCHECKED_RESULT_TTL_MS).toBeLessThan(STORED_RESULT_TTL_MS);
    const served = async (id: string, ms: number) =>
      (await readStoredResult(store, id, later(ms))) !== null;
    expect(await served("checked", STORED_RESULT_TTL_MS - 1)).toBe(true);
    expect(await served("checked", STORED_RESULT_TTL_MS)).toBe(false);
    expect(await served("unchecked", UNCHECKED_RESULT_TTL_MS - 1)).toBe(true);
    expect(await served("unchecked", UNCHECKED_RESULT_TTL_MS)).toBe(false);
  });

  it("never serves a result past 24 hours, whatever lifetime it was stored with", async () => {
    const store = new InMemoryStore();
    await storeResult(
      store,
      createEmptyTrackData("long", "T", "A"),
      at,
      [],
      7 * STORED_RESULT_TTL_MS,
    );
    expect(await readStoredResult(store, "long", later(STORED_RESULT_TTL_MS))).toBeNull();
  });
});
