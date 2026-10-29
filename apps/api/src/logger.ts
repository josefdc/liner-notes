/**
 * The API's log: one JSON object per line on stdout (and appended to LOG_FILE when it is set),
 * written by pino.
 *
 * - Every line written while an analysis runs carries its run id (`runId`): the analyze routes
 *   run each analysis inside `withRun`, and the id follows the run's async chain (graph nodes,
 *   sources, timers) through an AsyncLocalStorage. Work a queue shared by runs carries out must
 *   be bound to its caller (`AsyncLocalStorage.bind`); work runs share (one token refresh for
 *   all) is logged under the run that started it.
 * - Nothing secret reaches a line. Before a line is serialized, fields whose name says they are
 *   secret (keys, tokens, passwords, Authorization and other headers, preview links, the
 *   provider endpoint, request and response objects) are replaced; errors are reduced to a few
 *   known properties; and every string (the message, string fields, error messages and stacks)
 *   is scrubbed of configured secret values, Authorization values and Bearer tokens, keys and
 *   signatures in URLs, the provider endpoint and preview links (Spotify p.scdn.co, Deezer
 *   dzcdn.net). The serialized line is then searched once more for the configured secret values
 *   and endpoint hosts only, so a line is always valid JSON.
 * - The text a visitor typed (`query` fields) is written at debug level only; at info and above
 *   only its length is.
 * - A log call never throws because of what it was given: fields that cannot be read give a line
 *   that says so.
 * - `installConsoleBridge` sends console.log/info/warn/error/debug through the same logger, so
 *   modules that still call console write JSON lines with the run id too.
 *
 * LOG_LEVEL (fatal, error, warn, info, debug, trace or silent; default info) and LOG_FILE are
 * read by `configureLogger`, which config/env.ts calls once the settings file is loaded.
 * LOG_IP_SALT keys the hash of client addresses in request lines (`ipHash`); without it each
 * process makes a key of its own, so the same address hashes alike only within one process.
 * Every level goes to stdout (errors included), as one stream.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, generateKeySync, type KeyObject } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, statSync, writeSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { format } from "node:util";
import pino, { type DestinationStream, type Level, type LevelWithSilent } from "pino";

// =============================================================================
// Run context
// =============================================================================

interface RunContext {
  runId: string;
  signal?: AbortSignal;
  /** When the run's deadline passes, on the monotonic clock (`performance.now()`). */
  deadlineAt?: number;
}

const runContext = new AsyncLocalStorage<RunContext>();

/**
 * Runs `fn` as part of run `runId`: every line logged from it (sync or async) carries the id.
 * `signal` is the run's own signal, the one a cancel of the run aborts (a client that left, the
 * run's deadline); `deadlineAt` is when that deadline passes, on the monotonic clock
 * (`performance.now()`). Inside an outer `withRun` without them, the outer ones are kept.
 */
export function withRun<T>(
  runId: string,
  fn: () => T,
  options: { signal?: AbortSignal; deadlineAt?: number } = {},
): T {
  const outer = runContext.getStore();
  const signal = options.signal ?? outer?.signal;
  const deadlineAt = options.deadlineAt ?? outer?.deadlineAt;
  return runContext.run(
    { runId, ...(signal ? { signal } : {}), ...(deadlineAt !== undefined ? { deadlineAt } : {}) },
    fn,
  );
}

/** The id of the run the current code belongs to, if any. */
export function currentRunId(): string | undefined {
  return runContext.getStore()?.runId;
}

/** The signal of the run the current code belongs to, when the run was given one. */
export function currentRunSignal(): AbortSignal | undefined {
  return runContext.getStore()?.signal;
}

/**
 * How many milliseconds the run the current code belongs to has left before its deadline, on
 * the monotonic clock; undefined when the run was given no deadline (a graph run outside the
 * routes).
 */
export function currentRunTimeLeft(): number | undefined {
  const deadlineAt = runContext.getStore()?.deadlineAt;
  return deadlineAt === undefined ? undefined : deadlineAt - performance.now();
}

// =============================================================================
// Scrubbing
// =============================================================================

const REDACTED = "[redacted]";
const PREVIEW_LINK = "[preview link]";
const PROVIDER_ENDPOINT = "[provider endpoint]";
/** What a log call writes when the fields it was given cannot be read. */
const UNWRITABLE = "log line could not be written";

/** Longest text scrubbed and written, in characters; the rest is cut off. */
export const MAX_LOGGED_TEXT = 16 * 1024;
const TRUNCATED = "…[truncated]";

