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
 *   replay stamps its own id); the time since the run started that each event was sent with
 *   (`elapsedMs`, without the wait for the user's choice) is kept as it was sent, and a replay
 *   sends it as recorded;
 * - the stored query (what the user typed) is not kept: `request.query` is "<title> <artist>";
 * - status messages about the user's own actions in that run (the clarification node's
 *   "Selected: …", in older runs "User confirmed …", and "Remembered preference …") are left
 *   out: a viewer of the replay did neither;
 * - the excerpt of a web search result (a `tavily` item of the web or editorial tier: text the
 *   search fetched from a third-party page, never a source's API, the model or the app) that
 *   holds, outside its links, a token-shaped run (`tokenSpans`: a run the long-token rule
 *   matches, 32 or more hex digits, a long base64 value or a random-looking base64url run),
 *   becomes
 *   "[excerpt withheld: it held a token-shaped run]" (WITHHELD_EXCERPT), whole, in every place
 *   the item appears; its title, url and source are kept (`withoutPageTokens`). A page's text
 *   may run words together ("StudioPiano2NotesGuitar2Tabs…") into that shape, and no word of a
 *   page that printed one is kept, so nothing glued to a run or beside it is written. Such an
 *   excerpt is refused instead, and kept as it is, when it holds a configured credential or 12
 *   characters in a row of one (as it is, URL-decoded with "+" read as a space or kept, and the
 *   credential with "+" as a space, "&#43;" or "%2B", or URL-encoded), a precise secret shape in
 *   any of those readings, or a link with a secret (`linkSecret`): by that rule's name. It is
 *   refused too when a claim or a map link cites the item ("a cited page excerpt holds a long
 *   token"). The recorder says which items it withheld and how many runs each held; the record
 *   is then checked as it is written, so the same run anywhere else (a title, another source's
 *   item, the model's text) is still a refusal.
 *
 * Refusals: a run that is not completed, has no stored result of its own, or was not live (a
 * replayed or cached result is not recorded again); a run whose last stream does not end with
 * `done` (a stream cut short) or has no single `complete`; a paused run whose streams are not
 * "connected … interrupt, done" then "resuming … complete, done" (a paused run's streams are
 * joined into one stream, numbered again from 0, without the pause); and a record that holds a
 * configured credential (also URL-encoded, or split by zero-width characters), a secret-shaped
 * string (in any field, a credential's own format or name: PRECISE_SHAPES; in free text, also a
 * long token or 32 or more hex digits other than the record's own commit; in an id field, a
 * token judged as a link's path segment is; in a web search page's excerpt, any token-shaped
 * run), an e-mail address, a URL outside the allow-listed source sites or one to them with a user
 * name or password, or whose path, query or fragment holds a secret shape, a signature, key,
 * password or secret parameter (nested and URL-encoded too), or a token glued to its path
 * (`linkSecret`), a preview or
 * media URL inside text (the Cover Art Archive link `archiveCoverOf` derives is allowed as the
 * result's cover only), the typed query
 * (when it is not the track's own title, artist or album; compared without case, accents,
 * punctuation or URL encoding), the id of a run (its own anywhere but the envelope, or any other
 * run the database knows; the ids sources use, such as MusicBrainz MBIDs, are content), a link
 * with a signature or token parameter (on any site), a source error's message or a status line
 * (whole; the markup rule aside for the lines that name the track in Spotify's words) the run
 * routes would refuse as an error message (reasonIssue: markup, also entity-escaped, a stack
 * trace, a signature or token parameter, or a link), a social platform page, a web evidence
 * title or excerpt with a private @handle, profile boilerplate or a comment thread
 * (webTextIssue), web evidence the run routes refuse (heldTextIssue, which also reads a page
 * written without its scheme), an `error` or `interrupt` event, a commit that is not a commit
 * hash, or that fails the record's schema or says less than a replay must (`runIssues`). The
 * result's other producer checks (`analysisIssues`) are reported as warnings: a run stored by
 * older code may not pass them all, and the record replays what was sent. The loader (records.ts)
 * runs the same checks (`recordIssues`) again on every file it reads, as far as a file can tell,
 * so it never leaves out a file the recorder wrote.
 */

import {
  type AnalyzeStreamEvent,
  analysisIssues,
  ReplayRecord,
  runIssues,
  TrackAnalysis,
} from "@liner-notes/contract";
import { foundLine, selectedLine } from "../agent/statusText.js";
import { heldTextIssue } from "../agent/storedResults.js";
import { isMediaUrl, reasonIssue } from "../sources/http.js";
import { isSocialPage, webTextIssue } from "../sources/search.js";
import { isPreviewUrl, type RunRecord, type StoredRunEvent } from "../store/runs.js";
import { ARCHIVE_FRONT, archiveCover } from "./cover.js";
import { normalizeQuery } from "./query.js";

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
//
// Two kinds of rule. The precise ones (PRECISE_SHAPES, the signed, key and secret parameters)
// name a credential's own format or name, so they are refused wherever they appear, in any
// field. The heuristic ones (a 32-hex run, a base64 value with short pieces, a random-looking
// base64url run) read a value's randomness, and are applied only where a secret is plausible and
// a false refusal is cheap: a web search page's excerpt (withheld, `pageExcerptVerdict`), a
// link's query and fragment (refused, `linkSecret`), and, without the hex rule, a link's path
// and an id (`tokenSegment`). Free text (claims, titles, a source's own text) is held to the
// precise rules, the long-token rule and the hex rule (`FREE_TEXT_SHAPES`).

/** A rule a text is checked against: a pattern, or a test a pattern cannot express. */
type Shape = { test(text: string): boolean };

/** How often a letter and a digit meet in `text` ("a1", "1a"): random text has many. */
const alternations = (text: string) => text.match(/[A-Za-z](?=\d)|\d(?=[A-Za-z])/g)?.length ?? 0;

/**
 * Zero-width characters and soft hyphens: they split a value without showing, so every text is
 * read without them.
 */
const INVISIBLE = /[­᠎​-‏⁠-⁤﻿]/g;
const visible = (text: string) => text.replace(INVISIBLE, "");

/**
 * The names a password or secret is written under, with any prefix (`db_password`, `user_pass`,
 * `client-secret`, `api_secret`), a service's access or secret key, and a Java session id.
 */
const SECRET_NAME =
  "(?:[a-z0-9]+[_-])*(?:password|passwd|pass|pwd|secret)|(?:access|secret)[_-]key|jsessionid";

/** A secret written as `name=value`, in a link's query or fragment or in text. */
const SECRET_PARAM = new RegExp(String.raw`(?:^|[\s?&;#])(?:${SECRET_NAME})=(?=[^\s&;#])`, "i");

/** A quote as JSON, PHP, HTML or an escaped string writes one. */
const QUOTE = String.raw`(?:\\?["'\x60]|&quot;|&#0*3[49];|&apos;|\\u0022|\\u0027)`;

/**
 * A quoted field naming a password or secret whose value is a quoted string (`{"db_password":
 * "…"}`, `'pass' => '…'`, `&quot;password&quot;: &quot;…`). A quoted title followed by a colon
 * and words or a time (`"Password": a 2009 single`, `"Password": 3:41`) is not one.
 */
const PASSWORD_FIELD = new RegExp(
  String.raw`${QUOTE}(?:[a-z0-9]+[_-])*(?:password|passwd|pass|pwd|secret)${QUOTE}\s*(?::|=>)\s*${QUOTE}`,
  "i",
);

/**
 * "Bearer" or "Basic" and a credential: as written ("Bearer …", any 12 or more token
 * characters), or in any case when the value looks like a token (a digit, a sign of base64 or a
 * capital inside a word): "a basic understanding" is prose.
 */
const BEARER_OR_BASIC: Shape = {
  test: (text) =>
    /\b(?:Bearer|Basic) [A-Za-z0-9._~+/=-]{12,}/.test(text) ||
    [...text.matchAll(/\b(?:bearer|basic)\s+([A-Za-z0-9._~+/=-]{12,})/gi)].some(([, value]) =>
      /\d|[._~+/=-]|[a-z][A-Z]/.test(value),
    ),
};

/**
 * Credentials by their own format or name, refused in any field, whatever sits before or after
 * them (a key glued to a word or behind an escaped "\n" is still one).
 */
const PRECISE_SHAPES: Array<[string, Shape]> = [
  ["a bearer or basic credential", BEARER_OR_BASIC],
  [
    "a key or token parameter",
    /(?<![A-Za-z0-9])(?:api[-_]?key|access_token|client_secret|token|(?:access|secret)[_-]key)["']?\s*[:=]\s*\S/i,
  ],
  ["a password or secret parameter", SECRET_PARAM],
  ["a password field", PASSWORD_FIELD],
  ["an OpenAI-style key", /\bsk-[A-Za-z0-9_-]{16,}/],
  ["a Tavily key", /tvly-[A-Za-z0-9_-]{8,}/],
  ["a Spotify access token", /\bBQ[A-Za-z0-9_-]{40,}/],
  ["a Google API key", /AIza[0-9A-Za-z_-]{35}/],
  ["a Stripe key", /(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}/],
  ["a GitHub token", /gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,}/],
  ["a GitLab token", /glpat-[A-Za-z0-9_-]{20}/],
  ["a Hugging Face token", /hf_[A-Za-z]{30,}/],
  ["a Slack token", /xox[abprs]-[A-Za-z0-9-]{10,}/],
  ["a Turnstile secret", /0x4AAAAAAA[A-Za-z0-9_-]{20,}/],
  ["a Discord bot token", /[MNO][A-Za-z0-9_-]{23,27}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,40}/],
  ["an AWS access key id", /(?:AKIA|ASIA)[A-Z0-9]{16}/],
  ["a JSON web token", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./],
  ["a private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  // Read from the start of a run of address characters only, so a long run costs one pass.
  ["an e-mail address", /(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+/],
];

/**
 * 40 or more letters, digits, "-" and "_" with a digit and both cases, as a random key is. Read
 * from the start of a run only (so a long run is read once).
 */
const LONG_TOKEN =
  /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])[A-Za-z0-9_-]{40,}/;
const LONG_TOKENS = new RegExp(LONG_TOKEN.source, "g");

/**
 * 32 or more hex digits, in either case, with a digit and a letter (an API key: Last.fm's are
 * 32; a digest), wherever the run starts ("0x…", "apikey…", after an escaped "\n"). MusicBrainz
 * ids are UUIDs, whose runs of hex digits are 12 at most; the record's own commit is left out of
 * the text first (`leaks`).
 */
const HEX_RUNS = /(?<![0-9a-f])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{32,}/gi;
const HEX_KEY: Shape = { test: (text) => [...text.matchAll(HEX_RUNS)].length > 0 };

/** Free text is held to the precise rules, the long-token rule and the hex rule. */
const FREE_TEXT_SHAPES: Array<[string, Shape]> = [
  ...PRECISE_SHAPES,
  ["a long token", LONG_TOKEN],
  ["a hex key", HEX_KEY],
];

/**
 * The base64 values of a text: runs of 40 or more characters with a "+" or "/" in them, mixed
 * case and a digit (`openssl rand -base64 48`, as RUN_TOKEN_SECRET is made), whose pieces
 * between "+" and "/" may all be shorter than the long-token rule reads (`base64Value`).
 */
const BASE64_RUNS =
  /(?<![A-Za-z0-9+/])(?=[A-Za-z0-9+/]*[+/])(?=[A-Za-z0-9+/]*\d)(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*[a-z])[A-Za-z0-9+/]{40,}/g;
const BASE64_PIECE = 12;
const BASE64_HUMP_SPAN = 12;

/**
 * True when a run BASE64_RUNS found is a base64 value: one of its pieces has 12 or more
 * characters (BASE64_PIECE), or, every piece being short, a lower-case letter is followed by a
 * capital at least once per 12 characters, as random text has about once per 6. A chord line
 * ("Am/G/Fmaj7/C/…/Bm7b5/E7"), a search ("Bitter+Sweet+Symphony+…") or a breadcrumb
 * ("Home/Music/Daft/Punk/…") has short pieces and few or no such humps. A genre or label list
 * may read as one ("Pop/Rock/Electronic/Instrumental/2001"), which is why the rule is read only
 * in a page's excerpt (withheld) and a link's query or fragment.
 */
function base64Value(run: string): boolean {
  if (run.split(/[+/]/).some((piece) => piece.length >= BASE64_PIECE)) return true;
  const humps = run.match(/[a-z](?=[A-Z])/g)?.length ?? 0;
  return humps * BASE64_HUMP_SPAN >= run.length;
}

/** The long base64 values of `text` (BASE64_RUNS that are `base64Value`s). */
const base64Values = (text: string) =>
  [...text.matchAll(BASE64_RUNS)].filter(([run]) => base64Value(run));
const BASE64_VALUE: Shape = { test: (text) => base64Values(text).length > 0 };

/** What a link's query is held to: the precise rules and the heuristic ones but `randomRun`. */
const QUERY_SHAPES: Array<[string, Shape]> = [
  ...FREE_TEXT_SHAPES,
  ["a base64 value", BASE64_VALUE],
];

/**
 * Parameters of a URL signed with an expiring token (Akamai, AWS and Google Cloud signatures,
 * OAuth), or carrying a token (`token`, `access_token`, `auth_token`, `refresh_token`,
 * `id_token`, …) or an API key, on any host (as an error message may not: reasonIssue), in its
 * query or its fragment (`#access_token=`, as an OAuth reply carries it).
 */
const SIGNED_PARAM =
  /[?&;~#](?:hdnea|hdnts|x-(?:amz|goog)-[a-z-]+|sig|signature|oauth_[a-z_]+|(?:[a-z0-9]+_)*token|api[-_]?key)=/i;

/** A bare `key` parameter's value, as it is written in a link. */
const KEY_PARAM = /[?&;~#!]key=([^&#;\s<>]*)/gi;

/**
 * True when a `key` parameter's value looks random: without quotes (`signedUrl` reads the link
 * URL-decoded too), it starts with 16 or more letters, digits and `. _ ~ + / = -` in which a
 * letter and a digit meet at least twice, or 10 to 15 of them with both cases and a digit. Never a
 * date or time (`2019-05-23T12:00`, `2019-05-23T123000Z`), or words and numbers each in one piece
 * (`VUSCD82-UK1997`, `TheVerve12`, `8A-A-minor`): a catalogue number or a key's name. A musical
 * key (`Am`, `C%23m`, `A minor`) is shorter, and a page's slug of words
 * (`the-verve-bitter-sweet-symphony-1997`) has no letter beside a digit.
 */
function tokenKey(value: string): boolean {
  const plain = value.replace(/^["']+/, "");
  const run = plain.match(/^[A-Za-z0-9._~+/=-]*/)?.[0] ?? "";
  if (/^\d{4}-\d{2}-\d{2}(?:T\d{2})?/.test(run)) return false;
  if (run.split(/[-_.]/).every((piece) => /^(?:[A-Za-z]+\d*|\d+[A-Za-z]*)$/.test(piece)))
    return false;
  if (run.length >= 16) return alternations(run) >= 2;
  return run.length >= 10 && /[A-Z]/.test(run) && /[a-z]/.test(run) && /\d/.test(run);
}

/**
 * `text` as written and URL-decoded once and twice, with "+" kept: a parameter nested in another
 * (`?next=%2Fcb%3Fpassword%3D…`, or `%253F…` encoded twice) is read too.
 */
function nested(text: string): string[] {
  const once = decodedKeepingPlus(text);
  return [...new Set([text, once, decodedKeepingPlus(once)])];
}

/** True when `text` holds a signed URL, or a token or random-looking key parameter, nested or not. */
function signedUrl(text: string): boolean {
  return nested(text).some(
    (form) =>
      SIGNED_PARAM.test(form) || [...form.matchAll(KEY_PARAM)].some(([, value]) => tokenKey(value)),
  );
}

/** The message of a source error, wherever the record holds one (its result, its events). */
const SOURCE_ERROR_MESSAGE = /(?:^|\.)sourceErrors\[\d+\]\.message$/;

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
  if (signedUrl(url)) return false;
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
 * credentials and whose path, query and fragment carry nothing shaped like a secret. These URLs,
 * and their ids (`tavily:<url>`), are content of the record; any other URL still has to be on
 * an allow-listed site.
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
 * The paths of the text a record's web-tier evidence stores (each item's title and excerpt), as
 * `strings` writes them: the web tier's own check (webTextIssue) runs on these, and on no other
 * text (model prose and primary records may name an account).
 */
function webEvidenceTexts(value: unknown, path = "", paths = new Set<string>()): Set<string> {
  const at = (name: string) => (path ? `${path}.${name}` : name);
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) webEvidenceTexts(item, `${path}[${i}]`, paths);
  } else if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    if (item.sourceTier === "web") {
      paths.add(at("title"));
      paths.add(at("excerpt"));
    }
    for (const [name, inner] of Object.entries(item)) webEvidenceTexts(inner, at(name), paths);
  }
  return paths;
}

/**
 * Where a piece or segment is read: a link's path or an id, where a run of hex digits alone is a
 * page's or a record's name (AP News and Notion end their article links in a 32-hex id, image and
 * MD5 directories are hex, MusicBrainz ids are UUIDs), or a link's fragment, where it is not.
 */
type Place = "path" | "fragment";

const HEX_ONLY = /^[0-9A-Fa-f]+$/;

/**
 * The paths of the excerpts of web search pages (PAGE_SOURCES at PAGE_TIERS), as `strings`
 * writes them.
 */
function pageExcerptPaths(value: unknown, path = "", paths = new Set<string>()): Set<string> {
  const at = (name: string) => (path ? `${path}.${name}` : name);
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) pageExcerptPaths(item, `${path}[${i}]`, paths);
  } else if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    if (PAGE_SOURCES.has(item.source) && PAGE_TIERS.has(item.sourceTier)) paths.add(at("excerpt"));
    for (const [name, inner] of Object.entries(item)) pageExcerptPaths(inner, at(name), paths);
  }
  return paths;
}

/**
 * A piece of a link's path or fragment (between its separators) shaped like a credential: 32 or
 * more base64 characters in which letters and digits alternate at least 4 times, as in random
 * text, or, in a fragment, 32 or more hex digits. A word, Title-Case or not
 * ("IceIceBabyVanillaIce1990SingleRelease"), is a name, not a token.
 */
function tokenPiece(piece: string, place: Place): boolean {
  if (!/^[A-Za-z0-9+=]{32,}$/.test(piece)) return false;
  if (HEX_ONLY.test(piece)) return place === "fragment";
  return alternations(piece) >= 4;
}

/**
 * A path segment, fragment or id part shaped like a credential: a JSON web token, an
 * "sk-"/"pk-" style key, a piece between any of its separators that is one (`tokenPiece`: a token
 * glued to a slug by ",", ".", "-", "_" or ":" is judged on its own), or a random-looking
 * base64url run (`randomRuns`; in a fragment, `denseRun` too). A slug of words, Title-Case or not
 * ("Why-was-Ice-Ice-Baby-so-popular-in-1990"), is a page name.
 */
function tokenSegment(segment: string, place: Place): boolean {
  if (/^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./.test(segment)) return true;
  if (/^(?:sk|pk)[-_][A-Za-z0-9_-]{16,}$/.test(segment)) return true;
  return (
    segment.split(/[^A-Za-z0-9+=]/).some((piece) => tokenPiece(piece, place)) ||
    randomRuns(segment, place).length > 0 ||
    (place === "fragment" && denseRun(segment))
  );
}

/** A year or decade as a word ("1960s", "21st"): its letter beside a digit is not randomness. */
const NUMBER_WORD = /^\d+(?:s|st|nd|rd|th)$/;

/**
 * True when `text` holds a run of 32 or more letters, digits, "-" and "_", in any case, in which a
 * letter and a digit meet at least once per 8 characters, years and decades left out: a key a
 * fragment carries, lower-case (`#7h5n1yd0-eyq67rlg17_ly3lrwqc_4aq06tp_-lqo6k`) or a UUID. A
 * section anchor of words and decades (`Charts_of_the_1960s_1970s_1980s_and_1990s`,
 * `UK_1960s_1970s_1980s_1990s_2000s_singles`) is not one.
 */
function denseRun(text: string): boolean {
  for (const [run] of text.matchAll(/[A-Za-z0-9_-]{32,}/g)) {
    let meets = 0;
    for (const piece of run.split(/[-_]/)) {
      if (!NUMBER_WORD.test(piece)) meets += alternations(piece);
    }
    if (meets * 8 >= run.length) return true;
  }
  return false;
}

const RANDOM_RUN = 32;
/** A random run holds one piece this long at least: a key's pieces between "-" and "_" are long. */
const RANDOM_PIECE = 8;
/** A word, a number or a decade ("Verve", "UK", "1997", "1960s"): it ends a random run. */
const WORD_PIECE = /^(?:[A-Z]?[a-z]+|[A-Z]+|\d+(?:s|st|nd|rd|th)?)$/;

const DIGIT = 1;
const LETTER = 2;
const kind = (code: number) =>
  code >= 48 && code <= 57
    ? DIGIT
    : (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
      ? LETTER
      : 0;

/**
 * The random-looking base64url runs of `text`: stretches of 32 or more letters, digits, "-" and
 * "_" in which a letter and a digit meet at least once per 8 characters (a key a link carries,
 * `#Ab3dEf6hIj9lMn2pQr5t-Uv8xYz1bCd4fGh7K0mNq_RsTu`). A stretch runs across "-" and "_" but
 * stops at a word of 3 or more characters, so a key glued to a slug is judged on its own and a
 * slug or section anchor of words and years (`Track_listing_and_formats_1997_UK_CD_single`,
 * `UK_1960s_1970s_1980s_1990s_2000s`), or a Spotify id glued to one, is not one. It holds a piece
 * of 8 or more (`2Pac-K-Ci-JoJo-B2K-UB40-U2-R2D2` has none) and a digit and a letter; in a path
 * or an id, letters of both cases too, as base64url has, so hex ids and UUIDs (`mb-<uuid>`) are
 * names there. Linear: each stretch's best
 * window (piece-aligned, 32 or more long) is found with two pointers over running sums.
 */
function randomRuns(text: string, place: Place): Array<readonly [number, number]> {
  const found: Array<readonly [number, number]> = [];
  for (const match of text.matchAll(/[A-Za-z0-9_-]{32,}/g)) {
    const run = match[0];
    const pieces = [...run.matchAll(/[A-Za-z0-9]+/g)].map((p) => [p.index, p[0]] as const);
    let first = 0;
    for (let i = 0; i <= pieces.length; i++) {
      const piece = pieces[i]?.[1];
      if (piece !== undefined && !(piece.length >= 3 && WORD_PIECE.test(piece))) continue;
      const chain = pieces.slice(first, i);
      first = i + 1;
      if (chain.length === 0) continue;
      const start = chain[0][0];
      const end = chain[chain.length - 1][0] + chain[chain.length - 1][1].length;
      if (end - start < RANDOM_RUN) continue;
      if (!chain.some(([, p]) => p.length >= RANDOM_PIECE)) continue;
      const stretch = run.slice(start, end);
      if (!/\d/.test(stretch) || !/[A-Za-z]/.test(stretch)) continue;
      if (place === "path" && !(/[A-Z]/.test(stretch) && /[a-z]/.test(stretch))) continue;
      if (
        densest(
          stretch,
          chain.map(([at, p]) => [at - start, at - start + p.length] as const),
        )
      ) {
        found.push([match.index + start, match.index + end]);
      }
    }
  }
  return found;
}

/**
 * True when a window of `stretch` from a piece's start to a piece's end, 32 or more long, has a
 * letter and a digit meeting at least once per 8 characters: 8 × meetings − length ≥ 0, found
 * with running sums and the least sum before each end.
 */
function densest(stretch: string, pieces: ReadonlyArray<readonly [number, number]>): boolean {
  // meets[k]: how many characters before position k meet the next one as a letter and a digit.
  const meets = new Int32Array(stretch.length + 1);
  for (let k = 0; k < stretch.length; k++) {
    const a = kind(stretch.charCodeAt(k));
    const b = k + 1 < stretch.length ? kind(stretch.charCodeAt(k + 1)) : 0;
    meets[k + 1] = meets[k] + (a && b && a !== b ? 1 : 0);
  }
  // A window [s, e) holds meets[e - 1] − meets[s] meetings (pairs at s … e − 2).
  let least = Number.POSITIVE_INFINITY;
  let next = 0;
  for (const [, end] of pieces) {
    while (next < pieces.length && pieces[next][0] <= end - RANDOM_RUN) {
      const s = pieces[next][0];
      least = Math.min(least, 8 * meets[s] - s);
      next++;
    }
    if (least !== Number.POSITIVE_INFINITY && 8 * meets[end - 1] - end >= least) return true;
  }
  return false;
}

/** The spans of `text` that are token-shaped runs: long tokens, hex runs, base64 values, random runs. */
function tokenSpans(text: string): Array<readonly [number, number]> {
  return [
    ...[...text.matchAll(LONG_TOKENS), ...text.matchAll(HEX_RUNS), ...base64Values(text)].map(
      (m) => [m.index, m.index + m[0].length] as const,
    ),
    ...randomRuns(text, "path"),
  ];
}

/**
 * What a web search page's excerpt that held a long token-shaped run is recorded as, whole: no
 * word of the page is kept, so no piece of a token, or of what a page printed beside one, is.
 */
export const WITHHELD_EXCERPT = "[excerpt withheld: it held a token-shaped run]";

/**
 * The only items whose excerpt is a third-party page's text: the web search's results
 * (agent/research/evidencePack.ts), at a page tier. Any other source's text is an API's answer.
 */
const PAGE_SOURCES: ReadonlySet<unknown> = new Set(["tavily"]);
const PAGE_TIERS: ReadonlySet<unknown> = new Set(["web", "editorial"]);

/** An evidence item whose excerpt the recorder withheld, and how many runs it held. */
export interface WithheldExcerpt {
  evidenceId: string;
  runs: number;
}

/** `text` as it is, URL-decoded ("+" read as a space, as a query is) and with "+" kept. */
function readings(text: string): string[] {
  return [...new Set([text, decoded(text), decodedKeepingPlus(text)])];
}

/**
 * True when `text` holds one of `secrets`: as it is, URL-decoded (with "+" read as a space, as
 * a query is, and kept as "+", as a base64 value holds one), or URL-encoded.
 */
function holdsSecret(text: string, secrets: readonly string[]): boolean {
  const forms = readings(text);
  return secrets.some(
    (secret) =>
      secret &&
      (forms.some((form) => form.includes(secret)) || text.includes(encodeURIComponent(secret))),
  );
}

/** How many characters in a row of a configured credential a page's excerpt may share with it. */
const SECRET_PART = 12;

/**
 * True when `text`, in any of its readings, holds 12 or more characters in a row of one of
 * `secrets` (or the whole of a shorter one), as it is, with "+" as a space, "&#43;" or "%2B", or
 * URL-encoded: a credential a page cut short, wrapped or printed in pieces.
 */
function holdsSecretPart(text: string, secrets: readonly string[]): boolean {
  const forms = readings(text);
  return secrets.some((secret) => {
    if (!secret) return false;
    const shown = new Set([
      secret,
      secret.replace(/\+/g, " "),
      secret.replace(/\+/g, "&#43;"),
      secret.replace(/\+/g, "%2B"),
      encodeURIComponent(secret),
    ]);
    for (const form of shown) {
      const width = Math.min(SECRET_PART, form.length);
      for (let at = 0; at + width <= form.length; at++) {
        const part = form.slice(at, at + width);
        if (forms.some((reading) => reading.includes(part))) return true;
      }
    }
    return false;
  });
}

/** How many long token-shaped runs `text` holds outside its links, in its most telling reading. */
function tokenRuns(text: string): number {
  const outside = text.replace(URL_IN_TEXT, " ");
  return Math.max(
    ...readings(outside).map((reading) => {
      // Runs both rules match (a base64 value with a piece of 40 or more) count once.
      const spans = tokenSpans(reading).sort((a, b) => a[0] - b[0]);
      let runs = 0;
      let end = -1;
      for (const [start, stop] of spans) {
        if (start >= end) runs++;
        end = Math.max(end, stop);
      }
      return runs;
    }),
  );
}

/**
 * What the record does with a web search page's excerpt: keep it (null: it holds no token-shaped
 * run, and is checked as any text is), withhold it (the runs it holds: a long token, a hex run, a
 * base64 value or a random base64url run, `tokenSpans`), or refuse it by name. A page may print a
 * checksum or run words together into one of those shapes, so the shape alone only withholds the
 * excerpt. An excerpt with a run is refused, and left as it is, when it holds a configured
 * credential or 12 characters in a row of one (`holdsSecretPart`), a precise secret shape (in any
 * reading), or a link with a secret (`linkSecret`): what it held is named, not hidden.
 */
function pageExcerptVerdict(
  written: string,
  secrets: readonly string[],
): { withhold: number } | { refuse: string } | null {
  const excerpt = visible(written);
  const runs = tokenRuns(excerpt);
  if (runs === 0) return null;
  if (holdsSecretPart(excerpt, secrets)) return { refuse: "a configured credential" };
  const forms = readings(excerpt);
  const other = PRECISE_SHAPES.find(([, pattern]) => forms.some((form) => pattern.test(form)));
  if (other) return { refuse: other[0] };
  for (const url of excerpt.match(URL_IN_TEXT) ?? []) {
    const secret = linkSecret(url);
    if (secret) return { refuse: secret };
  }
  return { withhold: runs };
}

/**
 * The page excerpts a record withheld and refused, by evidence id and by path: the same item held
 * twice (as an event and in the result) counts its runs once, and two items with one id and
 * different excerpts both count.
 */
export class PageExcerpts {
  private readonly byItem = new Map<string, Map<string, number>>();
  /** The path of each excerpt withheld, with its item's id. */
  readonly withheld: Array<{ path: string; evidenceId: string }> = [];
  /** Each excerpt refused, by path, with the rule's name. */
  readonly refused = new Map<string, string>();

  withhold(path: string, evidenceId: string, excerpt: string, runs: number) {
    const excerpts = this.byItem.get(evidenceId) ?? new Map<string, number>();
    excerpts.set(excerpt, runs);
    this.byItem.set(evidenceId, excerpts);
    this.withheld.push({ path, evidenceId });
  }

  list(): WithheldExcerpt[] {
    return [...this.byItem].map(([evidenceId, excerpts]) => ({
      evidenceId,
      runs: [...excerpts.values()].reduce((sum, runs) => sum + runs, 0),
    }));
  }
}

/**
 * A copy of `value` (at `path` in the record) in which each web search page's excerpt (an
 * evidence item from the web search, of the web or editorial tier) that holds a long
 * token-shaped run is WITHHELD_EXCERPT (`pageExcerptVerdict`), its title, url and source kept;
 * nothing else changes. Each one withheld, or refused and left as it is, is noted in `found`.
 */
export function withoutPageTokens(
  value: unknown,
  secrets: readonly string[],
  found: PageExcerpts,
  path = "",
): unknown {
  const at = (name: string | number) =>
    typeof name === "number" ? `${path}[${name}]` : path ? `${path}.${name}` : name;
  if (Array.isArray(value)) {
    return value.map((item, i) => withoutPageTokens(item, secrets, found, at(i)));
  }
  if (value === null || typeof value !== "object") return value;
  const item = value as Record<string, unknown>;
  if (
    PAGE_SOURCES.has(item.source) &&
    PAGE_TIERS.has(item.sourceTier) &&
    typeof item.excerpt === "string"
  ) {
    const verdict = pageExcerptVerdict(item.excerpt, secrets);
    if (verdict === null) return item;
    if ("refuse" in verdict) {
      found.refused.set(at("excerpt"), verdict.refuse);
      return item;
    }
    found.withhold(at("excerpt"), String(item.id), item.excerpt, verdict.withhold);
    return { ...item, excerpt: WITHHELD_EXCERPT };
  }
  return Object.fromEntries(
    Object.entries(item).map(([key, inner]) => [
      key,
      withoutPageTokens(inner, secrets, found, at(key)),
    ]),
  );
}

/** The evidence ids that something in `value` cites (a claim's or a map link's `evidenceIds`). */
function citedEvidenceIds(value: unknown, ids = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) citedEvidenceIds(item, ids);
  } else if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      if (key === "evidenceIds" && Array.isArray(inner)) {
        for (const id of inner) if (typeof id === "string") ids.add(id);
      } else if (key === "evidenceId" && typeof inner === "string") ids.add(inner);
      else citedEvidenceIds(inner, ids);
    }
  }
  return ids;
}

