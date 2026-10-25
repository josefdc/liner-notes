/**
 * Builds a replay record (fixtures/replays/<slug>.json) from a stored live run: its result and
 * the events its streams sent (store/runs.ts). The record is what the API replays under
 * REPLAY_MODE, and it is committed, so it is checked strictly; anything doubtful is a refusal.
 *
 * What was recorded is never rewritten: text the pipeline or the model wrote is kept as it was
 * sent. The record changes only what describes the recording rather than the content:
 * - fields that hold a preview clip or an image: `previewUrl` is removed, and an image field
 *   (`coverUrl`, `img`, `image…`, …) or any field whose whole value is a preview clip or a URL
 *   on an image host is blanked (`coverUrl` becomes "", which the contract reads as unknown).
 *   Preview URLs are signed and expire; Spotify, Deezer and Last.fm images are not ours to
 *   redistribute. The one image a record keeps is the result's cover from the Cover Art Archive
 *   (`archiveCoverOf`): its public link for the release the run's MusicBrainz evidence names,
 *   written into the result's `coverUrl` (in the record's result and its complete event) in
 *   place of whatever cover the run showed;
 * - the run's id in the envelope (`runId`, `threadId`, `run.id`) becomes `recorded-<slug>` (each
 *   replay stamps its own id);
 * - the stored query (what the user typed) is not kept: `request.query` is "<title> <artist>";
 * - status messages about the user's own actions in that run ("User confirmed …",
 *   "Remembered preference …") are left out: a viewer of the replay did neither.
 *
 * Refusals: a run that is not completed, has no stored result of its own, or was not live (a
 * replayed or cached result is not recorded again); a run whose last stream does not end with
 * `done` (a stream cut short) or has no single `complete`; a paused run whose streams are not
 * "connected … interrupt, done" then "resuming … complete, done" (a paused run's streams are
 * joined into one stream, numbered again from 0, without the pause); and a record that holds a
 * configured credential (also URL-encoded), a secret-shaped string, an e-mail address, a URL
 * outside the allow-listed source sites, a preview or media URL inside text (the Cover Art
 * Archive link `archiveCoverOf` derives is allowed as the result's cover only), the typed query
 * (when it is not the track's own title, artist or album; compared without case, accents,
 * punctuation or URL encoding), the id of a run (its own anywhere but the envelope, or any other
 * run the database knows; the ids sources use, such as MusicBrainz MBIDs, are content), or that
 * fails the record's schema or says less than a replay must (`runIssues`). The result's other
 * producer checks (`analysisIssues`) are reported as warnings: a run stored by older code may not
 * pass them all, and the record replays what was sent.
 */

import {
  type AnalyzeStreamEvent,
  analysisIssues,
  ReplayRecord,
  runIssues,
  TrackAnalysis,
} from "@liner-notes/contract";
import { isMediaUrl } from "../sources/http.js";
import { isPreviewUrl, type RunRecord, type StoredRunEvent } from "../store/runs.js";
import { ARCHIVE_FRONT, archiveCover } from "./cover.js";
import { normalizeQuery } from "./records.js";

export { archiveCover, archiveCoverOf } from "./cover.js";

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
  /** The ids of the database's other runs and threads, which must not appear either. */
  otherRunIds?: readonly string[];
}

const SLUG = /^[a-z0-9-]+$/;

/** The id a record gives its run; each replay replaces it with the new run's id. */
export const recordedRunId = (slug: string) => `recorded-${slug}`;

// =============================================================================
// Fields that describe the recording, not its content
// =============================================================================

const URL_IN_TEXT = /(?:https?:)?\/\/[^\s"'<>()[\]{}]+/gi;

/** Fields that hold an image, whatever their value. */
const IMAGE_KEY = /^(?:img|images?|imageUrl|cover(?:Url|Art)?|picture|thumbnail|artwork|avatar)$/i;

/** Hosts that serve images and audio (album art, artist photos, previews), not pages. */
const MEDIA_HOST =
  /(?:^|\.)(?:scdn\.co|dzcdn\.net|coverartarchive\.org|archive\.org|lastfm\.freetls\.fastly\.net|mzstatic\.com|ytimg\.com|ggpht\.com|googleusercontent\.com|upload\.wikimedia\.org)$/i;

/** True for a preview clip, or a URL on an image or audio host. */
function isClipOrMediaHost(value: string): boolean {
  if (isPreviewUrl(value)) return true;
  try {
    const url = new URL(value.startsWith("//") ? `https:${value}` : value);
    return ["http:", "https:"].includes(url.protocol) && MEDIA_HOST.test(url.hostname);
  } catch {
    return false;
  }
}

/**
 * A copy of `value` without preview and image fields: `previewUrl` removed, image fields
 * (by key) blanked, and any other field blanked only when its whole value is a preview clip or
 * a URL on an image or audio host. Nothing else changes: a source page whose path merely looks
 * like an image is kept (and checked by `leaks`).
 */
export function withoutMediaFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutMediaFields);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "previewUrl")
      .map(([key, inner]) => {
        if (typeof inner === "string") {
          return [key, IMAGE_KEY.test(key) || isClipOrMediaHost(inner.trim()) ? "" : inner];
        }
        return [key, withoutMediaFields(inner)];
      }),
  );
}