/** Hosts of the signed 30-second preview clips: Spotify's and Deezer's. */
const PREVIEW_HOST = /(?:^|\.)(?:p\.scdn\.co|dzcdn\.net)$/i;
/** A preview host written without a scheme, with whatever path and query follow it. */
const BARE_PREVIEW =
  /(?<![\w.-])(?:(?:[\w-]{1,63}\.){0,8}dzcdn\.net|p\.scdn\.co)(?![\w-])(?:[/?#][^\s"'<>`]*)?/gi;
/** Azure OpenAI resource hosts, configured or not. Starts only at a host's first character. */
const PROVIDER_HOST =
  /(?<![a-z0-9.-])[a-z0-9][a-z0-9.-]{0,252}\.(?:openai|cognitiveservices|services\.ai)\.azure\.com(?![a-z0-9-])/gi;
const URL_IN_TEXT = /\bhttps?:\/\/[^\s"'<>\\`]+/gi;
/** Credentials written into a URL (`https://user:password@host`). */
const USERINFO = /^(https?:\/\/)[^/?#@\s]+@/i;
/** Query parameters that carry a key, a token or a signature (run tokens and Turnstile's too). */
const SECRET_PARAM =
  /([?&;~](?:api[-_]?key|apikey|api[-_]?sig|sk|key|token|access[-_]?token|run[-_]?token|turnstile[-_]?token|client[-_]?secret|secret|sig|signature|hdnea|hdnts|auth|password|subscription[-_]?key|x-amz-signature|x-amz-credential)=)[^&#\s"'<>\\]*/gi;
/** Authorization values: a Bearer token, Basic credentials, a Discogs token; quoted or not. */
const AUTH_SCHEME =
  /\b(Bearer\s+|Discogs\s+token=)(?!["']?\[redacted\])["']?[^\s"',;}\]]+["']?|\b(Basic\s+)["']?[A-Za-z0-9+/=]{8,}["']?/gi;
/** Names whose value is secret, in `name: value` and `name=value` pairs (SECRET_PAIR). */
const PAIR_NAMES =
  "(?:x-)?api[-_]?key|apikey|(?:ocp-apim-)?subscription[-_]?key|authorization|access[-_]?token|refresh[-_]?token|run[-_]?token|turnstile[-_]?token|client[-_]?secret|password|secret|token";
/** The Authorization schemes. */
const SCHEMES = "(?:Bearer|Basic|Discogs)";
/** A quote that can open a value: util.inspect writes backticks when a string holds both others. */
const QUOTE = "[`\"']";
/** A character of a pair's value. */
const VALUE_CHAR = String.raw`[^\s"'&,;}\]]`;
/**
 * After a scheme, whether the next word (quoted or not) holds the start of a rule that would run
 * on past it: an Authorization scheme followed by a space, or a pair's name whose value lies
 * beyond the word. A pair that took the word with the scheme would hide that start, and the
 * secret after it would stay.
 */
const RULE_IN_NEXT_WORD = String.raw`["']?${VALUE_CHAR}*?\b(?:${SCHEMES}\s|(?:${PAIR_NAMES})(?:["'\s]\s*[:=]|[:=](?!${VALUE_CHAR})))`;
/**
 * `name: value` or `name=value` pairs whose name says the value is secret; quoted or not. The
 * whitespace after ":" or "=" is taken whole (a value never starts with a space), so a long run
 * of it is not read again from each of its characters.
 *
 * An Authorization scheme before the value is taken with it (the third group), inside the quotes
 * too (`authorization: 'Bearer …'`, as util.inspect writes a headers object, with backticks when
 * the text holds both quotes): taken as the value alone, the scheme word would leave the token
 * after it. Inside the quotes only spaces and tabs follow a scheme, so a line break after one
 * keeps the next line. Two or more schemes in a row (`Bearer Bearer <token>`) are taken together,
 * with the word after them as the value. The schemes after the first, and a quoted scheme at
 * all, are taken only when the word after them holds no start of another rule
 * (RULE_IN_NEXT_WORD: `'Bearer token: <token>'`, `'Bearer "Bearer <token>"'`); otherwise the pair
 * takes what it always did, the first scheme word (with its quote) or an unquoted scheme and one
 * word, and the rules after it find the rest.
 */
export const SECRET_PAIR = new RegExp(
  String.raw`\b(${PAIR_NAMES})(["']?\s*[:=]\s*(?!\s))` +
    String.raw`(?!\s*(?:${QUOTE}${SCHEMES}[ \t]+|${SCHEMES}\s+)?["']?\[redacted\])` +
    String.raw`((?:${QUOTE}${SCHEMES}[ \t]+(?:${SCHEMES}[ \t]+)*(?!${RULE_IN_NEXT_WORD})` +
    String.raw`|${SCHEMES}\s+(?:(?:${SCHEMES}\s+)+(?!${RULE_IN_NEXT_WORD}))?))?` +
    `["']?${VALUE_CHAR}+["']?`,
  "gi",
);

/** Environment variables whose values are never written: keys, secrets, tokens, endpoints. */
const SECRET_ENV_NAME = /(?:KEY|SECRET|TOKEN|PASSWORD|SALT|ENDPOINT|BASE_URL)$/;
/** Values shorter than this, or only digits, are not scrubbed (they match ordinary text). */
const MIN_SECRET_LENGTH = 8;
const NUMERIC = /^[\d.]+$/;

let secretValues: string[] = [];
/** The same values as they appear inside a JSON string, where they differ. */
let escapedSecretValues: string[] = [];
let secretHosts: string[] = [];

/** Reads the values to scrub from the environment: secrets, and the hosts of endpoint URLs. */
function collectSecrets(env: NodeJS.ProcessEnv): void {
  const values = new Set<string>();
  const hosts = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (!value || !SECRET_ENV_NAME.test(name)) continue;
    const trimmed = value.trim();
    // An endpoint is scrubbed by its host, so a line still says it was the provider endpoint.
    if (!/^https?:\/\//i.test(trimmed)) {
      if (trimmed.length >= MIN_SECRET_LENGTH && !NUMERIC.test(trimmed)) values.add(trimmed);
    } else {
      try {
        const { host, hostname } = new URL(trimmed);
        if (hostname && hostname !== "localhost" && hostname !== "127.0.0.1") {
          hosts.add(host);
          hosts.add(hostname);
        }
      } catch {
        // not a URL after all
      }
    }
  }
  // Longest first, so a value that contains another is replaced whole.
  secretValues = [...values].sort((a, b) => b.length - a.length);
  escapedSecretValues = secretValues
    .map((value) => JSON.stringify(value).slice(1, -1))
    .filter((escaped, i) => escaped !== secretValues[i]);
  secretHosts = [...hosts].sort((a, b) => b.length - a.length);
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return /^https?:\/\/([^/?#:]+)/i.exec(url)?.[1] ?? null;
  }
}

function replaceAll(text: string, values: readonly string[], replacement: string): string {
  let out = text;
  for (const value of values) {
    if (out.includes(value)) out = out.split(value).join(replacement);
  }
  return out;
}

/** Any value as text, without throwing. */
function asText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return String(value);
  } catch {
    return "[unreadable]";
  }
}

/**
 * Text made safe for the log: configured secret values, preview links, the provider endpoint,
 * keys and signatures in URLs, Authorization values and Bearer tokens are replaced, and text
 * longer than MAX_LOGGED_TEXT is cut off. Never throws.
 */
export function scrub(input: unknown): string {
  try {
    let out = replaceAll(asText(input), secretValues, REDACTED);
    // The cap falls on the text as it came, never inside a link or a host (logCut), whose part
    // the rules below would no longer know, nor inside an Authorization credential, whose part
    // can be too short for its rule (a Basic one needs 8 characters). Replaced first, they would
    // shorten the text and let in more of it.
    if (out.length > MAX_LOGGED_TEXT) {
      out = `${out.slice(0, logCut(out, MAX_LOGGED_TEXT, [], { pairs: false }))}${TRUNCATED}`;
    }
    out = out.replace(URL_IN_TEXT, (url) => {
      const host = hostOf(url);
      if (host && PREVIEW_HOST.test(host)) return PREVIEW_LINK;
      if (host && secretHosts.includes(host)) return PROVIDER_ENDPOINT;
      return url.replace(USERINFO, `$1${REDACTED}@`).replace(SECRET_PARAM, `$1${REDACTED}`);
    });
    out = replaceAll(out, secretHosts, PROVIDER_ENDPOINT)
      .replace(BARE_PREVIEW, PREVIEW_LINK)
      .replace(PROVIDER_HOST, PROVIDER_ENDPOINT);
    return out
      .replace(SECRET_PAIR, `$1$2${REDACTED}`)
      .replace(
        AUTH_SCHEME,
        (_match, scheme?: string, basic?: string) => `${scheme ?? basic}${REDACTED}`,
      );
  } catch {
    return "[unreadable]";
  }
}

/**
 * A text as scrub has rewritten it so far: its character i stands for [from[i], to[i]) of the
 * text it was given, or for character i itself while nothing is rewritten (no `from`, `to`).
 */
interface Rewritten {
  text: string;
  from?: Int32Array;
  to?: Int32Array;
}

/**
 * A part of a rewritten text that a rule replaces, [start, end), with `replacement`; of it, what
 * stands for a secret is [hideStart, hideEnd): the quotes around a value and the scheme word
 * before one name it, and hold no secret.
 */
type Rewrite = [
  start: number,
  end: number,
  replacement: string,
  hideStart: number,
  hideEnd: number,
];

/** `current` with each of `parts` (sorted, not overlapping) replaced; adds what each hides. */
function rewrite(
  current: Rewritten,
  parts: readonly Rewrite[],
  hidden: Array<[number, number]>,
): Rewritten {
  if (parts.length === 0) return current;
  const fromOf = (i: number) => (current.from ? (current.from[i] ?? 0) : i);
  const toOf = (i: number) => (current.to ? (current.to[i] ?? 0) : i + 1);
  // The parts replaced: those that start where the one before ended, or later.
  const used: Rewrite[] = [];
  let length = current.text.length;
  for (let i = 0, at = 0; i < parts.length; i++) {
    const part = parts[i] as Rewrite;
    if (part[0] < at || part[1] <= part[0]) continue;
    used.push(part);
    length += part[2].length - (part[1] - part[0]);
    at = part[1];
  }
  const from = new Int32Array(length);
  const to = new Int32Array(length);
  const chunks: string[] = [];
  let at = 0;
  let out = 0;
  const keep = (end: number) => {
    chunks.push(current.text.slice(at, end));
    if (current.from && current.to) {
      from.set(current.from.subarray(at, end), out);
      to.set(current.to.subarray(at, end), out);
      out += end - at;
    } else {
      for (let i = at; i < end; i++, out++) {
        from[out] = i;
        to[out] = i + 1;
      }
    }
  };
  for (const [start, end, replacement, hideStart, hideEnd] of used) {
    keep(start);
    const first = fromOf(start);
    const last = toOf(end - 1);
    if (hideEnd > hideStart) hidden.push([fromOf(hideStart), toOf(hideEnd - 1)]);
    chunks.push(replacement);
    from.fill(first, out, out + replacement.length);
    to.fill(last, out, out + replacement.length);
    out += replacement.length;
    at = end;
  }
  keep(current.text.length);
  return { text: chunks.join(""), from, to };
}

/** Each place a value appears in `text`, left to right, as split() finds it, as a Rewrite. */
function occurrences(text: string, value: string, replacement: string): Rewrite[] {
  const parts: Rewrite[] = [];
  for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + value.length)) {
    parts.push([at, at + value.length, replacement, at, at + value.length]);
  }
  return parts;
}