/** What `linkSecret` found for each link already judged (a record names a link many times). */
const judgedLinks = new Map<string, string | null>();
const JUDGED_LINKS = 4096;

/**
 * Why a link holds something shaped like a secret, or null: a signed URL or a token or key
 * parameter (`signedUrl`), a user name or password, a secret shape in its query (the precise
 * rules, among them a password or secret parameter, and the long-token, hex and base64 rules; also
 * in a parameter nested in another and URL-encoded once or twice), or in its path or fragment
 * (read with "+" kept:
 * the precise rules, and `tokenSegment`, piece by piece, so a page's slug of words, a section
 * anchor or a hex id in a path is not one, and a token glued to a slug is), or a base64 value in
 * its fragment.
 */
function linkSecret(url: string): string | null {
  const known = judgedLinks.get(url);
  if (known !== undefined) return known;
  const secret = judgeLink(visible(url));
  if (judgedLinks.size >= JUDGED_LINKS) judgedLinks.clear();
  judgedLinks.set(url, secret);
  return secret;
}

function judgeLink(url: string): string | null {
  if (signedUrl(url)) return "a signed URL";
  let parsed: URL;
  try {
    parsed = new URL(url.startsWith("//") ? `https:${url}` : url);
  } catch {
    return null;
  }
  // A user name or a password in a link is a credential, whatever it looks like.
  if (parsed.username || parsed.password) return "credentials in a link";
  const scan = (forms: string[], shapes: Array<[string, Shape]>) =>
    shapes.find(([, pattern]) => forms.some((form) => pattern.test(form)))?.[0] ?? null;
  const query = parsed.search;
  const inQuery = scan([...new Set([decoded(query), ...nested(query)])], QUERY_SHAPES);
  if (inQuery) return `${inQuery} in a link`;
  // The path and the fragment are scanned too: a page link may carry a capability token or an
  // address there. A "+" in either is a "+" ("/music/Basic+Channel/"), not a space.
  for (const [part, place] of [
    [parsed.pathname, "path"],
    [parsed.hash.slice(1), "fragment"],
  ] as const) {
    const forms = nested(part);
    const shape = scan(forms, PRECISE_SHAPES);
    if (shape) return `${shape} in a link`;
    const token = forms.some(
      (form) =>
        form.split("/").some((segment) => tokenSegment(segment, place)) ||
        (place === "fragment" && BASE64_VALUE.test(form)),
    );
    if (token) return `a token in a link's ${place}`;
  }
  return null;
}

