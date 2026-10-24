/**
 * Builds a replay record (fixtures/replays/<slug>.json) from a stored live run: its result and
 * the events its streams sent (store/runs.ts). The record is what the API replays under
 * REPLAY_MODE, and it is committed, so it is scrubbed and then checked; anything doubtful is a
 * refusal, never a silent fix.
 *
 * Scrub, field by field of a TrackAnalysis (the generic source scrubber would drop required
 * fields such as `coverUrl` and the `preview` provenance):
 * - preview clips and image URLs: `previewUrl` is removed, any other string that is a preview
 *   or media URL is blanked (`coverUrl` becomes "", which the contract reads as unknown), and
 *   such URLs inside text are cut out;
 * - credentials: the configured key values and secret-shaped text are redacted;
 * - the query the user typed is replaced by the track's own "<title> <artist>";
 * - the run's id is replaced by `recorded-<slug>` (the player stamps each replay's own id).
 *
 * Refusals: a run that is not completed, has no stored result of its own, or was not live (a
 * replayed or cached result is not recorded again); a run whose last stream does not end with
 * `done` (a stream cut short) or has no single `complete`; a paused run whose streams are not
 * "connected … interrupt, done" then "resuming … complete, done" (a paused run's streams are
 * joined into one stream, numbered again from 0, without the pause); and a record that, after
 * the scrub, still holds a credential, a secret-shaped string, a preview or media URL or the
 * typed query, or fails the record's schema or says less than a replay must (`runIssues`).
 * The result's other producer checks (`analysisIssues`) are reported as warnings: live results
 * do not pass them all yet, and the record replays what was sent.
 */

import {
  type AnalyzeStreamEvent,
  analysisIssues,
  ReplayRecord,
  runIssues,
  TrackAnalysis,
} from "@liner-notes/contract";
import { scrubSecrets } from "../llm/cassette.js";
import { isMediaUrl } from "../sources/http.js";
import { isPreviewUrl, type RunRecord, type StoredRunEvent } from "../store/runs.js";

export class RecordRefused extends Error {
  constructor(readonly reasons: string[]) {
    super(`Not recorded:\n- ${reasons.join("\n- ")}`);
    this.name = "RecordRefused";
  }
}

export interface RecordOptions {
  slug: string;
  /** The commit of the code the run was made with. */
  commit: string;
  /** Credential values that must not appear in the record (see knownSecrets). */
  secrets: readonly string[];
}

const SLUG = /^[a-z0-9-]+$/;

/** The id a record gives its run; each replay replaces it with the new run's id. */
export const recordedRunId = (slug: string) => `recorded-${slug}`;

// =============================================================================
// Scrub
// =============================================================================

const URL_IN_TEXT = /(?:https?:)?\/\/[^\s"'<>()[\]{}]+/gi;

const isClipOrImage = (value: string) => isPreviewUrl(value) || isMediaUrl(value);

/** A string without preview or media URLs: blank when it is one, else with them cut out. */
function withoutMedia(text: string): string {
  if (isClipOrImage(text.trim())) return "";
  return text.replace(URL_IN_TEXT, (url) => (isClipOrImage(url) ? "" : url));
}

/** Escapes text for use in a regular expression. */
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A copy of `value` scrubbed for a record: no `previewUrl` field, no preview or media URL, the
 * run id and the typed query replaced, credentials redacted.
 */
export function scrubForRecord(
  value: unknown,
  replace: ReadonlyArray<readonly [RegExp, string]>,
  secrets: readonly string[],
): unknown {
  const walk = (item: unknown): unknown => {
    if (typeof item === "string") {
      let text = withoutMedia(item);
      for (const [pattern, replacement] of replace) text = text.replace(pattern, replacement);
      return text;
    }
    if (Array.isArray(item)) return item.map(walk);
    if (item === null || typeof item !== "object") return item;
    return Object.fromEntries(
      Object.entries(item)
        .filter(([key]) => key !== "previewUrl")
        .map(([key, inner]) => [key, walk(inner)]),
    );
  };
  return scrubSecrets(walk(value), secrets);
}

// =============================================================================
// Checks after the scrub
// =============================================================================

/** Text shaped like a credential, whatever its value. */
const SECRET_SHAPES: Array<[string, RegExp]> = [
  ["a bearer or basic credential", /\b(?:Bearer|Basic) [A-Za-z0-9._~+/=-]{12,}/],
  ["a key or token parameter", /\b(?:api[-_]?key|access_token|client_secret|token)\s*[:=]\s*\S/i],
  ["an OpenAI-style key", /\bsk-[A-Za-z0-9_-]{16,}/],
  ["a Tavily key", /\btvly-[A-Za-z0-9_-]{8,}/],
  ["a Spotify access token", /\bBQ[A-Za-z0-9_-]{40,}/],
  ["a JSON web token", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./],
  ["a private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["a signed URL", /[?&;~](?:hdnea|hdnts|x-amz-signature|sig|signature)=/i],
  [
    "a long token",
    /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])[A-Za-z0-9_-]{40,}\b/,
  ],
];

