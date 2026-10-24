import { describe, expect, it } from "vitest";
import { recordCommit } from "./record.js";

describe("the commit a record names", () => {
  it("is the one the run ran at, whatever is checked out now", () => {
    expect(recordCommit({ stored: "aaa111", given: null, checkout: "aaa111" })).toEqual({
      commit: "aaa111",
    });
    const moved = recordCommit({ stored: "aaa111", given: null, checkout: "bbb222-dirty" });
    expect(moved).toMatchObject({ commit: "aaa111" });
    expect("warning" in moved && moved.warning).toMatch(/checkout is at bbb222-dirty/);
    expect(recordCommit({ stored: "aaa111", given: "aaa111", checkout: null })).toEqual({
      commit: "aaa111",
    });
  });

  it("refuses a --commit that contradicts the stored one", () => {
    expect(recordCommit({ stored: "aaa111", given: "bbb222", checkout: "bbb222" })).toMatchObject({
      refused: expect.stringMatching(/differs from the commit the run ran at \(aaa111\)/),
    });
  });

  it("takes only an explicit --commit for a run stored without one, never the checkout's", () => {
    expect(recordCommit({ stored: null, given: null, checkout: "bbb222" })).toMatchObject({
      refused: expect.stringMatching(/has no stored commit.*pass --commit/),
    });
    expect(recordCommit({ stored: null, given: "ccc333", checkout: "bbb222" })).toEqual({
      commit: "ccc333",
    });
  });
});
