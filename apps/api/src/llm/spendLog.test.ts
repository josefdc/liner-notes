import { describe, expect, it } from "vitest";
import { parseSpendLog, summarise } from "./spendLog.js";

const NOW = new Date("2026-10-21T12:00:00Z");
const line = (fields: Record<string, unknown>) =>
  JSON.stringify({
    ts: "2026-10-21T10:00:00Z",
    deployment: "gpt-6-sol",
    in: 0,
    out: 0,
    unit: "dev",
    ...fields,
  });

describe("summarise", () => {
  it("counts a settle line in place of its reservation, and open reservations in full", () => {
    const text = [
      line({ kind: "reserve", id: "a", usd_est: 0.5 }),
      line({ kind: "settle", id: "a", usd_est: 0.1 }),
      line({ kind: "reserve", id: "b", usd_est: 0.3 }),
      "",
    ].join("\n");
    const totals = summarise(parseSpendLog(text), NOW);
    expect(totals.totalUsd).toBeCloseTo(0.4, 9);
    expect(totals.openReservations).toBe(1);
  });

  it("counts a line without kind (written by hand) as settled spending", () => {
    const totals = summarise(parseSpendLog(`${line({ usd_est: 1.25 })}\n`), NOW);
    expect(totals.totalUsd).toBe(1.25);
    expect(totals.openReservations).toBe(0);
  });

  it("sums today's lines (UTC) and each unit separately", () => {
    const text = [
      line({ usd_est: 1, ts: "2026-10-20T23:59:59Z" }),
      line({ usd_est: 2, unit: "eval:golden" }),
      line({ usd_est: 4, unit: "eval:golden", ts: "2026-10-21T00:00:00Z" }),
    ].join("\n");
    const totals = summarise(parseSpendLog(text), NOW);
    expect(totals).toMatchObject({
      totalUsd: 7,
      todayUsd: 6,
      byUnitUsd: { dev: 1, "eval:golden": 6 },
    });
  });
});

describe("parseSpendLog", () => {
  it.each([
    ["not JSON", "{oops", "not JSON"],
    ["an array", "[1]", "not an object"],
    ["a missing amount", JSON.stringify({ ts: "2026-10-21T00:00:00Z" }), "usd_est"],
    ["a negative amount", JSON.stringify({ ts: "2026-10-21T00:00:00Z", usd_est: -1 }), "usd_est"],
    ["a bad date", JSON.stringify({ ts: "yesterday", usd_est: 1 }), "ts"],
    [
      "an unknown kind",
      JSON.stringify({ ts: "2026-10-21T00:00:00Z", usd_est: 1, kind: "x", id: "a" }),
      "kind",
    ],
    [
      "a reservation without id",
      JSON.stringify({ ts: "2026-10-21T00:00:00Z", usd_est: 1, kind: "reserve" }),
      "id",
    ],
  ])("rejects %s, naming the line", (_name, bad, why) => {
    const text = `${line({ usd_est: 1 })}\n${bad}\n`;
    expect(() => parseSpendLog(text)).toThrow(`line 2`);
    expect(() => parseSpendLog(text)).toThrow(why);
  });

  it("rejects a torn last line instead of guessing", () => {
    expect(() => parseSpendLog(`${line({ usd_est: 1 })}\n{"ts":"2026-10-21T`)).toThrow("line 2");
  });

  it("skips blank lines", () => {
    expect(parseSpendLog(`\n${line({ usd_est: 1 })}\n\n`)).toHaveLength(1);
  });
});
