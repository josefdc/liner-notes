// What the agent eval report adds to the edge metrics, from the same run records: the models each
// row ran on, tokens and cost per model tier, the sources the runs could not read, the claims each
// row shows as sourced, and the verifier as a classifier on the perturbation set (from the judge
// records kept beside the run records, in <runs>/perturb/). Pure: records in, counts out.

import { existsSync, readdirSync, readFileSync } from "node:fs";
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

/**
 * Where a run-record directory keeps, per track, what its sources answered: the credentials the
 * recording ran without (the names its credentials.json lists, never a value) and, per source,
 * how many responses had each HTTP status (sources/<ISRC>.json, written by assemble.mjs from the
 * live run's source cassettes).
 */
export const SOURCES_DIR = "sources";

/** The credential each source of the records needs, by the source's name in sourceErrors. */
export const SOURCE_CREDENTIAL = {
  discogs: "DISCOGS_TOKEN",
  genius: "GENIUS_ACCESS_TOKEN",
  lastfm: "LASTFM_API_KEY",
  secondhandsongs: "SHS_API_KEY",
  tavily: "TAVILY_API_KEY",
};

/** One track's source summary from its source-cassette directory: names and counts only. */
export function sourceSummary(cassetteDir) {
  const statuses = {};
  let unset = [];
  for (const name of readdirSync(cassetteDir).sort()) {
    if (!name.endsWith(".json")) continue;
    const data = JSON.parse(readFileSync(join(cassetteDir, name), "utf8"));
    if (name === "credentials.json") {
      unset = sorted(data.unset ?? []);
      continue;
    }
    if (name === "audio.json") continue;
    const counts = {};
    for (const entry of Object.values(data.entries ?? {})) {
      const status = String(entry?.status ?? "none");
      counts[status] = (counts[status] ?? 0) + 1;
    }
    statuses[name.replace(/\.json$/, "")] = counts;
  }
  return { version: 1, unset, statuses };
}

/** The source summaries a run-record directory keeps, by ISRC (empty when it keeps none). */
export function readSourceSummaries(runsDir) {
  const dir = join(runsDir, SOURCES_DIR);
  const out = new Map();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    if (name.endsWith(".json")) {
      out.set(name.slice(0, -5), JSON.parse(readFileSync(join(dir, name), "utf8")));
    }
  }
  return out;
}

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
    baselineTiers: sorted(
      new Set(a.flatMap((r) => (r.calls ?? []).map((c) => `${c.tier} ${c.deployment}`))),
    ),
    // The pipeline's composer, the call row a stands in for.
    composerTiers: sorted(
      new Set(
        d.flatMap((r) =>
          (r.calls ?? [])
            .filter((c) => c.callSite === "composer")
            .map((c) => `${c.tier} ${c.deployment}`),
        ),
      ),
    ),
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
 * The sources row d's first runs could not read. A source with no credential configured
 * (`not_configured`) is not an error of the run and is listed apart. So is a source that ran
 * without its credential, as the source summaries record it (sources/<ISRC>.json): its errors
 * are counted, and the source-error rate is also given without them, with the statuses its
 * responses had.
 */
export function sourceErrors(runs, summaries = new Map()) {
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
  const summaryOf = (r) => summaries.get(r.isrc) ?? null;
  const covered = d.length > 0 && d.every((r) => summaryOf(r));
  const withoutCredential = covered
    ? Object.entries(SOURCE_CREDENTIAL)
        .filter(([source]) => !notConfigured.includes(source))
        .map(([source, credential]) => {
          const ran = d.filter((r) => summaryOf(r).unset.includes(credential));
          const statuses = {};
          for (const r of ran) {
            for (const [status, n] of Object.entries(summaryOf(r).statuses[source] ?? {})) {
              statuses[status] = (statuses[status] ?? 0) + n;
            }
          }
          return { source, credential, runs: ran.length, statuses };
        })
        .filter((x) => x.runs > 0)
    : [];
  const apart = new Set(withoutCredential.map((x) => x.source));
  return {
    any: rate(d.filter((r) => errorsOf(r).length > 0).length, d.length),
    withoutUncredentialed: apart.size
      ? rate(d.filter((r) => errorsOf(r).some((s) => !apart.has(s.source))).length, d.length)
      : null,
    bySource: keys.map((key) => ({
      key,
      ...rate(
        d.filter((r) => errorsOf(r).some((s) => `${s.source}: ${s.code}` === key)).length,
        d.length,
      ),
    })),
    notConfigured,
    withoutCredential,
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
