// What the agent eval report adds to the edge metrics, from the same run records: the models each
// row ran on, tokens and cost per model tier, the sources the runs could not read, the claims each
// row shows as sourced, and the verifier as a classifier on the perturbation set (from the judge
// records kept beside the run records, in <runs>/perturb/). Pure: records in, counts out.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { bootstrap, MIN_N_FOR_RATE, mean, wilson } from "./stats.mjs";

/** Where a run-record directory keeps its perturbation judge record and its hand audit. */
export const PERTURB_DIR = "perturb";
export const JUDGE_FILE = "judge.json";
export const AUDIT_FILE = "audit.json";

const rate = (k, n) => ({ k, n, value: n === 0 ? null : k / n, ci: wilson(k, n) });
const statOf = (values, f) => ({
  n: values.length,
  value: values.length ? f(values) : null,
  ci: values.length >= MIN_N_FOR_RATE ? bootstrap(values, f) : null,
  values: [...values],
});
const sorted = (xs) => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** The judge record and the audit of a run-record directory, or nulls when there are none. */
export function readPerturbRecords(runsDir) {
  const read = (name) => {
    const path = join(runsDir, PERTURB_DIR, name);
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  };
  return { judge: read(JUDGE_FILE), audit: read(AUDIT_FILE) };
}

/**
 * The deployments each part ran on, from the spend lines the records keep: the pipeline's
 * generators (every tier but the judge), its judge, and the model-only baseline (row a).
 */
export function models(runs) {
  const d = runs.filter((r) => r.ablation === "d");
  const a = runs.filter((r) => r.ablation === "a");
  const of = (rs, keep) =>
    sorted(new Set(rs.flatMap((r) => (r.calls ?? []).filter(keep).map((c) => c.deployment))));
  const generators = of(d, (c) => c.tier !== "judge");
  const judges = of(d, (c) => c.tier === "judge");
  return {
    generators,
    generatorTiers: sorted(
      new Set(
        d.flatMap((r) =>
          (r.calls ?? []).filter((c) => c.tier !== "judge").map((c) => `${c.tier} ${c.deployment}`),
        ),
      ),
    ),
    judges,
    baseline: of(a, () => true),
    judgeIsGenerator: judges.some((j) => generators.includes(j)),
  };
}

/** Tokens and USD per analysis for each model tier (row d, first runs), from the spend lines. */
export function perTier(runs) {
  const d = runs.filter((r) => r.ablation === "d" && (r.repeat ?? 0) === 0 && r.calls);
  const tiers = sorted(new Set(d.flatMap((r) => r.calls.map((c) => c.tier))));
  return tiers.map((tier) => {
    const per = d.map((r) => r.calls.filter((c) => c.tier === tier));
    return {
      tier,
      deployments: sorted(new Set(per.flat().map((c) => c.deployment))),
      calls: statOf(
        per.map((cs) => cs.length),
        mean,
      ),
      tokens: statOf(
        per.map((cs) => cs.reduce((s, c) => s + c.inputTokens + c.outputTokens, 0)),
        mean,
      ),
      usd: statOf(
        per.map((cs) => cs.reduce((s, c) => s + c.usd, 0)),
        mean,
      ),
    };
  });
}

/**
 * The sources the runs could not read (row d, first runs). A source with no credential set is
 * "not configured", which is the deployment's choice rather than an error, so it is counted
 * apart; the source-error rate is the share of runs with at least one other source error.
 */
export function sourceErrors(runs) {
  const d = runs.filter((r) => r.ablation === "d" && (r.repeat ?? 0) === 0);
  const errorsOf = (r) => (r.sourceErrors ?? []).filter((s) => s.code !== "not_configured");
  const keys = sorted(new Set(d.flatMap((r) => errorsOf(r).map((s) => `${s.source}: ${s.code}`))));
  const notConfigured = sorted(
    new Set(
      d.flatMap((r) =>
        (r.sourceErrors ?? []).filter((s) => s.code === "not_configured").map((s) => s.source),
      ),
    ),
  );
  return {
    any: rate(d.filter((r) => errorsOf(r).length > 0).length, d.length),
    bySource: keys.map((key) => ({
      key,
      ...rate(
        d.filter((r) => errorsOf(r).some((s) => `${s.source}: ${s.code}` === key)).length,
        d.length,
      ),
    })),
    notConfigured,
    failed: d
      .filter((r) => r.outcome !== "complete")
      .map((r) => ({ isrc: r.isrc, outcome: r.outcome })),
  };
}

/** Per ablation row, the claims shown as sourced (rows a, b and d; c is before the verifier). */
export function sourcedClaims(runs) {
  const out = {};
  for (const id of ["a", "b", "d"]) {
    const claims = runs
      .filter((r) => r.ablation === id && (r.repeat ?? 0) === 0)
      .flatMap((r) => r.claims ?? []);
    if (claims.length || runs.some((r) => r.ablation === id)) {
      out[id] = rate(claims.filter((c) => c.kind === "sourced").length, claims.length);
    }
  }
  return out;
}

/**
 * The verifier as a classifier on the claim cases: a case is rejected when the judge's verdict
 * does not show it as sourced (the app's rule, recorded per case). False-positive rate: positives
 * rejected; catch rate: mutations rejected. Both per positive source (a mutation counts under its
 * parent's source) and overall. A case the judge did not reach is counted apart, as rejected.
 */
export function classifier(judge) {
  if (!judge) return null;
  const cases = judge.cases;
  const rejected = (c) => c.shownAsSourced !== true;
  const sources = sorted(new Set(cases.map((c) => c.positiveSource)));
  const block = (xs) => ({
    falsePositive: rate(
      xs.filter((c) => c.label === "supported" && rejected(c)).length,
      xs.filter((c) => c.label === "supported").length,
    ),
    catch: rate(
      xs.filter((c) => c.label === "unsupported" && rejected(c)).length,
      xs.filter((c) => c.label === "unsupported").length,
    ),
  });
  const mutations = sorted(new Set(cases.filter((c) => c.mutation).map((c) => c.mutation)));
  return {
    cases: cases.length,
    unjudged: cases.filter((c) => c.verdict === null).length,
    verdicts: Object.fromEntries(
      sorted(new Set(cases.map((c) => String(c.verdict)))).map((v) => [
        v,
        cases.filter((c) => String(c.verdict) === v).length,
      ]),
    ),
    overall: block(cases),
    bySource: sources.map((source) => ({
      source,
      ...block(cases.filter((c) => c.positiveSource === source)),
    })),
    byMutation: mutations.map((m) => ({
      mutation: m,
      ...rate(
        cases.filter((c) => c.mutation === m && rejected(c)).length,
        cases.filter((c) => c.mutation === m).length,
      ),
    })),
    judge: judge.judge,
    perturb: judge.perturb,
    pool: judge.pool,
    commit: judge.commit,
    recordedAt: judge.recordedAt,
  };
}