function plainWebPage(url: string): boolean {
  if (signedUrl(url) || isPreviewUrl(url) || isMediaUrl(url)) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  if (parsed.username || parsed.password) return false;
  return linkSecret(url) === null;
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * Keys of id fields. A source's id or record ref may be a slug of words with a year
 * ("wikipedia:track/List_of_UK_Singles_Chart_number_ones_of_the_2000s"), which the long-token
 * rule reads as a token: an id's long runs are judged as a link's path segments are instead
 * (`tokenSegment`), so a random run there is still refused ("a token in an id").
 */
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

/**
 * True when an id field's value (outside its links) holds a token: its parts between "/", ":"
 * and spaces judged as a link's path segments are (`tokenSegment`).
 */
function tokenInId(text: string): boolean {
  return [text, decodedKeepingPlus(text)].some((form) =>
    form.split(/[\s/:]+/).some((part) => tokenSegment(part, "path")),
  );
}

/**
 * The record's own commit (its `commit`, "-dirty" or not), short or as the full 40-digit hash it
 * begins, as a whole run of hex digits, wherever the record states it: the hash of the code the
 * run was made with, which a record names by design (a replay says which commit it was recorded
 * from), not a hex key. Null without one.
 */
function ownCommit(record: unknown): RegExp | null {
  const commit = (record as { commit?: unknown } | null)?.commit;
  if (typeof commit !== "string" || !COMMIT_PATTERN.test(commit)) return null;
  const hash = commit.replace(/-dirty$/, "");
  const rest = 40 - hash.length;
  const full = rest > 0 ? `(?:[0-9a-f]{${rest}})?` : "";
  return new RegExp(`(?<![0-9a-f])${hash}${full}(?![0-9a-f])`, "gi");
}

/** `text` with its URL encoding decoded (as it is, when it is not URL-encoded). */
function decoded(text: string): string {
  return decodedKeepingPlus(text.replace(/\+/g, " "));
}

/**
 * `text` URL-decoded with each "+" kept (as it is, when it is not URL-encoded). Each run of
 * "%XX" escapes is decoded on its own, so a stray "%" ("100% off") does not leave the rest of
 * the text undecoded; a run that is not UTF-8 has its ASCII escapes decoded.
 */
function decodedKeepingPlus(text: string): string {
  return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run.replace(/%[0-7][0-9A-Fa-f]/g, (byte) => decodeURIComponent(byte));
    }
  });
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
  /**
   * The recorded track's title and artist, as its result gives them: the status lines that name
   * it in Spotify's words (statusText.ts foundLine and selectedLine) are its own.
   */
  track?: { title: string; artist: string };
}

