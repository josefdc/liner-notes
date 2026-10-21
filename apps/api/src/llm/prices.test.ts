import { describe, expect, it } from "vitest";
import { DEFAULT_DEPLOYMENTS } from "../config/settings.js";
import {
  FALLBACK_PRICE,
  costUsd,
  type Price,
  PRICES,
  priceFor,
  UNSOURCED_PRICE_MULTIPLIER,
} from "./prices.js";

describe("price table", () => {
  it("has a sourced price for every default deployment", () => {
    for (const deployment of Object.values(DEFAULT_DEPLOYMENTS)) {
      const price = priceFor(deployment);
      expect(price.source, deployment).not.toBeNull();
      expect(price.source?.url).toMatch(/^https:\/\/prices\.azure\.com\/api\/retail\/prices\?/);
      expect(price.source?.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(price.multiplier).toBe(1);
    }
  });

  it("records the Data Zone short-context prices per 1M tokens", () => {
    expect(PRICES["gpt-6-sol"]).toMatchObject({ inputPer1M: 2.2, outputPer1M: 11 });
    expect(PRICES["gpt-6-luna"]).toMatchObject({ inputPer1M: 0.11, outputPer1M: 0.55 });
    expect(PRICES["gpt-5.6-terra"]).toMatchObject({ inputPer1M: 2.2, outputPer1M: 13.2 });
  });

  it("prices an unknown deployment at the fallback prices with the 1.5× multiplier", () => {
    const price = priceFor("someone-elses-deployment");
    expect(price).toMatchObject({ inputPer1M: 10, outputPer1M: 40, source: null, multiplier: 1.5 });
    expect(UNSOURCED_PRICE_MULTIPLIER).toBe(1.5);
    // Not fooled by inherited object keys.
    expect(priceFor("constructor").multiplier).toBe(1.5);
  });

  it("applies the multiplier to an entry with no source", () => {
    const table: Record<string, Price> = {
      custom: { inputPer1M: 1, outputPer1M: 2, source: null },
    };
    const price = priceFor("custom", table);
    expect(price.multiplier).toBe(1.5);
    // (1,000,000 × 1 + 1,000,000 × 2) / 1e6 × 1.5
    expect(costUsd(price, 1_000_000, 1_000_000)).toBe(4.5);
  });

  it("computes cost from input and output tokens, rounded up to a micro-dollar", () => {
    const sol = priceFor("gpt-6-sol");
    expect(costUsd(sol, 1_000_000, 0)).toBe(2.2);
    expect(costUsd(sol, 0, 1_000_000)).toBe(11);
    expect(costUsd(sol, 1, 0)).toBe(0.000003);
    // (1000 × 10 + 1000 × 40) / 1e6 × 1.5 = 0.075 exactly, not 0.075001
    expect(FALLBACK_PRICE).toMatchObject({ inputPer1M: 10, outputPer1M: 40 });
    expect(costUsd(priceFor("unknown"), 1000, 1000)).toBe(0.075);
  });
});