/** A value a rule replaces from `from` to `to`, without the quotes around it, as a Rewrite. */
function valueRewrite(text: string, from: number, to: number): Rewrite {
  let start = from;
  let end = to;
  if (/["']/.test(text.charAt(start))) start++;
  if (end > start && /["']/.test(text.charAt(end - 1))) end--;
  return [from, to, REDACTED, start, end];
}

/**
 * Where scrub replaces something in `text`, as [start, end) spans sorted by start, none
 * overlapping another: its rules replayed in its order, each on the text the rules before it
 * left (configured values, links, configured hosts, preview and provider hosts, secret pairs,
 * Authorization values), and what each replaces found where it stood in `text`. The quotes
 * (`'` and `"`) around a value and the scheme words before one, which scrub replaces with it, are
 * not in them: they hold no secret, and the redaction that reads these spans keeps them. Two
 * exceptions only hide more: a backtick around a value stays in its span, and so does the word
 * Basic before a credential that scrub's Authorization rule replaces (see readPairs). The configured
 * values as JSON writes them (with `"`, `\` or a control character escaped) are in them too,
 * although scrub does not replace them in a text: the last pass over a line replaces only what
 * it writes itself from a value, and one written already escaped in a text is escaped again
 * there. The cap is not applied: past it, a span holds text scrub cuts off. The redaction
 * of source errors (sources/http.ts) reads them, so that the log line of a text it redacts
 * further never shows what the log line of the text it redacted before hid. Reads the text once
 * per rule. With `pairs` or `auth` false, secret pairs or Authorization values are left out:
 * what is left is what scrub replaces whole, which a part of no longer matches (configured
 * values, links, hosts). With `cut`, the span of a link's user info takes its "@" too, without
 * which the rest is no longer read as user info.
 */
export function scrubbedSpans(
  text: string,
  { pairs = true, auth = true, cut = false }: SpanRules = {},
): Array<[number, number]> {
  const hidden: Array<[number, number]> = [];
  for (const value of escapedSecretValues) {
    for (const [start, end] of occurrences(text, value, REDACTED)) hidden.push([start, end]);
  }
  let current: Rewritten = { text };
  for (const value of secretValues) {
    current = rewrite(current, occurrences(current.text, value, REDACTED), hidden);
  }
  const links: Rewrite[] = [];
  for (const link of current.text.matchAll(URL_IN_TEXT)) {
    const url = link[0];
    const start = link.index;
    const host = hostOf(url);
    if (host && (PREVIEW_HOST.test(host) || secretHosts.includes(host))) {
      const marker = PREVIEW_HOST.test(host) ? PREVIEW_LINK : PROVIDER_ENDPOINT;
      links.push([start, start + url.length, marker, start, start + url.length]);
      continue;
    }
    // User info, then the secret parameters of the link as that left it.
    const userinfo = USERINFO.exec(url);
    let shift = 0;
    let after = 0;
    if (userinfo) {
      const from = start + (userinfo[1] ?? "").length;
      const to = start + userinfo[0].length - 1;
      links.push([from, to, REDACTED, from, cut ? to + 1 : to]);
      shift = REDACTED.length - (to - from);
      after = (userinfo[1] ?? "").length + REDACTED.length + 1;
    }
    const rewritten = userinfo ? url.replace(USERINFO, `$1${REDACTED}@`) : url;
    for (const param of rewritten.matchAll(SECRET_PARAM)) {
      if (param.index < after) continue;
      const from = start + param.index - shift + (param[1] ?? "").length;
      const to = start + param.index - shift + param[0].length;
      if (to > from) links.push([from, to, REDACTED, from, to]);
    }
  }
  current = rewrite(current, links, hidden);
  for (const host of secretHosts) {
    current = rewrite(current, occurrences(current.text, host, PROVIDER_ENDPOINT), hidden);
  }
  for (const [pattern, marker] of [
    [BARE_PREVIEW, PREVIEW_LINK],
    [PROVIDER_HOST, PROVIDER_ENDPOINT],
  ] as const) {
    const parts: Rewrite[] = [];
    for (const match of current.text.matchAll(pattern)) {
      const end = match.index + match[0].length;
      parts.push([match.index, end, marker, match.index, end]);
    }
    current = rewrite(current, parts, hidden);
  }
  readPairs(current, hidden, pairs, auth);
  // Sorted by start, those that overlap or touch as one.
  const merged: Array<[number, number]> = [];
  for (const [start, end] of hidden.filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/** Which of scrub's rules scrubbedSpans reads, and whether for a cut. */
interface SpanRules {
  pairs?: boolean;
  auth?: boolean;
  cut?: boolean;
}

/** scrubbedSpans' last two rules, secret pairs and Authorization values, on `current`. */
function readPairs(
  before: Rewritten,
  hidden: Array<[number, number]>,
  withPairs: boolean,
  withAuth: boolean,
): void {
  let current = before;
  const pairs: Rewrite[] = [];
  for (const pair of withPairs ? current.text.matchAll(SECRET_PAIR) : []) {
    const from = pair.index + (pair[1] ?? "").length + (pair[2] ?? "").length;
    const part = valueRewrite(current.text, from, pair.index + pair[0].length);
    // An Authorization scheme the pair took before the value names it; it is not in the span.
    const scheme = pair[3] ?? "";
    if (scheme && from + scheme.length < part[1]) part[3] = Math.max(part[3], from + scheme.length);
    pairs.push(part);
  }
  current = rewrite(current, pairs, hidden);
  const auths: Rewrite[] = [];
  for (const auth of withAuth ? current.text.matchAll(AUTH_SCHEME) : []) {
    // A Basic credential's span keeps its scheme word, as it always has: spans that touch are
    // merged, so with the word a cut through the credential also falls before a host or a value
    // written right before it, and without it the cut would show them where it hid them before.
    const from = auth.index + (auth[1] ?? "").length;
    auths.push(valueRewrite(current.text, from, auth.index + auth[0].length));
  }
  rewrite(current, auths, hidden);
}

/**
 * How far past a cut logCut reads a text for the rules other than configured values: links,
 * hosts, pairs and Authorization values that cross the cut are found there. A link whose user
 * info runs on past it is the one such match it can miss.
 */
const LOG_CUT_WINDOW = 4096;

/**
 * Where a cut of `text` at `at` falls when it never splits what scrub hides (scrubbedSpans, the
 * rules `rules` names, all by default) or one of the `extra` spans: at the start of the first
 * such span it would split, since a part of one no longer matches, until none is split. The
 * rules read the text up to LOG_CUT_WINDOW characters past `at`; a configured value that crosses
 * the cut is looked up around it, however long. Once the cut has moved, it also falls before an
 * Authorization credential of the text as it came that crosses it: matched there, the credential
 * ran on into what the cut now leaves out, and what is left of it may be too short for its rule.
 * That second span starts after the scheme word, which holds no secret, so a cut that moved
 * there stops after `Basic ` (before #235 it went back before the word; in a credential glued
 * to a link or a host, the text before the word that such a cut used to leave out is now kept,
 * whole, with what the rules hide in it hidden). A cut through a Basic credential that only the
 * rules moved still falls before the word Basic, which its span from scrubbedSpans keeps
 * (readPairs).
 *
 * It places the cuts that decide how much of a text a log line shows: scrub's cap, logText's
 * (http/middleware/errors.ts), and those of the redaction of source errors (safeCut and lineCut
 * in sources/http.ts). It does not make every slice of such a text. plainLine slices a line to
 * its length before it masks it, and then moves that cut with lineCut; after their cuts here,
 * plainLine and scrubText slice the redacted text to their length once more, which only takes
 * the characters of a mask the cut fell inside; serializeError cuts a scrubbed code and a few
 * other short fields to 100 characters; and llm/invoke.ts cuts a model error's message, already
 * redacted (scrubSecrets), to 500 and 300 characters before it reaches a log line.
 */
export function logCut(
  text: string,
  at: number,
  extra: ReadonlyArray<readonly [number, number]> = [],
  rules: Omit<SpanRules, "cut"> = {},
): number {
  if (at <= 0 || at >= text.length) return at;
  const window = text.slice(0, at + LOG_CUT_WINDOW);
  const spans = [...scrubbedSpans(window, { ...rules, cut: true }), ...extra];
  const end = settle(text, spans, at);
  if (end === at) return at;
  const credentials: Array<[number, number]> = [];
  for (const auth of window.matchAll(AUTH_SCHEME)) {
    credentials.push([auth.index + (auth[1] ?? auth[2] ?? "").length, auth.index + auth[0].length]);
  }
  return settle(text, [...spans, ...credentials], end);
}

/**
 * `at`, moved to the start of each of `spans`, or of a configured value of `text`, that it falls
 * inside, until it falls inside none.
 */
function settle(text: string, spans: ReadonlyArray<readonly [number, number]>, at: number): number {
  let end = at;
  for (let moved = true; moved; ) {
    moved = false;
    for (const [start, stop] of [...spans, ...valuesAcross(text, end)]) {
      if (start < end && end < stop) {
        end = start;
        moved = true;
      }
    }
  }
  return end;
}

/** Where a configured value (or its escaped form) of `text` crosses `at`: read around it only. */
function valuesAcross(text: string, at: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const value of [...secretValues, ...escapedSecretValues]) {
    if (value.length < 2) continue;
    const from = Math.max(0, at - value.length + 1);
    const around = text.slice(from, at + value.length - 1);
    for (let i = around.indexOf(value); i !== -1; i = around.indexOf(value, i + 1)) {
      out.push([from + i, from + i + value.length]);
    }
  }
  return out;
}

/**
 * The last pass, over the serialized line: only the configured secret values (as JSON writes
 * them) and endpoint hosts, which no JSON syntax is part of. A line this pass would make
 * unreadable is written as it was (its strings were scrubbed already).
 */
function scrubLine(line: string): string {
  try {
    let out = replaceAll(line, secretValues, REDACTED);
    out = replaceAll(out, escapedSecretValues, REDACTED);
    out = replaceAll(out, secretHosts, PROVIDER_ENDPOINT);
    if (out === line) return line;
    JSON.parse(out);
    return out;
  } catch {
    return withheldLine(line);
  }
}

/**
 * A line in which a configured secret could not be replaced without breaking
 * its JSON is not written; a short line saying so keeps its level, time,
 * component and run id.
 */
function withheldLine(line: string): string {
  const kept: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    for (const field of ["level", "time", "pid", "component", "runId"]) {
      const value = parsed[field];
      if (typeof value === "string" || typeof value === "number") kept[field] = value;
    }
  } catch {
    kept.level = "warn";
  }
  kept.msg = "log line withheld: it contained a configured secret";
  return `${JSON.stringify(kept)}\n`;
}

/** Fields whose value is never written, whatever it holds: these names exactly… */
const SECRET_FIELD =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|headers|key|sig|signature|preview|endpoint|base[-_]?url|baseurl|config|request|response|body)$/i;
/** …and any name that contains one of these. */
const SECRET_FIELD_PART =
  /token|secret|api[-_]?key|password|passwd|subscription[-_]?key|credential|preview[-_]?url/i;
/** Counts named after tokens (`inputTokens`, `tokenCount`, `input_tokens_details`), not secrets. */
const TOKEN_COUNT_FIELD = /tokens$|token[-_]?count$|tokens?[-_]details$/i;
/** Fields that hold text a visitor typed: written at debug level only. */
const QUERY_FIELD = /^(?:query|songQuery|q)$/;

const MAX_DEPTH = 6;
const MAX_ITEMS = 50;
const MAX_ERRORS = 10;
const LEVEL_DEBUG = 20;
const LEVEL_INFO = 30;

/**
 * Whether a field's value is replaced. Numbers and booleans are kept whatever the name
 * (`apiKeyConfigured: true`, `response: 503`); a list under a token-count name is still a list
 * of secrets (`refreshTokens`).
 */
function isSecretField(name: string, value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "number" || typeof value === "boolean") return false;
  if (SECRET_FIELD.test(name)) return true;
  if (!SECRET_FIELD_PART.test(name)) return false;
  return Array.isArray(value) || !TOKEN_COUNT_FIELD.test(name);
}

/** How long a typed query was: characters of a string, items of a list, text of anything else. */
function queryLength(value: unknown): number {
  if (typeof value === "string") return [...value].length;
  if (Array.isArray(value)) return value.length;
  try {
    return (JSON.stringify(value) ?? "").length;
  } catch {
    return 0;
  }
}

/** Reads one property, or undefined when reading it throws. */
function read(object: object, key: string): unknown {
  try {
    return (object as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/**
 * An error as a log field: its type, scrubbed message and stack, code, status, the kind of
 * failure and how long to wait (the API's own errors), why an answer was cut off, its cause and
 * the errors of an AggregateError. Nothing else an error carries (a client's request config,
 * headers, a response body) is kept. Never throws.
 */
export function serializeError(err: unknown, depth = 0): unknown {
  try {
    if (!(err instanceof Error)) {
      return err !== null && typeof err === "object" ? sanitize(err, LEVEL_INFO, depth) : err;
    }
    const out: Record<string, unknown> = {
      type: scrub(read(err, "name") ?? "Error"),
      message: scrub(read(err, "message") ?? ""),
    };
    const code = read(err, "code");
    if (typeof code === "number") out.code = code;
    else if (typeof code === "string") out.code = scrub(code).slice(0, 100);
    const status = read(err, "status");
    const statusCode = read(err, "statusCode");
    if (typeof status === "number") out.status = status;
    else if (typeof statusCode === "number") out.status = statusCode;
    for (const key of ["kind", "source", "incompleteReason"]) {
      const value = read(err, key);
      if (typeof value === "string") out[key] = scrub(value).slice(0, 100);
    }
    const retryAfterMs = read(err, "retryAfterMs");
    if (typeof retryAfterMs === "number" || retryAfterMs === null) out.retryAfterMs = retryAfterMs;
    const stack = read(err, "stack");
    if (stack !== undefined) out.stack = scrub(stack);
    const cause = read(err, "cause");
    if (cause !== undefined && depth < 3) out.cause = serializeError(cause, depth + 1);
    const errors = read(err, "errors");
    if (err instanceof AggregateError && Array.isArray(errors) && depth < 3) {
      out.errors = errors.slice(0, MAX_ERRORS).map((each) => serializeError(each, depth + 1));
    }
    return out;
  } catch {
    return { type: "Error", message: "[unreadable error]" };
  }
}

/**
 * A log field made safe: secret fields replaced, errors serialized, strings scrubbed, a typed
 * query replaced by its length unless the line is at debug level or below. Never throws: what
 * cannot be read is written as "[unreadable]".
 */
function sanitize(value: unknown, level: number, depth = 0): unknown {
  try {
    if (typeof value === "string") return scrub(value);
    if (value === null || typeof value !== "object") return value;
    if (value instanceof Error) return serializeError(value, depth);
    if (depth >= MAX_DEPTH) return "[nested too deep]";
    if (value instanceof Date) return value.toISOString();
    if (ArrayBuffer.isView(value)) return `[${value.byteLength} bytes]`;
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_ITEMS).map((item) => sanitize(item, level, depth + 1));
      if (value.length > MAX_ITEMS) items.push(`[${value.length - MAX_ITEMS} more]`);
      return items;
    }
    const out: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(value)) {
      if (isSecretField(key, field)) out[key] = REDACTED;
      else if (QUERY_FIELD.test(key) && level > LEVEL_DEBUG) {
        out[`${key}Length`] = queryLength(field);
      } else out[key] = sanitize(field, level, depth + 1);
    }
    return out;
  } catch {
    return "[unreadable]";
  }
}

// =============================================================================
// Client addresses
// =============================================================================

/** The key of the address hash: LOG_IP_SALT, or a key made for this process. */
const processKey = () => generateKeySync("hmac", { length: 256 });
let ipSalt: KeyObject | string = processKey();

/**
 * A keyed hash of a client address (16 hex characters), so requests from one address can be
 * told apart without the address being written.
 */
export function ipHash(ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  return createHmac("sha256", ipSalt).update(ip).digest("hex").slice(0, 16);
}

// =============================================================================
// Logger
// =============================================================================

export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

function isLevel(value: string): value is LevelWithSilent {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

/** Where lines go: stdout (whose errors lifecycle.ts handles), and the LOG_FILE descriptor. */
let sink: (line: string) => void = (line) => {
  process.stdout.write(line);
};
let file: { fd: number; path: string } | null = null;

function writeFileLine(line: string): void {
  if (!file) return;
  try {
    writeSync(file.fd, line);
  } catch (error) {
    // Reported once on stderr (not through the logger, which would try the file again).
    process.stderr.write(
      `Could not write to LOG_FILE ${file.path}; logging to stdout only: ${scrub(error)}\n`,
    );
    file = null;
  }
}

const destination: DestinationStream = {
  write(line: string) {
    sink(line);
    writeFileLine(line);
  },
};

/** The arguments of a log call made safe (fields sanitized, strings scrubbed). Never throws. */
function safeArgs(args: unknown[], level: number): unknown[] {
  const [first, ...rest] = args;
  try {
    const strings = rest.map((arg) => (typeof arg === "string" ? scrub(arg) : arg));
    if (first !== null && typeof first === "object") {
      const fields = first instanceof Error ? { err: first } : first;
      return [sanitize(fields, level), ...strings];
    }
    return [typeof first === "string" ? scrub(first) : first, ...strings];
  } catch {
    const component =
      first !== null && typeof first === "object" ? read(first, "component") : undefined;
    return [typeof component === "string" ? { component: scrub(component) } : {}, UNWRITABLE];
  }
}

const root = pino(
  {
    level: initialLevel(process.env),
    base: { pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    mixin: () => {
      const runId = currentRunId();
      return runId ? { runId } : {};
    },
    serializers: { err: (err: unknown) => serializeError(err) },
    hooks: {
      logMethod(args, method, level) {
        method.apply(this, safeArgs(args, level) as Parameters<typeof method>);
      },
      streamWrite: scrubLine,
    },
  },
  destination,
);

function initialLevel(env: NodeJS.ProcessEnv): LevelWithSilent {
  const level = env.LOG_LEVEL?.trim().toLowerCase();
  return level && isLevel(level) ? level : "info";
}

/**
 * Opens LOG_FILE for appending, readable by its owner only when it is created. Anything that is
 * not a regular file (a FIFO would hold startup until something reads it) is refused. Returns
 * the descriptor, or why the file is not used; `warning` is a concern about a file that is used.
 */
function openLogFile(path: string): { fd?: number; refused?: string; warning?: string } {
  try {
    const existing = statSync(path, { throwIfNoEntry: false });
    if (existing && !existing.isFile()) return { refused: "is not a regular file" };
    mkdirSync(dirname(path), { recursive: true });
    const fd = openSync(
      path,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NONBLOCK,
      0o600,
    );
    const opened = fstatSync(fd);
    if (!opened.isFile()) {
      closeSync(fd);
      return { refused: "is not a regular file" };
    }
    const warning =
      (opened.mode & 0o077) !== 0
        ? `LOG_FILE ${path} can be read or written by other users (mode ${(opened.mode & 0o777).toString(8)}); chmod 600 it`
        : undefined;
    return { fd, warning };
  } catch (error) {
    return { refused: `cannot be opened (${scrub(error)})` };
  }
}

/**
 * Reads LOG_LEVEL, LOG_FILE (a relative path is taken from `baseDir`) and LOG_IP_SALT, and the
 * secret values to scrub, from `env`. Returns warnings for settings it could not use (an unknown
 * level, a file it cannot or will not open) or that are unsafe (a file others can read).
 */
export function configureLogger(
  env: NodeJS.ProcessEnv = process.env,
  { baseDir = process.cwd() }: { baseDir?: string } = {},
): string[] {
  const warnings: string[] = [];
  collectSecrets(env);

  const level = env.LOG_LEVEL?.trim().toLowerCase();
  if (level && !isLevel(level)) {
    warnings.push(`LOG_LEVEL=${scrub(level)} is not one of ${LOG_LEVELS.join(", ")}; using info`);
    root.level = "info";
  } else {
    root.level = (level || "info") as LevelWithSilent;
  }

  ipSalt = env.LOG_IP_SALT ? env.LOG_IP_SALT : processKey();

  if (file) {
    closeSync(file.fd);
    file = null;
  }
  const given = env.LOG_FILE?.trim();
  if (given) {
    const path = isAbsolute(given) ? given : resolve(baseDir, given);
    const opened = openLogFile(path);
    if (opened.fd !== undefined) file = { fd: opened.fd, path };
    else warnings.push(`LOG_FILE ${path} ${opened.refused}; logging to stdout only`);
    if (opened.warning) warnings.push(opened.warning);
  }
  return warnings;
}

type Fields = Record<string, unknown>;

export interface Log {
  debug(message: string, fields?: Fields): void;
  info(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
}

/**
 * The log of one part of the API (`component`, e.g. "Scout" or "HTTP"). Fields go into the line
 * after the redaction above; pass an error as `err`. Never throws because of its fields.
 */
export function logger(component: string): Log {
  const write = (level: Level) => (message: string, fields?: Fields) => {
    let merged: Fields;
    try {
      merged = { component, ...fields };
    } catch {
      root[level]({ component }, UNWRITABLE);
      return;
    }
    root[level](merged, message);
  };
  return { debug: write("debug"), info: write("info"), warn: write("warn"), error: write("error") };
}

// =============================================================================
// Console bridge
// =============================================================================

type ConsoleMethod = "log" | "info" | "warn" | "error" | "debug";

const CONSOLE_LEVELS: Record<ConsoleMethod, Level> = {
  log: "info",
  info: "info",
  warn: "warn",
  error: "error",
  debug: "debug",
};

/** A leading "[Tag]" (after any emoji), taken as the line's component. */
const LEADING_TAG =
  /^\s*(?:(?:\p{Extended_Pictographic}|\u{FE0F}|\u{200D})+\s*)?\[([^\]\n]{1,40})\]:?\s*/u;

/**
 * One console call as a log line: the text formatted as console would, every object and error
 * sanitized first, the first error as the line's `err`.
 */
function bridgeLine(level: Level, args: unknown[]): void {
  if (!root.isLevelEnabled(level)) return;
  let fields: Fields;
  let message: string;
  try {
    const levelValue = root.levels.values[level];
    const err = args.find((arg) => arg instanceof Error);
    const shown = args
      .filter((arg) => arg !== err)
      .map((arg) => (arg !== null && typeof arg === "object" ? sanitize(arg, levelValue) : arg));
    const text = format(...shown);
    const tag = LEADING_TAG.exec(text);
    const untagged = tag ? text.slice(tag[0].length) : text;
    // "Could not read the file:" followed by the error: the error is a field of its own.
    message = err ? untagged.replace(/:\s*$/, "") : untagged;
    fields = { ...(tag ? { component: tag[1] } : {}), ...(err ? { err } : {}) };
  } catch {
    fields = {};
    message = UNWRITABLE;
  }
  root[level](fields, message);
}

/**
 * Sends console.log/info/warn/error/debug through the logger (as JSON lines, scrubbed, with the
 * run id). Returns a function that puts the console back.
 */
export function installConsoleBridge(target: Console = console): () => void {
  const originals = Object.fromEntries(
    (Object.keys(CONSOLE_LEVELS) as ConsoleMethod[]).map((method) => [method, target[method]]),
  ) as Record<ConsoleMethod, Console[ConsoleMethod]>;
  for (const [method, level] of Object.entries(CONSOLE_LEVELS) as [ConsoleMethod, Level][]) {
    target[method] = (...args: unknown[]) => bridgeLine(level, args);
  }
  return () => {
    Object.assign(target, originals);
  };
}

// =============================================================================
// Tests
// =============================================================================

export interface CapturedLogs {
  /** The lines written since the capture started, as written. */
  lines(): string[];
  /** The same lines, parsed. */
  entries(): Array<Record<string, unknown>>;
  /** The messages (`msg`) of the lines, or of the lines at `level`. */
  messages(level?: Level): string[];
  /** Forgets the lines captured so far. */
  clear(): void;
  /** Stops capturing: lines go to stdout again, at the previous level. */
  restore(): void;
}

/**
 * For tests: collects the lines written from now on (at `level` and above, debug by default)
 * instead of writing them. Each line is parsed as it is written, so a line that is not JSON
 * fails the test. `onLine` sees each line as it is written; what it throws, the log call throws.
 */
export function captureLogsForTests(
  options: { level?: LevelWithSilent; onLine?: (entry: Record<string, unknown>) => void } = {},
): CapturedLogs {
  const { level = "debug", onLine } = options;
  const previous = { sink, level: root.level };
  const lines: string[] = [];
  sink = (line) => {
    const text = line.replace(/\n$/, "");
    lines.push(text);
    const entry = JSON.parse(text) as Record<string, unknown>;
    onLine?.(entry);
  };
  root.level = level;
  return {
    lines: () => [...lines],
    entries: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    messages: (level) =>
      lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((entry) => level === undefined || entry.level === level)
        .map((entry) => String(entry.msg)),
    clear: () => {
      lines.length = 0;
    },
    restore: () => {
      sink = previous.sink;
      root.level = previous.level;
    },
  };
}