/** The paths of `field` in a record's events of `type`. */
function eventPaths(record: unknown, type: string, field: string): Set<string> {
  const paths = new Set<string>();
  const events = (record as { events?: unknown } | null)?.events;
  if (Array.isArray(events)) {
    events.forEach((item, i) => {
      if ((item as { event?: { type?: unknown } } | null)?.event?.type === type) {
        paths.add(`events[${i}].event.${field}`);
      }
    });
  }
  return paths;
}

/** The paths of the result's cover in a record: its result's, and its complete events'. */
function resultCoverPaths(record: unknown): Set<string> {
  return new Set(["analysis.coverUrl", ...eventPaths(record, "complete", "data.coverUrl")]);
}

/**
 * What a record must not hold, by path (values are never echoed: they may be credentials).
 * Ids the record's sources use (MusicBrainz MBIDs in evidence ids, record refs and page URLs,
 * claim and evidence ids) are content, still checked for secret shapes (`tokenInId`); only the
 * ids of runs are refused.
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
    track,
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
  const statusLines = eventPaths(record, "status", "message");
  const ownLines = new Set(track ? [foundLine(track), selectedLine(track)] : []);
  const webTexts = webEvidenceTexts(record);
  const pageExcerpts = pageExcerptPaths(record);
  const commit = ownCommit(record);
  for (const { path, text, isId } of strings(record)) {
    const plain = decoded(text);
    // Read without zero-width characters and soft hyphens, which may split a value.
    const seen = visible(text);
    // The kept cover, as the whole value of the result's cover: an allowed link there only.
    const isCover = cover !== null && text === cover && coverPaths.has(path);
    const allowedHere = (url: string) => allowed(url) || (isCover && url === cover);
    if (holdsSecret(text, secrets) || holdsSecret(seen, secrets)) {
      found.push(`${path}: a configured credential`);
    }
    // Secret shapes in the text around the URLs of allow-listed pages (long slugs and ids in
    // those are their own, and checked as links below), and around the record's own commit. An
    // id field is held to the precise rules, and its parts are judged as a link's path is.
    const around = seen.replace(URL_IN_TEXT, (url) => (allowedHere(url) ? " " : url));
    const scanned = commit ? around.replace(commit, " ") : around;
    const forms = [...new Set([scanned, decoded(scanned), ...nested(scanned)])];
    for (const [what, pattern] of isId ? PRECISE_SHAPES : FREE_TEXT_SHAPES) {
      if (forms.some((form) => pattern.test(form))) found.push(`${path}: ${what}`);
    }
    if (isId && tokenInId(scanned)) found.push(`${path}: a token in an id`);
    // A web search page's excerpt the recorder kept holds no token-shaped run (it withholds one).
    if (pageExcerpts.has(path) && tokenRuns(seen) > 0) {
      found.push(`${path}: a token-shaped run in a page excerpt`);
    }
    if (signedUrl(seen)) found.push(`${path}: a signed URL`);
    // A source error says what failed in words, as the run routes read it (reasonIssue): markup
    // is an answer's page that slipped in, and a stack trace, a token parameter or a link is not
    // what an error message keeps. A status line is held to the same, whole: the run writes its
    // lines from fixed words, error codes (agent/statusText.ts), numbers, dates and the audio
    // service's analyzer version. Two lines name the track in Spotify's words, which may hold
    // "<", ">" or "&" ("<3", "->"): the scout's "Found the track on Spotify: <title> by
    // <artist>" (foundLine) and the clarification's "Selected: <title> by <artist>"
    // (selectedLine; the recorder leaves the clarification's lines out, but a file may hold
    // one). A line that is exactly one of these for the recorded track is not held to
    // the markup rule (its "<", ">" and "&" are not read); its other rules, and the scans above
    // and below, still apply.
    const reason = SOURCE_ERROR_MESSAGE.test(path)
      ? reasonIssue(text)
      : statusLines.has(path)
        ? reasonIssue(ownLines.has(text) ? text.replace(/[<>&]/g, " ") : text)
        : null;
    if (reason) {
      const where = statusLines.has(path) ? "a status line" : "a source error";
      found.push(`${path}: ${reason} in ${where}`);
    }
    // A web page's stored text never holds a private handle, boilerplate or a comment thread.
    const webIssue = webTexts.has(path) ? webTextIssue(text) : null;
    if (webIssue) found.push(`${path}: ${webIssue}`);
    for (const url of seen.match(URL_IN_TEXT) ?? []) {
      if (isPreviewUrl(url)) found.push(`${path}: a preview URL`);
      else if (isSocialPage(url)) found.push(`${path}: a social platform page`);
      else if (allowedHere(url)) {
        // A link to an allowed page still carries no secret: its path and query are checked.
        const secret = isCover ? null : linkSecret(url);
        if (secret) found.push(`${path}: ${secret}`);
      } else if (isMediaUrl(url)) found.push(`${path}: an image or media URL`);
      else {
        // What a page left out of web evidence holds is said too (a token in its path).
        const secret = linkSecret(url);
        if (secret) found.push(`${path}: ${secret}`);
        found.push(`${path}: a URL outside the allow-listed sites`);
      }
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

/** A commit hash: 7 to 40 hex digits, "-dirty" when the tree had changes. */
export const COMMIT_PATTERN = /^[0-9a-f]{7,40}(-dirty)?$/;