/** Every string in `value`, with its path. */
function strings(value: unknown, path = "", out: Array<[string, string]> = []) {
  if (typeof value === "string") out.push([path || "(record)", value]);
  else if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) strings(item, `${path}[${i}]`, out);
  } else if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      strings(inner, path ? `${path}.${key}` : key, out);
    }
  }
  return out;
}

/**
 * What a scrubbed record must not hold, by path (values are never echoed: they may be
 * credentials). `allowed` is text the record may hold although it contains the typed query (the
 * track's own title, artist and album).
 */
export function leaks(
  record: unknown,
  {
    secrets,
    typedQuery,
    allowed,
  }: { secrets: readonly string[]; typedQuery: string; allowed: string },
): string[] {
  const found: string[] = [];
  const typed = typedQuery.trim().toLowerCase();
  const typedIsPublic = typed === "" || allowed.toLowerCase().includes(typed);
  for (const [path, text] of strings(record)) {
    if (secrets.some((secret) => secret && text.includes(secret))) {
      found.push(`${path}: a configured credential`);
    }
    for (const [what, pattern] of SECRET_SHAPES) {
      if (pattern.test(text)) found.push(`${path}: ${what}`);
    }
    for (const url of text.match(URL_IN_TEXT) ?? []) {
      if (isPreviewUrl(url)) found.push(`${path}: a preview URL`);
      else if (isMediaUrl(url)) found.push(`${path}: an image or media URL`);
    }
    if (!typedIsPublic && text.toLowerCase().includes(typed)) {
      found.push(`${path}: the query the user typed`);
    }
  }
  return found;
}

// =============================================================================
// Streams
// =============================================================================

type Event = AnalyzeStreamEvent & { [field: string]: unknown };

/**
 * The run's stored streams as one stream: a paused run's first stream without its `interrupt`
 * and `done`, then the resume's stream without its `resuming`. Times are kept relative to the
 * start, without the time the run waited for the user.
 */
function joinStreams(events: StoredRunEvent[], refuse: (reason: string) => void) {
  const streams = new Map<number, StoredRunEvent[]>();
  for (const event of events) {
    const list = streams.get(event.stream) ?? [];
    list.push(event);
    streams.set(event.stream, list);
  }
  const numbers = [...streams.keys()].sort((a, b) => a - b);
  if (numbers.length === 0) {
    refuse("the run has no stored events");
    return [];
  }
  if (numbers.some((number, i) => number !== i)) {
    refuse(`the stored streams are ${numbers.join(", ")}, not numbered from 0 without gaps`);
    return [];
  }

  const joined: Array<{ atMs: number; event: Event }> = [];
  let offset = 0;
  numbers.forEach((number, index) => {
    const list = (streams.get(number) ?? []).sort((a, b) => a.seq - b.seq);
    const types = list.map((item) => (item.event as Event).type);
    const last = index === numbers.length - 1;
    if (list.some((item, i) => item.seq !== i)) {
      refuse(`stream ${number} has missing events (its seq does not run 0, 1, 2, ...)`);
      return;
    }
    if (types.at(-1) !== "done") {
      refuse(`stream ${number} does not end with done: it was cut short`);
      return;
    }
    const opening = index === 0 ? "connected" : "resuming";
    if (types[0] !== opening) {
      refuse(`stream ${number} starts with ${types[0]}, not ${opening}`);
      return;
    }
    if (last) {
      const completes = types.filter((type) => type === "complete").length;
      if (completes !== 1 || types.at(-2) !== "complete") {
        refuse(`the last stream does not end with one complete, then done (${types.join(", ")})`);
        return;
      }
    } else if (types.at(-2) !== "interrupt" || types.includes("complete")) {
      refuse(`stream ${number} is not a pause (interrupt, then done): ${types.join(", ")}`);
      return;
    }

    // Kept: everything but a pause's interrupt and done, and a resume's opening `resuming`.
    const kept = list.filter((_, i) => {
      if (!last && i >= list.length - 2) return false;
      if (index > 0 && i === 0) return false;
      return true;
    });
    const start = list[0].sentAt;
    for (const item of kept) {
      joined.push({ atMs: offset + Math.max(0, item.sentAt - start), event: item.event as Event });
    }
    offset = joined.at(-1)?.atMs ?? offset;
  });
  return joined;
}

