// Run records (lib/score.mjs documents their shape) from one analysis as the API streamed it.
//
// One live analysis gives three records, each a row of the ablation table, all from the same
// stream, so (b) and (c) cost nothing more:
//
//   d  after the verifier, what the UI shows: the result's claims, and its relations shown as
//      documented, that is the genealogy links whose kind is `sourced` (code-built ones and model
//      ones whose own claim the judge found supported). A model link the verifier did not source
//      is drawn as a possible relation, labelled model inference: it is not an edge of row d.
//   c  before the verifier: every relation link the run proposed, sourced or not, and every claim
//      the run wrote (the stream's claim events and the result's), with the judge's verdicts.
//   b  deterministic only: the code-built links and claims, sourced by construction.
//
// Only links between the analysed track and another node are edges: `uses` when the track is the
// later work (the link's target), `usedBy` when it is the earlier one. Producer and influence
// links are not relations gold scores.

import { EDGE_RELATIONS } from "./score.mjs";

const CONTROL = /\p{Cc}/gu;
const clean = (text) => String(text ?? "").replace(CONTROL, " ");

/** A genealogy node's title and artist: its own fields, else its "Title - Artist" label. */
function nodeTarget(node) {
  let title = node.trackTitle ?? null;
  let artist = node.trackArtist ?? null;
  if (title === null || artist === null) {
    const label = String(node.label ?? "").replace(/\s*\(\d{4}\)\s*$/, "");
    const at = label.lastIndexOf(" - ");
    if (at > 0) {
      title ??= label.slice(0, at);
      artist ??= label.slice(at + 3);
    } else title ??= label;
  }
  return {
    title: clean(title),
    artist: clean(artist ?? ""),
    ...(node.mbid ? { mbid: node.mbid } : {}),
  };
}

/** The analysis's relation links as edges, with each link's kind and origin. */
export function edgesOf(analysis) {
  const nodes = new Map((analysis?.genealogy?.nodes ?? []).map((n) => [n.id, n]));
  const edges = [];
  for (const link of analysis?.genealogy?.links ?? []) {
    if (!EDGE_RELATIONS.includes(link.type)) continue;
    let direction;
    let other;
    if (link.target === "current" && link.source !== "current") {
      direction = "uses";
      other = link.source;
    } else if (link.source === "current" && link.target !== "current") {
      direction = "usedBy";
      other = link.target;
    } else continue;
    const node = nodes.get(other);
    if (!node) continue;
    edges.push({
      direction,
      relation: link.type,
      origin: link.origin === "code" ? "code" : "model",
      kind: link.kind ?? null,
      target: nodeTarget(node),
      evidenceIds: link.evidenceIds ?? [],
    });
  }
  return edges;
}

const claimOf = (c) => ({
  id: c.id,
  text: c.text,
  about: c.about ?? null,
  origin: c.origin === "code" ? "code" : "model",
  kind: c.kind ?? null,
  verdict: c.verdict ?? null,
  evidenceIds: c.evidenceIds ?? [],
});

/**
 * Every claim the run wrote: the latest claim event for each id (a verdict change is a later
 * event), then the result's claims that no event carried. A claim the verifier left out of the
 * result as a restatement is still here.
 */
export function claimsBeforeVerifier(events, analysis) {
  const byId = new Map();
  for (const e of events) if (e.type === "claim" && e.claim?.id) byId.set(e.claim.id, e.claim);
  for (const c of analysis?.claims ?? []) if (!byId.has(c.id)) byId.set(c.id, c);
  return [...byId.values()].map(claimOf);
}

/** The spend lines of one run, as the run record keeps them: settled calls, or open reservations. */
export function callsOf(lines, runId) {
  const mine = lines.filter((l) => l.runId === runId);
  const settled = new Set(mine.filter((l) => l.kind === "settle").map((l) => l.id));
  return mine
    .filter((l) => l.kind === "settle" || (l.kind === "reserve" && !settled.has(l.id)))
    .map((l) => ({
      callSite: l.callSite ?? null,
      tier: l.tier ?? null,
      deployment: l.deployment,
      kind: l.kind,
      inputTokens: l.in,
      outputTokens: l.out,
      usd: l.usd_est,
      status: l.status ?? null,
      purpose: l.unit,
    }));
}

/**
 * The records of one analysis: { d, c, b }. `row` is the golden row, `result` what lib/api.mjs
 * `analyse` returned (or { error } when the stream could not be read), `contractCheck(events,
 * analysis)` true when every event and the result fit the contract.
 */