/** A status message about the user's own action in the recorded run. */
function isUserAction(event: { type: string; [field: string]: unknown }): boolean {
  if (event.type !== "status") return false;
  return (
    event.node === "clarification" ||
    /^(?:User confirmed|Remembered preference):/.test(String(event.message ?? ""))
  );
}

// =============================================================================
// Checks
// =============================================================================

/** Text shaped like a credential, whatever its value (allow-listed page URLs left out). */
const SECRET_SHAPES: Array<[string, RegExp]> = [
  ["a bearer or basic credential", /\b(?:Bearer|Basic) [A-Za-z0-9._~+/=-]{12,}/],
  ["a key or token parameter", /\b(?:api[-_]?key|access_token|client_secret|token)\s*[:=]\s*\S/i],
  ["an OpenAI-style key", /\bsk-[A-Za-z0-9_-]{16,}/],
  ["a Tavily key", /\btvly-[A-Za-z0-9_-]{8,}/],
  ["a Spotify access token", /\bBQ[A-Za-z0-9_-]{40,}/],
  ["a JSON web token", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./],
  ["a private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  [
    "a long token",
    /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])[A-Za-z0-9_-]{40,}\b/,
  ],
  ["an e-mail address", /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/],
];

/** A URL signed with an expiring token, on any host. */
const SIGNED_URL = /[?&;~](?:hdnea|hdnts|x-amz-signature|sig|signature)=/i;

/**
 * Sites a record may link to: the track's Spotify page and the sources the pipeline cites. Any
 * other URL (an image host this list does not know, a tracker, a signed link) is a refusal.
 */
const ALLOWED_URL_HOSTS = new Set([
  "open.spotify.com",
  "musicbrainz.org",
  "www.wikidata.org",
  "www.discogs.com",
  "discogs.com",
  "genius.com",
  "secondhandsongs.com",
  "www.last.fm",
  "last.fm",
  "listenbrainz.org",
  "www.whosampled.com",
]);
const WIKIPEDIA = /^[a-z-]+\.(?:m\.)?wikipedia\.org$/;

/** True for a page on an allow-listed site (not signed). */
function allowedUrl(url: string): boolean {
  if (SIGNED_URL.test(url)) return false;
  try {
    const { protocol, hostname } = new URL(url.startsWith("//") ? `https:${url}` : url);
    if (protocol !== "https:" && protocol !== "http:") return false;
    return ALLOWED_URL_HOSTS.has(hostname) || WIKIPEDIA.test(hostname);
  } catch {
    return false;
  }
}

/**
 * The pages a record's web-tier evidence links to (web search results cited by the run): any
 * site, but only a plain http(s) page that is not a preview, media or signed link, has no
 * credentials and whose path and query carry nothing shaped like a secret. These URLs, and their ids
 * (`tavily:<url>`), are content of the record; any other URL still has to be on an allow-listed
 * site.
 */
function webEvidencePages(value: unknown, pages = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) webEvidencePages(item, pages);
  } else if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    if (item.sourceTier === "web" && typeof item.url === "string" && plainWebPage(item.url)) {
      pages.add(item.url);
    }
    for (const inner of Object.values(item)) webEvidencePages(inner, pages);
  }
  return pages;
}

/**
 * A path segment shaped like a credential: a JSON web token, an "sk-"/"pk-" style key, 32 or
 * more hex characters, or 32 or more base64 characters without word structure (no separator
 * such as "-", "_" or ".", and letters and digits alternating throughout, as in random text). A
 * slug of words, Title-Case or not ("Why-was-Ice-Ice-Baby-so-popular-in-1990",
 * "IceIceBabyVanillaIce1990SingleRelease"), is a page name, not a token.
 */
function tokenSegment(segment: string): boolean {
  if (/^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./.test(segment)) return true;
  if (/^(?:sk|pk)[-_][A-Za-z0-9_-]{16,}$/.test(segment)) return true;
  if (/^[A-Fa-f0-9]{32,}$/.test(segment)) return true;
  if (!/^[A-Za-z0-9+/=]{32,}$/.test(segment)) return false;
  const alternations = segment.match(/[A-Za-z](?=\d)|\d(?=[A-Za-z])/g) ?? [];
  return alternations.length >= 4;
}