// =============================================================================
// The record
// =============================================================================

export interface BuiltRecord {
  record: ReplayRecord;
  /**
   * Producer rules the recorded result breaks that live results also break today (it is
   * replayed as it was sent live); for the person recording to judge.
   */
  warnings: string[];
}

/**
 * The replay record of a stored run, scrubbed and checked. Throws RecordRefused with every
 * reason the run cannot be recorded.
 */
export function buildRecord(
  run: RunRecord,
  events: StoredRunEvent[],
  { slug, commit, secrets }: RecordOptions,
): BuiltRecord {
  const reasons: string[] = [];
  const refuse = (reason: string) => reasons.push(reason);
  const stop = () => {
    if (reasons.length > 0) throw new RecordRefused(reasons);
  };

  if (!SLUG.test(slug)) refuse(`slug "${slug}" is not lower-case letters, digits and '-'`);
  if (!commit.trim()) refuse("no commit");
  if (run.status !== "completed") refuse(`the run is ${run.status}, not completed`);
  if (run.mode !== "live") refuse(`the run's result is a ${run.mode}, not a live result`);
  const parsed = TrackAnalysis.safeParse(run.analysis);
  if (!parsed.success) refuse("the run has no stored result of its own that fits the contract");
  stop();
  const analysis = parsed.data as TrackAnalysis;
  if (!analysis.run || analysis.run.id !== run.runId) {
    refuse("the stored result does not name this run");
  } else if (analysis.run.mode !== "live") {
    refuse("the stored result says it is a replay (its model answers were replayed)");
  }
  const joined = joinStreams(events, refuse);
  stop();

  const runInfo = analysis.run as NonNullable<TrackAnalysis["run"]>;
  const completeEvent = events.find((item) => (item.event as Event).type === "complete");
  const recordedAt = new Date(
    completeEvent?.sentAt ?? (run.finishedAt ?? run.createdAt) * 1000,
  ).toISOString();
  const analyzerVersion = analysis.audio?.analyzerVersion ?? null;
  const placeholder = recordedRunId(slug);
  const curatedQuery = `${analysis.title} ${analysis.artist}`;

  const replace: Array<readonly [RegExp, string]> = [
    [new RegExp(literal(run.runId), "g"), placeholder],
    [new RegExp(literal(run.threadId), "g"), placeholder],
  ];
  const typed = run.query.trim();
  if (typed) replace.push([new RegExp(literal(typed), "gi"), curatedQuery]);

  const recordedAnalysis = scrubForRecord(
    {
      ...analysis,
      run: { ...runInfo, id: placeholder, mode: "replay", recordedAt, commit, analyzerVersion },
    },
    replace,
    secrets,
  ) as TrackAnalysis;

  const recordEvents = joined.map(({ atMs, event }, seq) => {
    const scrubbed = scrubForRecord(event, replace, secrets) as Event;
    const body = scrubbed.type === "complete" ? { ...scrubbed, data: recordedAnalysis } : scrubbed;
    return { atMs, event: { ...body, runId: placeholder, seq } };
  });

  const candidate = {
    version: 1,
    slug,
    request: {
      query: curatedQuery,
      selectedTrackId: events.some((e) => e.stream > 0) ? analysis.id : null,
    },
    recordedAt,
    commit,
    analyzerVersion,
    events: recordEvents,
    analysis: recordedAnalysis,
    usage: runInfo.usage ?? null,
  };

  const checked = ReplayRecord.safeParse(candidate);
  if (!checked.success) {
    for (const issue of checked.error.issues.slice(0, 10)) {
      refuse(`record ${issue.path.join(".") || "(record)"}: ${issue.message}`);
    }
    stop();
  }
  const record = checked.data as ReplayRecord;
  // A replay must say when and from which commit it was recorded: that is checked here. The
  // other producer rules are not yet met by live results either (they carry the measured copies
  // without the measurement they come from), so they are reported, not refused.
  const runInfoIssues = record.analysis.run
    ? runIssues(record.analysis.run, record.analysis.audio)
    : ["run: missing"];
  for (const issue of runInfoIssues) refuse(`result ${issue}`);
  const allowed = `${analysis.title} ${analysis.artist} ${analysis.album} ${curatedQuery}`;
  for (const leak of leaks(record, { secrets, typedQuery: typed, allowed })) refuse(leak);
  stop();
  const warnings = analysisIssues(record.analysis).filter(
    (issue) => !runInfoIssues.includes(issue),
  );
  return { record, warnings };
}