export function recordsOf({
  row,
  query,
  result,
  repeat,
  commit,
  recordedAt,
  calls,
  contractCheck,
}) {
  const events = result.events ?? [];
  const runId = result.runId ?? null;
  const complete = events.findLast((e) => e.type === "complete");
  const errors = events.filter((e) => e.type === "error").map((e) => e.code);
  const analysis = complete?.data ?? null;
  const current = analysis?.genealogy?.nodes?.find((n) => n.id === "current");
  const run = analysis?.run ?? null;
  const base = {
    version: 1,
    runId,
    isrc: row.isrc,
    title: row.title,
    artist: row.artist,
    query,
    repeat,
    commit,
    recordedAt,
    outcome: analysis
      ? "complete"
      : result.error
        ? `failed: ${result.error}`
        : `error: ${errors.join(", ") || "no result"}`,
    identity: analysis
      ? {
          isrc: analysis.isrc ?? null,
          mbid: current?.mbid ?? null,
          spotifyId: analysis.id ?? null,
          title: analysis.title,
          artist: analysis.artist,
        }
      : null,
    clarification: {
      fired: result.resumed !== null && result.resumed !== undefined,
      answer: "top-ranked",
      ...(result.resumed ? result.resumed : {}),
    },
    preview: analysis
      ? {
          available: analysis.preview != null,
          provider: analysis.preview?.provider ?? null,
          method: analysis.preview?.method ?? null,
        }
      : null,
    audio: analysis
      ? {
          measured: analysis.audioSource === "analyzed",
          unavailableReason: analysis.audioUnavailableReason ?? null,
          analyzerVersion: run?.analyzerVersion ?? null,
          tempoBpm: analysis.audio?.tempo?.bpm ?? null,
        }
      : null,
    evidence: (analysis?.evidence ?? []).map((e) => ({
      id: e.id,
      source: e.source,
      url: e.url,
      excerpt: e.excerpt,
    })),
    sourceErrors: (run?.sourceErrors ?? []).map((s) => ({ source: s.source, code: s.code })),
    verifier: run?.verifier ?? null,
    schemaValid: analysis !== null && contractCheck(events, analysis),
    fallback: run?.fallback === true,
  };
  const all = edgesOf(analysis);
  const usage = run?.usage
    ? {
        llmCalls: run.usage.llmCalls,
        inputTokens: run.usage.inputTokens,
        outputTokens: run.usage.outputTokens,
        reasoningTokens: run.usage.reasoningTokens ?? null,
        usd: run.usage.usd,
      }
    : null;
  const d = {
    ...base,
    ablation: "d",
    edges: all.filter((e) => e.kind === "sourced"),
    claims: (analysis?.claims ?? []).map(claimOf),
    latencyMs: complete?.elapsedMs ?? null,
    usage,
    calls,
  };
  const c = {
    ...base,
    ablation: "c",
    edges: all,
    claims: claimsBeforeVerifier(events, analysis),
  };
  const b = {
    ...base,
    ablation: "b",
    edges: all.filter((e) => e.origin === "code" && e.kind === "sourced"),
    claims: (analysis?.claims ?? []).filter((x) => x.origin === "code").map(claimOf),
  };
  return { d, c, b };
}

/**
 * What a replay must reproduce of a record: everything but the run's id, times, cost, the spend
 * lines and claim ids (new ids each run). Lists are sorted, so their order does not matter.
 */
export function comparable(record) {
  const sorted = (xs) => [...xs].sort();
  return {
    ablation: record.ablation,
    isrc: record.isrc,
    outcome: record.outcome,
    identity: record.identity,
    clarification: record.clarification,
    audio: record.audio,
    evidence: sorted(record.evidence.map((e) => JSON.stringify([e.id, e.url, e.excerpt]))),
    edges: sorted(
      record.edges.map((e) =>
        JSON.stringify([e.direction, e.relation, e.origin, e.kind, e.target, e.evidenceIds]),
      ),
    ),
    claims: sorted(
      record.claims.map((c) =>
        JSON.stringify([c.text, c.about, c.origin, c.kind, c.verdict, c.evidenceIds]),
      ),
    ),
    sourceErrors: sorted(record.sourceErrors.map((s) => `${s.source}:${s.code}`)),
    schemaValid: record.schemaValid,
    fallback: record.fallback,
  };
}

/** The fields where two records differ (by comparable()), or [] when they agree. */
export function differences(recorded, replayed) {
  const a = comparable(recorded);
  const b = comparable(replayed);
  return Object.keys(a).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}