/** The secret shapes a page's path is scanned for; long runs are judged by `tokenSegment`. */
const PATH_SECRET_SHAPES = SECRET_SHAPES.filter(([what]) => what !== "a long token");

function plainWebPage(url: string): boolean {
  if (SIGNED_URL.test(url) || isPreviewUrl(url) || isMediaUrl(url)) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  if (parsed.username || parsed.password) return false;
  const scan = (text: string, shapes: Array<[string, RegExp]>) =>
    shapes.some(([, pattern]) => pattern.test(text) || pattern.test(decoded(text)));
  if (scan(`${parsed.search}${parsed.hash}`, SECRET_SHAPES)) return false;
  // The path is scanned too: a page link may carry a capability token or an address there.
  if (scan(parsed.pathname, PATH_SECRET_SHAPES)) return false;
  return !decoded(parsed.pathname).split("/").some(tokenSegment);
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** Keys of id fields: a source's ids (record refs, slugs) may be long and token-like. */
const ID_KEY = /^(?:id|recordRef)$|Ids?$/;

/** Every string in `value`, with its path and whether it is an id field's value. */
function strings(
  value: unknown,
  path = "",
  out: Array<{ path: string; text: string; isId: boolean }> = [],
  key = "",
) {
  if (typeof value === "string")
    out.push({ path: path || "(record)", text: value, isId: ID_KEY.test(key) });
  else if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) strings(item, `${path}[${i}]`, out, key);
  } else if (value && typeof value === "object") {
    for (const [name, inner] of Object.entries(value)) {
      strings(inner, path ? `${path}.${name}` : name, out, name);
    }
  }
  return out;
}

/** `text` with its URL encoding decoded (as it is, when it is not URL-encoded). */
function decoded(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, " "));
  } catch {
    return text;
  }
}

/** True when `phrase` (normalised) is a run of whole words of `text` (normalised). */
function containsWords(text: string, phrase: string): boolean {
  return ` ${normalizeQuery(text)} `.includes(` ${phrase} `);
}

export interface LeakCheck {
  secrets: readonly string[];
  /** What the user typed; refused unless it is part of one of `publicTexts`. */
  typedQuery: string;
  /** The track's own title, artist, album and their combinations. */
  publicTexts: readonly string[];
  /** The recorded run's own ids (run and thread), which the record replaces everywhere. */
  ownRunIds?: readonly string[];
  /** The ids of the other runs the database knows (runs and threads). */
  otherRunIds?: readonly string[];
  /**
   * The Cover Art Archive link the record keeps (`archiveCoverOf`): allowed as the whole value
   * of the result's cover (`analysis.coverUrl`) and of the complete event's
   * (`events[n].event.data.coverUrl`), and nowhere else.
   */
  allowedCover?: string;
}

/** The paths of the result's cover in a record: its result's, and its complete events'. */
function resultCoverPaths(record: unknown): Set<string> {
  const paths = new Set(["analysis.coverUrl"]);
  const events = (record as { events?: unknown } | null)?.events;
  if (Array.isArray(events)) {
    events.forEach((item, i) => {
      if ((item as { event?: { type?: unknown } } | null)?.event?.type === "complete") {
        paths.add(`events[${i}].event.data.coverUrl`);
      }
    });
  }
  return paths;
}

/**
 * What a record must not hold, by path (values are never echoed: they may be credentials).
 * Ids the record's sources use (MusicBrainz MBIDs in evidence ids, record refs and page URLs,
 * claim and evidence ids) are content; only the ids of runs are refused.
 */
