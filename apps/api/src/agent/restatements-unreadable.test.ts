/**
 * oneClaimPerFact when the relation templates cannot read one claim's text: that claim states
 * nothing, so it is kept, unmarked, and every other claim is read as ever. Its restatements
 * still go and their marks still show. The reader is made to fail on one text only.
 */

import type { Claim } from "@liner-notes/contract";
import { describe, expect, it, vi } from "vitest";
import { readRecording } from "../replay/testing/recordings.js";
import { oneClaimPerFact } from "./restatements.js";

/** A word only the claim the reader fails on holds. */
const UNREADABLE = "Unreadablemark";

vi.mock("./relationText.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./relationText.js")>();
  const failing =
    <A extends unknown[], R>(read: (text: string, ...rest: A) => R) =>
    (text: string, ...rest: A): R => {
      if (text.includes(UNREADABLE)) throw new Error("cannot read");
      return read(text, ...rest);
    };
  return {
    ...actual,
    readStatedRelations: failing(actual.readStatedRelations),
    readMarkedRelations: failing(actual.readMarkedRelations),
  };
});

describe("a claim the relation templates cannot read", () => {
  it("is kept, unmarked, and the others are read as ever", () => {
    const { analysis } = readRecording("bitter-sweet-symphony-the-verve");
    const sample = (analysis.claims ?? []).find((claim) => claim.id.startsWith("71a2da2e"));
    if (!sample) throw new Error("no sample claim");
    const unreadable: Claim = {
      ...sample,
      id: "m-unreadable",
      text: `${sample.text} ${UNREADABLE}.`,
    };
    const { result, restated } = oneClaimPerFact({
      ...analysis,
      claims: [...(analysis.claims ?? []), unreadable],
    });
    // The Coldplay cover's two restatements still go; the sample card is still marked.
    expect(restated).toBe(2);
    const kept = new Map((result.claims ?? []).map((claim) => [claim.id.slice(0, 8), claim]));
    expect(kept.has("f67d7102")).toBe(false);
    expect(kept.has("824ae39c")).toBe(false);
    expect(kept.get("71a2da2e")?.documentedBy?.map((id) => id.slice(0, 8))).toEqual(["103514e6"]);
    // The one it cannot read stays, as it came, with no mark.
    const left = (result.claims ?? []).find((claim) => claim.id === "m-unreadable");
    expect(left).toEqual(unreadable);
    expect(left?.documentedBy).toBeUndefined();
  });
});
