/**
 * Price table per Azure deployment, in USD per 1M tokens, used to estimate what a call costs
 * before it runs (the reservation) and after (the settled amount).
 *
 * Prices come from the Azure Retail Prices API (public, no credentials), region eastus2, the
 * short-context meters (input up to SHORT_CONTEXT_MAX_INPUT_TOKENS tokens). Where Global and
 * Data Zone Standard differ, the higher (Data Zone) price is used, since the app cannot tell how
 * a deployment was created. Reasoning tokens are billed as output tokens.
 *
 * A deployment without a public price (an env override naming another deployment) is counted
 * at the fallback planning prices (USD 10 / 40 per 1M) times UNSOURCED_PRICE_MULTIPLIER, and the
 * multiplier is written on every spend-log line, so an estimate is never mistaken for a price.
 */

export interface PriceSource {
  url: string;
  /** Date the price was read (YYYY-MM-DD). */
  checked: string;
  /** The meter names the input and output prices were read from. */
  meter: { input: string; output: string };
}

export interface Price {
  inputPer1M: number;
  outputPer1M: number;
  /** Null when no public price was found for the deployment. */
  source: PriceSource | null;
}

/** A price as applied to a call: the multiplier is 1 for a sourced price. */
export interface AppliedPrice extends Price {
  deployment: string;
  multiplier: number;
}

/** Input above this many tokens is billed at the long-context rate, which is not tabled here. */
export const SHORT_CONTEXT_MAX_INPUT_TOKENS = 272_000;

/** Safety factor for a deployment priced at the fallback prices instead of a sourced price. */
export const UNSOURCED_PRICE_MULTIPLIER = 1.5;

/** Planning prices for a deployment with no public price (before the multiplier). */
export const FALLBACK_PRICE: Price = { inputPer1M: 10, outputPer1M: 40, source: null };

const RETAIL_PRICES_URL =
  "https://prices.azure.com/api/retail/prices?$filter=serviceName eq 'Foundry Models' and armRegionName eq 'eastus2'";

export const PRICES: Readonly<Record<string, Price>> = {
  "gpt-6-sol": {
    inputPer1M: 2.2,
    outputPer1M: 11,
    source: {
      url: RETAIL_PRICES_URL,
      checked: "2026-10-21",
      meter: {
        input: "6-sol ShortCo Inp Std DZ 1M Tokens",
        output: "6-sol ShortCo Opt Std DZ 1M Tokens",
      },
    },
  },
  "gpt-6-luna": {
    inputPer1M: 0.11,
    outputPer1M: 0.55,
    source: {
      url: RETAIL_PRICES_URL,
      checked: "2026-10-21",
      meter: {
        input: "6-luna ShortCo Inp Std DZ 1M Tokens",
        output: "6-luna ShortCo Opt Std DZ 1M Tokens",
      },
    },
  },
  "gpt-5.6-terra": {
    inputPer1M: 2.2,
    outputPer1M: 13.2,
    source: {
      url: RETAIL_PRICES_URL,
      checked: "2026-10-21",
      meter: {
        input: "5.6 terra ShortCo Inp Std DZ 1M Tokens",
        output: "5.6 terra ShortCo Opt Std DZ 1M Tokens",
      },
    },
  },
};

/** The price applied to a deployment: its sourced price, or the fallback prices × 1.5. */
export function priceFor(
  deployment: string,
  table: Readonly<Record<string, Price>> = PRICES,
): AppliedPrice {
  const price = Object.hasOwn(table, deployment) ? table[deployment] : FALLBACK_PRICE;
  return {
    ...price,
    deployment,
    multiplier: price.source ? 1 : UNSOURCED_PRICE_MULTIPLIER,
  };
}

/** USD for a number of input and output tokens (output including reasoning), multiplier applied. */
export function costUsd(price: AppliedPrice, inputTokens: number, outputTokens: number): number {
  const usd =
    ((inputTokens * price.inputPer1M + outputTokens * price.outputPer1M) / 1_000_000) *
    price.multiplier;
  // Rounded up to a micro-dollar, which keeps lines short; the tolerance stops float noise
  // (0.075 computed as 0.07500000000000001) from adding a micro-dollar.
  // Math.max also turns a -0 (from a zero cost) into 0.
  return Math.max(0, Math.ceil(usd * 1_000_000 - 1e-6) / 1_000_000);
}
