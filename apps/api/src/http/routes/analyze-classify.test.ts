/**
 * How the analyze route reads why a run failed: from the scout's typed outcome
 * (`scoutFailure`), never from the error text.
 */

import { describe, expect, it } from "vitest";
import { failureOf } from "./analyze.js";

describe("failureOf", () => {
  it.each([
    [{ kind: "no_match" }, "no_match"],
    [{ kind: "upstream_unavailable" }, "upstream_unavailable"],
    [{ kind: "rate_limited", retryAfterMs: 30_000 }, "upstream_unavailable"],
    [{ kind: "rate_limited", retryAfterMs: null }, "upstream_unavailable"],
  ] as const)("the scout's outcome %j is %s", (scoutFailure, code) => {
    expect(failureOf("scout", { scoutFailure })).toBe(code);
  });

  it("reads no text: a scout error without a typed outcome is a plain failure", () => {
    // The texts the route used to match.
    for (const error of ["No tracks found", "Error: spotify: HTTP 503", "Scout error: x"]) {
      expect(failureOf("scout", { error } as never)).toBe("failed");
    }
  });

  it("an error from another node is a plain failure", () => {
    expect(failureOf("historian", { scoutFailure: { kind: "no_match" } })).toBe("failed");
    expect(failureOf("composer", {})).toBe("failed");
  });
});