/** Events a record never holds: a recorded run completed, and a pause is joined away. */
const UNRECORDED_EVENTS = new Set(["error", "interrupt"]);

/**
 * Everything a record must not hold, by path, each place once with the first reason found for
 * it (never the text): an event the recorder never writes (an `error` or an `interrupt`), a
 * commit that is not a commit hash, what `leaks` finds, and what the run routes refuse in a
 * stored result (heldTextIssue: a web page the web tier leaves out, or a source error's message
 * with markup, a stack trace, a token parameter or a link) in the record's result, in each
 * evidence event's item, and in the result its complete events store. A replay sends the
 * record's result in place of the stored one (player.ts), which is checked all the same, should
 * the player ever send it. The recorder refuses a record with any of these, and the loader
 * (records.ts) leaves out a file with any, so a file the recorder writes is never left out.
 */
export function recordIssues(record: ReplayRecord, check: LeakCheck): string[] {
  const found = new Map<string, string>();
  const add = (path: string, why: string) => {
    const near = (a: string, b: string) =>
      b === a || b.startsWith(`${a}.`) || b.startsWith(`${a}[`);
    const listed = [...found.keys()].some((place) => near(place, path) || near(path, place));
    if (!listed) found.set(path, why);
  };
  const addIssue = (prefix: string, issue: string | null) => {
    if (!issue) return;
    const at = issue.indexOf(": ");
    add(`${prefix}${issue.slice(0, at)}`, issue.slice(at + 2));
  };
  for (const [i, { event }] of record.events.entries()) {
    if (UNRECORDED_EVENTS.has(event.type)) {
      add(`events[${i}].event`, `an ${event.type} event, which a recording never holds`);
    }
  }
  if (!COMMIT_PATTERN.test(record.commit)) add("commit", "not a commit hash");
  for (const leak of leaks(record, check)) addIssue("", leak);
  addIssue("analysis.", heldTextIssue(record.analysis));
  for (const [i, { event }] of record.events.entries()) {
    if (event.type === "evidence") {
      // The item is checked as the one item of a list: "evidence[0]: …".
      const issue = heldTextIssue({ evidence: [event.evidence] });
      addIssue(`events[${i}].event.`, issue?.replace(/^evidence\[0\]/, "evidence") ?? null);
    }
    if (event.type === "complete") addIssue(`events[${i}].event.data.`, heldTextIssue(event.data));
  }
  return [...found].map(([path, why]) => `${path}: ${why}`);
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
  /** The page excerpts the record holds as WITHHELD_EXCERPT, with the runs each held. */
  withheldExcerpts: WithheldExcerpt[];
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
  // Each page excerpt that held a long token-shaped run withheld, in the result and the events.
  const pageExcerpts = new PageExcerpts();
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
  const recordedAnalysis: TrackAnalysis = {
    ...(withoutPageTokens(blanked, secrets, pageExcerpts, "analysis") as TrackAnalysis),
    coverUrl: cover,
  };

  const recordEvents = joined
    .filter(({ event }) => !isUserAction(event))
    .map(({ atMs, event }, seq) => {
      const body = withoutPageTokens(
        withoutMediaFields(event),
        secrets,
        pageExcerpts,
        `events[${seq}].event`,
      ) as Event;
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

  // A page excerpt is withheld only when nothing cites it: a verdict or a map link reached
  // against the page's text would be replayed against a note. One refused by name stays as it
  // is, and is reported once, by that name.
  const cited = citedEvidenceIds(candidate);
  for (const { path, evidenceId } of pageExcerpts.withheld) {
    if (cited.has(evidenceId))
      pageExcerpts.refused.set(path, "a cited page excerpt holds a long token");
  }
  for (const [path, why] of pageExcerpts.refused) refuse(`${path}: ${why}`);

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
    track: analysis,
    ownRunIds: [run.runId, run.threadId],
    otherRunIds,
    allowedCover: cover,
  };
  for (const issue of recordIssues(record, check)) {
    if (!pageExcerpts.refused.has(issue.slice(0, issue.indexOf(": ")))) refuse(issue);
  }
  stop();
  const warnings = analysisIssues(record.analysis).filter(
    (issue) => !runInfoIssues.includes(issue),
  );
  const withheldExcerpts = pageExcerpts.list();
  return { record, warnings, withheldExcerpts, ...(noCover && { noCover }) };
}