export function leaks(
  record: unknown,
  {
    secrets,
    typedQuery,
    publicTexts,
    ownRunIds = [],
    otherRunIds = [],
    allowedCover = "",
  }: LeakCheck,
): string[] {
  const found: string[] = [];
  const typed = normalizeQuery(typedQuery);
  const typedIsPublic = typed === "" || publicTexts.some((text) => containsWords(text, typed));
  const others = new Set(otherRunIds.map((id) => id.toLowerCase()));
  // A URL found in text may stop short of the page's own (at a parenthesis, a quote).
  const pages = [...webEvidencePages(record)];
  const allowed = (url: string) =>
    allowedUrl(url) || pages.some((page) => page === url || page.startsWith(url));
  const cover = ARCHIVE_FRONT.test(allowedCover) ? allowedCover : null;
  const coverPaths = resultCoverPaths(record);
  for (const { path, text, isId } of strings(record)) {
    const plain = decoded(text);
    // The kept cover, as the whole value of the result's cover: an allowed link there only.
    const isCover = cover !== null && text === cover && coverPaths.has(path);
    const allowedHere = (url: string) => allowed(url) || (isCover && url === cover);
    if (
      secrets.some(
        (secret) => secret && (plain.includes(secret) || text.includes(encodeURIComponent(secret))),
      )
    ) {
      found.push(`${path}: a configured credential`);
    }
    // Secret shapes in the text around the URLs of allow-listed pages (long slugs and ids in
    // those are their own); an id field's value may be a long source id.
    const scanned = text.replace(URL_IN_TEXT, (url) => (allowedHere(url) ? " " : url));
    for (const [what, pattern] of SECRET_SHAPES) {
      if (isId && what === "a long token") continue;
      if (pattern.test(scanned) || pattern.test(decoded(scanned))) found.push(`${path}: ${what}`);
    }
    if (SIGNED_URL.test(text)) found.push(`${path}: a signed URL`);
    for (const url of text.match(URL_IN_TEXT) ?? []) {
      if (isPreviewUrl(url)) found.push(`${path}: a preview URL`);
      else if (allowedHere(url)) continue;
      else if (isMediaUrl(url)) found.push(`${path}: an image or media URL`);
      else found.push(`${path}: a URL outside the allow-listed sites`);
    }
    if (!typedIsPublic && (containsWords(text, typed) || containsWords(plain, typed))) {
      found.push(`${path}: the query the user typed`);
    }
    if (ownRunIds.some((id) => id && plain.includes(id))) {
      found.push(`${path}: the recorded run's own id`);
    }
    if ((plain.match(UUID) ?? []).some((uuid) => others.has(uuid.toLowerCase()))) {
      found.push(`${path}: another run's id`);
    }
  }
  return [...new Set(found)];
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
  /** Why the record keeps no cover (`archiveCover`); absent when it keeps one. */
  noCover?: string;
}

/** The texts that are the track's own: a query made of them reveals nothing about the user. */
export function publicTextsOf(analysis: { title: string; artist: string; album: string }) {
  const { title, artist, album } = analysis;
  return [
    title,
    artist,
    album,
    `${title} ${artist}`,
    `${artist} ${title}`,
    `${title} by ${artist}`,
  ];
}

/**
 * The replay record of a stored run, checked. Throws RecordRefused with every reason the run
 * cannot be recorded.
 */
export function buildRecord(
  run: RunRecord,
  events: StoredRunEvent[],
  { slug, commit, secrets, otherRunIds = [] }: RecordOptions,
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

  // How the recorded run's search text matched the track is left out: the record is replayed
  // for other texts, and the typed text is not kept.
  const { queryMatch: _match, ...recorded } = analysis;
  // Every image blanked, then the one cover a record keeps: the Cover Art Archive's.
  const { url: cover, reason: noCover } = archiveCover(analysis);
  const blanked = withoutMediaFields({
    ...recorded,
    run: {
      ...runInfo,
      id: placeholder,
      mode: "replay",
      replayed: "run",
      recordedAt,
      commit,
      analyzerVersion,
    },
  }) as TrackAnalysis;
  const recordedAnalysis: TrackAnalysis = { ...blanked, coverUrl: cover };

  const recordEvents = joined
    .filter(({ event }) => !isUserAction(event))
    .map(({ atMs, event }, seq) => {
      const body = withoutMediaFields(event) as Event;
      const envelope: Record<string, unknown> = { runId: placeholder, seq };
      if ("threadId" in body) envelope.threadId = placeholder;
      if (body.type === "complete") envelope.data = recordedAnalysis;
      return { atMs, event: { ...body, ...envelope } };
    });

  const candidate = {
    version: 1,
    slug,
    request: {
      query: `${analysis.title} ${analysis.artist}`,
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
  // other producer rules are reported, not refused: a run stored before results carried their
  // measurement (`audio`, agent/finalize.ts) has measured copies without it, and the record
  // replays what was sent.
  const runInfoIssues = record.analysis.run
    ? runIssues(record.analysis.run, record.analysis.audio)
    : ["run: missing"];
  for (const issue of runInfoIssues) refuse(`result ${issue}`);
  const check: LeakCheck = {
    secrets,
    typedQuery: run.query,
    publicTexts: publicTextsOf(analysis),
    ownRunIds: [run.runId, run.threadId],
    otherRunIds,
    allowedCover: cover,
  };
  for (const leak of leaks(record, check)) refuse(leak);
  stop();
  const warnings = analysisIssues(record.analysis).filter(
    (issue) => !runInfoIssues.includes(issue),
  );
  return { record, warnings, ...(noCover && { noCover }) };
}
