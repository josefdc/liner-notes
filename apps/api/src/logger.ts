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
 *   is scrubbed of configured secret values (as they came, escaped as JSON writes them, or with
 *   their line breaks folded into spaces), Authorization values and Bearer tokens, keys and
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
/**
 * What a configured value is written as while scrub's rules read the text (MASK), as long as
 * REDACTED, which it becomes once they have. The rules read a token through it, and never through
 * a REDACTED the text already held: such a text was redacted before (sources/http.ts masks what a
 * log line of it would not hide, by what these rules hide in it). Its two private-use characters,
 * where a text holds them, are read as two others it does not hold, and written back (standIns).
 */
const HIDDEN_VALUE = "\uE000redacted\uE001";
/** The characters of HIDDEN_VALUE that a text can hold too. */
const PRIVATE_MARKS = /[\uE000\uE001]/g;
/** The private-use characters other than HIDDEN_VALUE's. */
const OTHER_PRIVATE = /[\uE002-\uF8FF]/g;
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
/**
 * A link in a text. It does not take Bearer or Basic glued to its end before a space
 * (`…/xBearer <token>`): the Authorization rule reads them, with the credential after them.
 */
const URL_IN_TEXT = /\bhttps?:\/\/(?:(?!(?<=[A-Za-z0-9_])(?:Bearer|Basic)[ \t])[^\s"'<>\\`])+/gi;
/** Credentials written into a URL (`https://user:password@host`). */
const USERINFO = /^(https?:\/\/)[^/?#@\s]+@/i;
/** Query parameters that carry a key, a token or a signature (run tokens and Turnstile's too). */
const SECRET_PARAM =
  /([?&;~](?:api[-_]?key|apikey|api[-_]?sig|sk|key|token|access[-_]?token|run[-_]?token|turnstile[-_]?token|client[-_]?secret|secret|sig|signature|hdnea|hdnts|auth|password|subscription[-_]?key|x-amz-signature|x-amz-credential)=)[^&#\s"'<>\\]*/gi;
/** Names whose value is secret, in `name: value` and `name=value` pairs (SECRET_PAIR). */
const PAIR_NAMES =
  "(?:x-)?api[-_]?key|apikey|(?:ocp-apim-)?subscription[-_]?key|authorization|access[-_]?token|refresh[-_]?token|run[-_]?token|turnstile[-_]?token|client[-_]?secret|password|secret|token";
/** The Authorization schemes. */
const SCHEMES = "(?:Bearer|Basic|Discogs)";
/** A quote that can open a value: util.inspect writes backticks when a string holds both others. */
const QUOTE = "[`\"']";
/** A character of a pair's value; never the end of a MASK, as never the end of a REDACTED. */
const VALUE_CHAR = String.raw`[^\s"'&,;}\]\uE001]`;
/**
 * A configured value (configuredSpans) as the rules that read keys and schemes see it: replaced
 * before them, by HIDDEN_VALUE. In a token, it stands for part of the token.
 */
const MASK = String.raw`\uE000redacted\uE001`;
/** A REDACTED the text held already: a value that starts with one is left, as it always was. */
const MASKED_BEFORE = String.raw`\[redacted\]`;
/** A character of an Authorization value. */
const AUTH_CHAR = String.raw`[^\s"',;}\]\uE001]`;
/**
 * After a MASK, whether the rest of the word holds an Authorization scheme followed by a space,
 * which the Authorization rule reads as the start of a value of its own.
 */
const SCHEME_IN_REST = String.raw`${AUTH_CHAR}*?\b${SCHEMES}\s`;
/**
 * Authorization values: a Bearer token, Basic credentials, a Discogs token; quoted or not. A token
 * that holds a configured value (a MASK) is taken whole, the part after the MASK too, unless the
 * rest of the word holds another scheme (SCHEME_IN_REST), whose value this rule then reads; a
 * value that is a MASK alone is left as it is, and so is a Bearer or Discogs value that starts
 * with a REDACTED the text held already (MASKED_BEFORE).
 */
const AUTH_SCHEME = new RegExp(
  String.raw`\b(Bearer\s+|Discogs\s+token=)(?!["']?${MASK}(?:(?!${AUTH_CHAR})|${SCHEME_IN_REST})|["']?${MASKED_BEFORE})` +
    // biome-ignore lint/complexity/noUselessStringRaw: every piece of a pattern is written raw, so a backslash added later stays the pattern's
    String.raw`["']?(?:${MASK}(?!${SCHEME_IN_REST})|${AUTH_CHAR})+["']?` +
    String.raw`|\b(Basic\s+)(?!["']?${MASK}(?:(?!${MASK}|[A-Za-z0-9+/=])|${SCHEME_IN_REST}))` +
    // biome-ignore lint/complexity/noUselessStringRaw: every piece of a pattern is written raw, so a backslash added later stays the pattern's
    String.raw`["']?(?=[A-Za-z0-9+/=]{8}|[A-Za-z0-9+/=]*${MASK}(?!${SCHEME_IN_REST}))` +
    // biome-ignore lint/complexity/noUselessStringRaw: every piece of a pattern is written raw, so a backslash added later stays the pattern's
    String.raw`(?:${MASK}(?!${SCHEME_IN_REST})|[A-Za-z0-9+/=])+["']?`,
  "gi",
);
/**
 * Whether the word ahead holds the start of a rule that would run on past it: an Authorization
 * scheme followed by a space, or a pair's name whose value lies beyond the word.
 */
const RULE_IN_WORD = String.raw`["']?${VALUE_CHAR}*?\b(?:${SCHEMES}\s|(?:${PAIR_NAMES})(?:["'\s]\s*[:=]|[:=](?!${VALUE_CHAR})))`;
/**
 * After a scheme, whether the next word (quoted or not) holds the start of a rule that would run
 * on past it: an Authorization scheme followed by a space, a pair's name whose value lies beyond
 * the word, or an `&`. A pair that took the word with the scheme would hide that start, and the
 * secret after it would stay. A pair's value stops at `&` and the Authorization rule's does not:
 * taken by the pair, a token that holds one would show what follows it.
 */
// biome-ignore lint/complexity/noUselessStringRaw: every piece of a pattern is written raw, so a backslash added later stays the pattern's
const RULE_IN_NEXT_WORD = String.raw`(?:${RULE_IN_WORD}|["']?${VALUE_CHAR}*&)`;
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
 * all, are taken only when the word after them holds no start of another rule and no `&`
 * (RULE_IN_NEXT_WORD: `'Bearer token: <token>'`, `'Bearer "Bearer <token>"'`,
 * `'Bearer Bearer abc&<token>'`); otherwise the pair takes what it always did, the first scheme
 * word (with its quote) or an unquoted scheme and one word, and the rules after it find the rest:
 * the Authorization rule reads a token past an `&`, where a pair's value stops.
 *
 * A value that holds a configured value (a MASK) is taken whole, the part after the MASK too,
 * unless the rest of the word holds the start of another rule (RULE_IN_WORD), which then finds
 * the rest; a value that is a MASK alone is left as it is. After a scheme, a MASK that starts the
 * value is also left when an `&` follows it in the word (RULE_IN_NEXT_WORD): the Authorization
 * rule reads that token past the `&`. A value that starts with a REDACTED the text held already
 * (MASKED_BEFORE), after a scheme or not, is left as it always was.
 */
export const SECRET_PAIR = new RegExp(
  String.raw`\b(${PAIR_NAMES})(["']?\s*[:=]\s*(?!\s))` +
    String.raw`(?!\s*(?:(?:${QUOTE}${SCHEMES}[ \t]+|${SCHEMES}\s+)["']?${MASK}(?:(?!${VALUE_CHAR})|${RULE_IN_NEXT_WORD})` +
    // biome-ignore lint/complexity/noUselessStringRaw: every piece of a pattern is written raw, so a backslash added later stays the pattern's
    String.raw`|["']?${MASK}(?:(?!${VALUE_CHAR})|${RULE_IN_WORD})` +
    String.raw`|(?:${QUOTE}${SCHEMES}[ \t]+|${SCHEMES}\s+)?["']?${MASKED_BEFORE}))` +
    String.raw`((?:${QUOTE}${SCHEMES}[ \t]+(?:${SCHEMES}[ \t]+)*(?!${RULE_IN_NEXT_WORD})` +
    String.raw`|${SCHEMES}\s+(?:(?:${SCHEMES}\s+)+(?!${RULE_IN_NEXT_WORD}))?))?` +
    // biome-ignore lint/complexity/noUselessStringRaw: every piece of a pattern is written raw, so a backslash added later stays the pattern's
    String.raw`["']?(?:${MASK}(?!${RULE_IN_WORD})|${VALUE_CHAR})+["']?`,
  "gi",
);

/** Environment variables whose values are never written: keys, secrets, tokens, endpoints. */
const SECRET_ENV_NAME = /(?:KEY|SECRET|TOKEN|PASSWORD|SALT|ENDPOINT|BASE_URL)$/;
/** Values shorter than this, or only digits, are not scrubbed (they match ordinary text). */
const MIN_SECRET_LENGTH = 8;
const NUMERIC = /^[\d.]+$/;

/** A configured value as configuredSpans matches it: its folded units (fold), and their KMP table. */
interface ValuePattern {
  units: Uint16Array;
  /** `units` as a string, looked for first in a folded text (includes) before it is matched. */
  text: string;
  /** For each prefix of `units`, the length of its longest proper prefix that is also a suffix. */
  next: Int32Array;
}

/** Values as configuredSpans and knownValueSpans match them. */
interface ValueSet {
  patterns: ValuePattern[];
  /**
   * How long one of the values can be in a text, written escaped ESCAPE_DEPTH times with each of
   * its folded runs FOLD_REACH characters long: logCut and cappedValues look that far past a cut
   * for one that crosses it.
   */
  reach: number;
  /**
   * The spans of the texts read last (spansOf) while a redaction runs (readingOnce), newest
   * last: a redaction reads a text often.
   */
  recent: Map<string, ReadonlyArray<readonly [number, number]>>;
}

/** The configured values, longest first: as they were replaced before (cappedValues). */
let secretStrings: string[] = [];
let configured: ValueSet = { patterns: [], reach: 0, recent: new Map() };
/** configured.reach, which logCut and cappedValues read. */
let valueReach = 0;
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
  secretStrings = [...values].sort((a, b) => b.length - a.length);
  configured = valueSet(secretStrings);
  valueReach = configured.reach;
  secretHosts = [...hosts].sort((a, b) => b.length - a.length);
}

// =============================================================================
// Configured values in a text
// =============================================================================

/**
 * A text as configuredSpans reads it: UTF-16 units, each standing for [from[i], to[i]) of the text
 * as it came (for unit i itself when there is no `from`, `to`).
 */
interface Units {
  units: Uint16Array;
  length: number;
  from?: Int32Array;
  to?: Int32Array;
}

/** How many times a configured value is looked for unescaped: twice, JSON in a JSON string. */
const ESCAPE_DEPTH = 2;
/** The most characters one character takes escaped ESCAPE_DEPTH times (`\u` escapes of one). */
const ESCAPED_CHAR = 6 ** ESCAPE_DEPTH;
/** A run of folded characters, however long, in a folded text (fold). */
const FOLDED_RUN = 0;
/**
 * How long a run of folded characters in a text is taken to be where a configured value is looked
 * for across a cut (ValueSet.reach). A value is found with runs of any length everywhere else; one
 * written across scrub's cap with a longer run in it can be cut, and its part before the cut shown,
 * as a value written folded was before any was found folded.
 */
const FOLD_REACH = 8;
const BACKSLASH = 0x5c;
/** The one-character escapes of JSON and JavaScript (util.inspect writes `\'` and `\v` too). */
const SIMPLE_ESCAPES: ReadonlyMap<number, number> = new Map(
  [
    ['"', '"'],
    ["\\", "\\"],
    ["/", "/"],
    ["'", "'"],
    ["b", "\b"],
    ["f", "\f"],
    ["n", "\n"],
    ["r", "\r"],
    ["t", "\t"],
    ["v", "\v"],
  ].map(([written, char]) => [(written as string).charCodeAt(0), (char as string).charCodeAt(0)]),
);

/**
 * Whether a character is one that logText or plainReason (sources/http.ts) folds into a space:
 * whitespace (`\s`) or a control character (`\p{Cc}`).
 */
function isFolded(c: number): boolean {
  return (
    c <= 0x20 ||
    (c >= 0x7f && c <= 0xa0) ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

/**
 * `values` as configuredSpans matches them: folded, without the folded characters at either end,
 * with their KMP tables. A value that is empty or only such characters is left out: it would match
 * every space of a text.
 */
function valueSet(values: readonly string[]): ValueSet {
  const patterns: ValuePattern[] = [];
  let reach = 0;
  for (const value of values) {
    const pattern = valuePattern(value);
    if (!pattern) continue;
    patterns.push(pattern);
    let runs = 0;
    for (const unit of pattern.units) if (unit === FOLDED_RUN) runs++;
    reach = Math.max(reach, ESCAPED_CHAR * (pattern.units.length + runs * (FOLD_REACH - 1)));
  }
  return { patterns, reach, recent: new Map() };
}

/**
 * `text` as units of a folded text (fold), without a run at either end, with the KMP table
 * configuredSpans matches it by; undefined when nothing is left.
 */
function valuePattern(text: string): ValuePattern | undefined {
  const { units, length } = fold(unitsOf(text));
  const first = units[0] === FOLDED_RUN ? 1 : 0;
  const last = length > first && units[length - 1] === FOLDED_RUN ? length - 1 : length;
  if (last <= first) return undefined;
  const pattern = units.slice(first, last);
  return withTable(pattern);
}

/** `pattern` with its KMP table. */
function withTable(pattern: Uint16Array): ValuePattern {
  const length = pattern.length;
  const next = new Int32Array(length);
  for (let i = 1, k = 0; i < length; i++) {
    while (k > 0 && pattern[i] !== pattern[k]) k = next[k - 1] as number;
    if (pattern[i] === pattern[k]) k++;
    next[i] = k;
  }
  return { units: pattern, text: unitsText(pattern, length), next };
}

/** The first `length` of `units` as a string. */
function unitsText(units: Uint16Array, length: number): string {
  const parts: string[] = [];
  for (let at = 0; at < length; at += 8192) {
    parts.push(String.fromCharCode(...units.subarray(at, Math.min(length, at + 8192))));
  }
  return parts.join("");
}

function unitsOf(text: string): Units {
  const units = new Uint16Array(text.length);
  for (let i = 0; i < text.length; i++) units[i] = text.charCodeAt(i);
  return { units, length: text.length };
}

/**
 * `text` with each run of folded characters (isFolded) as one unit, FOLDED_RUN: a configured
 * value's run matches a run of any folded characters, of any length. logText writes a space for
 * each, plainReason one space for a run, and a source can echo a line break as `\r\n`.
 */
function fold(text: Units): Units {
  const { units, length } = text;
  const out = new Uint16Array(length);
  const from = new Int32Array(length);
  const to = new Int32Array(length);
  let n = 0;
  for (let i = 0; i < length; n++) {
    const c = units[i] as number;
    let end = i + 1;
    if (isFolded(c)) {
      while (end < length && isFolded(units[end] as number)) end++;
      out[n] = FOLDED_RUN;
    } else out[n] = c;
    from[n] = text.from ? (text.from[i] as number) : i;
    to[n] = text.to ? (text.to[end - 1] as number) : end;
    i = end;
  }
  return { units: out, length: n, from, to };
}

/** The value of `count` hex digits at `at` of `text`, or -1. */
function hexAt(text: Units, at: number, count: number): number {
  if (at + count > text.length) return -1;
  let value = 0;
  for (let i = at; i < at + count; i++) {
    const c = text.units[i] as number;
    const letter = c | 0x20;
    const digit =
      c >= 0x30 && c <= 0x39 ? c - 0x30 : letter >= 0x61 && letter <= 0x66 ? letter - 0x57 : -1;
    if (digit < 0) return -1;
    value = value * 16 + digit;
  }
  return value;
}

/**
 * `text` with its escapes read, left to right, as a JSON or JavaScript string's are: `\"`, `\\`,
 * `\n` and the other one-character escapes, `\uXXXX` and `\xXX`. A backslash that starts none is
 * kept. Undefined when the text holds no escape.
 */
function unescaped(text: Units): Units | undefined {
  const { units, length } = text;
  const out = new Uint16Array(length);
  const from = new Int32Array(length);
  const to = new Int32Array(length);
  let any = false;
  let n = 0;
  for (let i = 0; i < length; n++) {
    let c = units[i] as number;
    let width = 1;
    if (c === BACKSLASH && i + 1 < length) {
      const kind = units[i + 1] as number;
      const simple = SIMPLE_ESCAPES.get(kind);
      const code =
        kind === 0x75 ? hexAt(text, i + 2, 4) : kind === 0x78 ? hexAt(text, i + 2, 2) : -1;
      if (simple !== undefined) [c, width] = [simple, 2];
      else if (code >= 0) [c, width] = [code, kind === 0x75 ? 6 : 4];
    }
    any ||= width > 1;
    out[n] = c;
    from[n] = text.from ? (text.from[i] as number) : i;
    to[n] = text.to ? (text.to[i + width - 1] as number) : i + width;
    i += width;
  }
  return any ? { units: out, length: n, from, to } : undefined;
}

/**
 * Where the configured values lie in `text`, as [start, end) spans sorted by start; spans that
 * overlap (values that overlap, or one value twice) as one. A value is found as it came, with each
 * of its runs of whitespace and control characters matching such a run of any length (logText,
 * plainReason, a line break echoed as `\r\n`), and with its characters escaped once or twice as
 * JSON writes a string (a PEM key in a JSON error body), `\u`, `\x` and `\/` escapes included.
 * A span also takes the token characters glued to the value on either side (withTokens). Each
 * reading of the text is matched once per value (KMP): linear time. The redaction of source
 * errors (sources/http.ts) reads them too: a value a log line hides in a form its own rules do not
 * know is still masked in the text it shows.
 */
export const configuredSpans = (text: string) => spansOf(text, configured);

/** The values of the last list knownValueSpans was given, as matched. */
let known: { key: string; list: readonly string[]; set: ValueSet } | undefined;

/**
 * Where `values` lie in `text`, found as configuredSpans finds the configured values: as they came,
 * escaped, folded; overlapping ones as one span. The redaction of source errors (sources/http.ts)
 * finds the credentials it knows by it.
 */
export function knownValueSpans(text: string, values: readonly string[]): Array<[number, number]> {
  if (known?.list !== values) {
    const key = values.join("\0");
    if (known?.key !== key) known = { key, list: values, set: valueSet(values) };
    else known.list = values;
  }
  return spansOf(text, known.set);
}

/**
 * The configured values, longest first: sources/http.ts masks them in the text it shows a client
 * as it masks its own credentials.
 */
export const configuredValues = (): readonly string[] => secretStrings;

/**
 * `text` with the configured values and `values` in it (configuredSpans, knownValueSpans) replaced
 * by "[redacted]": for a text cut before the logger sees it, whose cut can leave a part of a value
 * that no longer matches (llm/invoke.ts).
 */
export function hideKnownValues(text: string, values: readonly string[] = []): string {
  const spans = configuredSpans(text);
  return hideSpans(
    text,
    values.length > 0 ? unionSpans(spans, knownValueSpans(text, values)) : spans,
  );
}

/**
 * `text` with what scrub replaces in it (scrubbedSpans), `values` (knownValueSpans) and what
 * `more` finds in the text with the configured values and `values` replaced as hideKnownValues
 * replaces them, all found in `text` itself and hidden as one: for a text cut to a length before
 * the logger sees it (llm/invoke.ts). A plain cut of the text as it came can leave a part of a
 * credential that no rule reads any more (a Basic one shorter than 8 characters, a quoted one
 * without its closing quote); and one redaction run on another's output can lose what the other
 * took (a scheme word, a pair's name) and leave the credential. A part that scrub writes as a
 * label alone (the provider endpoint, a preview link) is written so; the word Basic before a
 * credential holds no secret and stays.
 */
export function hideScrubbed(
  text: string,
  values: readonly string[] = [],
  more?: (hidden: string) => Array<[number, number]>,
): string {
  let spans = scrubbedSpans(text);
  if (values.length > 0) spans = unionSpans(spans, knownValueSpans(text, values));
  if (more) {
    const known = unionSpans(configuredSpans(text), knownValueSpans(text, values));
    const hidden = rewrite(
      { text },
      known.map(([start, end]): Rewrite => [start, end, REDACTED, start, end]),
      [],
    );
    const fromOf = (i: number) => (hidden.from ? (hidden.from[i] as number) : i);
    const toOf = (i: number) => (hidden.to ? (hidden.to[i] as number) : i + 1);
    const found = more(hidden.text).filter(([start, end]) => end > start);
    spans = unionSpans(
      spans,
      found.map(([start, end]): [number, number] => [fromOf(start), toOf(end - 1)]),
    );
  }
  const parts: string[] = [];
  let at = 0;
  for (const [from, to] of spans) {
    const start = from + (BASIC_WORD.exec(text.slice(from, to))?.[0].length ?? 0);
    const label = scrub(text.slice(start, to));
    parts.push(text.slice(at, start), LABELS_ONLY.test(label) ? label : REDACTED);
    at = to;
  }
  parts.push(text.slice(at));
  return parts.join("");
}

/** The word Basic and the spaces after it, at the start of a span with more after it. */
const BASIC_WORD = /^Basic\s+(?=\S)/i;
/** What scrub writes for a part that holds nothing else: its labels alone. */
const LABELS_ONLY = /^(?:\[(?:redacted|provider endpoint|preview link)\])+$/;

/** Runs of the characters isFolded folds, for a quick look (spansOf): each one FOLDED_RUN. */
const FOLDED_RUNS = /[\0-\x20\x7f-\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/g;

/** configuredSpans for the values of `set`. */
function spansOf(text: string, set: ValueSet): Array<[number, number]> {
  if (set.patterns.length === 0 || text.length === 0) return [];
  if (reading === 0) return readSpans(text, set);
  keeping.add(set);
  const known = set.recent.get(text);
  if (known) return known.map(([start, end]) => [start, end]);
  const spans = readSpans(text, set);
  set.recent.set(text, spans);
  if (set.recent.size > RECENT_TEXTS) set.recent.delete(set.recent.keys().next().value as string);
  return spans.map(([start, end]) => [start, end]);
}

/** How many redactions run now (readingOnce), one inside another. */
let reading = 0;
/** The value sets that keep spans for the redaction running now. */
const keeping = new Set<ValueSet>();

/**
 * `run`, a redaction (sources/http.ts), with the spans of the texts it reads kept until it ends
 * (ValueSet.recent).
 */
export function readingOnce<T>(run: () => T): T {
  reading++;
  try {
    return run();
  } finally {
    reading--;
    if (reading === 0) {
      for (const set of keeping) set.recent.clear();
      keeping.clear();
    }
  }
}

/** How many texts' spans a value set keeps (ValueSet.recent). */
const RECENT_TEXTS = 8;

/** spansOf, read. */
function readSpans(text: string, set: ValueSet): Array<[number, number]> {
  // Without a backslash the text is read only as it came: when no value is in it with every run
  // of folded characters one FOLDED_RUN, none is in its folded reading either.
  if (!text.includes("\\")) {
    const quick = text.replace(FOLDED_RUNS, "\0");
    if (!set.patterns.some((value) => quick.includes(value.text))) return [];
  }
  const found: Array<[number, number]> = [];
  let reading: Units | undefined = unitsOf(text);
  for (let depth = 0; reading && depth <= ESCAPE_DEPTH; depth++) {
    const folded = fold(reading);
    // Most texts hold none of the values: a value is matched only where includes finds it.
    const seen = unitsText(folded.units, folded.length);
    for (const value of set.patterns) {
      if (seen.includes(value.text)) occurrencesIn(folded, value, found);
    }
    reading = depth < ESCAPE_DEPTH ? unescaped(reading) : undefined;
  }
  found.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  return withTokens(text, found);
}

/** A character of a token (a key, a Bearer or Basic credential, a base64 text): [A-Za-z0-9._~+/=-]. */
function isTokenChar(c: number): boolean {
  const letter = c | 0x20;
  return (
    (letter >= 0x61 && letter <= 0x7a) ||
    (c >= 0x30 && c <= 0x39) ||
    c === 0x2e ||
    c === 0x5f ||
    c === 0x7e ||
    c === 0x2b ||
    c === 0x2f ||
    c === 0x3d ||
    c === 0x2d
  );
}

/**
 * A token character before a value: not "=", which ends a name (`token=<value>`) or a base64
 * text, never starts a token.
 */
const isTokenStart = (c: number) => c !== 0x3d && isTokenChar(c);

/**
 * `found` (sorted by start) as spans that each take the token characters (isTokenChar) written
 * right before (up to an "=", and never a link's "//") and after them (up to the start of a rule,
 * beforeRule) as well: a value glued to more of a token (`<key>.<signature>`, a composite token)
 * hides the whole token. In a link (after a "://" with no break since, inLink), a "/" ends the
 * token too: the host and the rest of the path stay. Before a span, a character that ends an
 * escape (`\n`, `\u00e9`) is not taken: the escape stays whole. Spans that overlap after that as
 * one. Each character is read at most twice, and the gap after a run of token characters once
 * (closerAfter): linear time.
 */
function withTokens(text: string, found: ReadonlyArray<readonly [number, number]>) {
  const spans: Array<[number, number]> = [];
  const link = inLink(text);
  const closer = closerAfter(text);
  let scanned = 0;
  for (const [from, to] of found) {
    const last = spans.at(-1);
    const inUrl = link(from);
    const takes = (c: number) => isTokenChar(c) && !(inUrl && c === SLASH);
    let start = from;
    while (
      start > (last?.[1] ?? 0) &&
      isTokenStart(text.charCodeAt(start - 1)) &&
      takes(text.charCodeAt(start - 1)) &&
      !text.startsWith("://", start - 3)
    ) {
      start--;
    }
    if (start < from) start = afterEscape(text, start, from);
    // Inside the span before it, whose token characters are read already.
    if (last && to <= last[1]) continue;
    let end = Math.max(to, scanned);
    while (end < text.length && takes(text.charCodeAt(end))) end++;
    scanned = end;
    end = beforeRule(text, to, end, closer);
    if (last && start < last[1]) last[1] = Math.max(last[1], end);
    else spans.push([start, end]);
  }
  return spans;
}

/**
 * Whether a place in `text` is in a link: after a "://" (any scheme, or none: `a://b`, `sb://`,
 * `file:///`) with no character that ends a link since (endsLink). Asked for places in order, it
 * reads each character once.
 */
function inLink(text: string): (at: number) => boolean {
  let read = 0;
  let scheme = -1;
  let broken = -1;
  return (at) => {
    for (; read < at; read++) {
      const c = text.charCodeAt(read);
      if (endsLink(c)) broken = read;
      else if (c === COLON && text.startsWith("//", read + 1)) scheme = read;
    }
    return scheme > broken;
  };
}

/**
 * A character that ends a link: a control character (C0, DEL and C1), whitespace (\s, with the
 * no-break and the other Unicode spaces and the line and paragraph separators), a quote ("
 * or '), a backtick, "<" or ">".
 */
function endsLink(c: number): boolean {
  if (c <= 0x20 || (c >= 0x7f && c <= 0xa0)) return true;
  if (c === 0x22 || c === 0x27 || c === 0x60 || c === 0x3c || c === 0x3e) return true;
  return c > 0xff && WHITESPACE.test(String.fromCharCode(c));
}

const WHITESPACE = /\s/;
const SLASH = 0x2f;
const EQUALS = 0x3d;
const COLON = 0x3a;

/**
 * The character after the quotes and whitespace that follow a place in `text` (GAP), read once
 * for each place asked: every span in one run of token characters ends at the same place.
 */
function closerAfter(text: string): (end: number) => number {
  let at = -1;
  let closer = Number.NaN;
  return (end) => {
    if (end !== at) {
      at = end;
      GAP.lastIndex = end;
      GAP.test(text);
      closer = text.charCodeAt(GAP.lastIndex);
    }
    return closer;
  };
}

/** Quotes and whitespace, between a name and its ":" or "=". */
const GAP = /["'\s]*/y;

/**
 * The start of a rule's match glued after a value: a scheme word and the space after it, a link's
 * scheme, a pair's name and its ":" or "=". Taken with the value, it would no longer be read, and
 * the secret after it would stay. A name's ":" or "=" can follow quotes and whitespace only where
 * the run of token characters ends (a name is token characters, and those are not): there,
 * RULE_START matches the name alone and beforeRule reads what follows once (closerAfter).
 */
const RULE_START = new RegExp(
  String.raw`${SCHEMES}\s|https?:\/\/|(?:${PAIR_NAMES})(?:=|(?=["'\s:]|$))`,
  "iy",
);

/**
 * Where the token characters from `from` to `end` that a value's span takes stop: before the
 * first start of a rule (RULE_START) in them. Inside a word too: a host the logger replaces can
 * end right before it (`<host>https://…`), and the rule then reads it. Characters that end in a
 * name's ":" (`<value>.password: <secret>`; `closerAt(end)`, the character after the quotes and
 * whitespace at `end`) are not taken: the rules of sources/http.ts read a name only where it
 * starts a word. With no token characters to take, nothing is read past `end`: a value of quotes
 * or whitespace, found at each place of a long run of them, would read the rest of the run again.
 */
function beforeRule(
  text: string,
  from: number,
  end: number,
  closerAt: (end: number) => number,
): number {
  if (end <= from) return end;
  const closer = closerAt(end);
  if (closer === COLON) return from;
  for (let at = from; at < end; at++) {
    RULE_START.lastIndex = at;
    if (!RULE_START.test(text)) continue;
    // A name that ends the run is a pair's only before its "=" (its ":" returned above).
    if (RULE_START.lastIndex !== end || text.charCodeAt(end - 1) === EQUALS || closer === EQUALS) {
      return at;
    }
  }
  return end;
}

/**
 * Where the token characters from `start` to `end` start once those that close an escape whose
 * backslash is before `start` are left out: `\uXXXX`, `\xXX`, or a one-character escape.
 */
function afterEscape(text: string, start: number, end: number): number {
  let backslashes = 0;
  while (start - backslashes > 0 && text.charCodeAt(start - backslashes - 1) === BACKSLASH) {
    backslashes++;
  }
  if (backslashes % 2 === 0) return start;
  const kind = text.charCodeAt(start);
  const width = kind === 0x75 ? 5 : kind === 0x78 ? 3 : 1;
  return Math.min(end, start + width);
}

/** Adds each place `value` matches in `text` (a folded text), overlapping ones too, to `found`. */
function occurrencesIn(text: Units, value: ValuePattern, found: Array<[number, number]>): void {
  const { units, next } = value;
  const m = units.length;
  const from = text.from as Int32Array;
  const to = text.to as Int32Array;
  for (let i = 0, k = 0; i < text.length; i++) {
    const c = text.units[i];
    while (k > 0 && units[k] !== c) k = next[k - 1] as number;
    if (units[k] === c) k++;
    if (k === m) {
      found.push([from[i - m + 1] as number, to[i] as number]);
      k = next[k - 1] as number;
    }
  }
}

/** `text` up to `end` with each of `spans` (sorted, not overlapping) before it replaced by `mask`. */
function hideSpans(
  text: string,
  spans: ReadonlyArray<readonly [number, number]>,
  end = text.length,
  mask = REDACTED,
): string {
  const parts: string[] = [];
  let at = 0;
  for (const [start, stop] of spans) {
    if (stop > end) break;
    parts.push(text.slice(at, start), mask);
    at = stop;
  }
  parts.push(text.slice(at, end));
  return parts.join("");
}

/** `text` with each configured value in it (configuredSpans) replaced by REDACTED. */
const hideValues = (text: string) => hideSpans(text, configuredSpans(text));

/** A text as scrub's rules read it: HIDDEN_VALUE's characters in it as U+FFFD (as long). */
const asRead = (text: string, marks?: StandIns) =>
  text.replace(PRIVATE_MARKS, (mark) => (marks ? marks[mark === "\uE000" ? 0 : 1] : "\uFFFD"));

/** What a text's U+E000 and U+E001 are read as while scrub's rules read it. */
type StandIns = readonly [string, string];

/**
 * For a text that holds HIDDEN_VALUE's characters, two private-use characters it does not hold,
 * which scrub reads them as and then writes back: the rules read them as any other character of
 * a token, and the text keeps them. U+FFFD for both, not written back, in a text that holds every
 * private-use character.
 */
function standIns(text: string): StandIns | undefined {
  if (!/[\uE000\uE001]/.test(text)) return undefined;
  const held = new Set<string>(text.match(OTHER_PRIVATE));
  const free: string[] = [];
  for (let c = 0xe002; c <= 0xf8ff && free.length < 2; c++) {
    const char = String.fromCharCode(c);
    if (!held.has(char)) free.push(char);
  }
  return free.length === 2 ? [free[0] as string, free[1] as string] : ["\uFFFD", "\uFFFD"];
}

/** `text`, scrubbed, with the stand-ins of its U+E000 and U+E001 written back. */
function writtenBack(text: string, marks: StandIns | undefined): string {
  if (!marks || marks[0] === "\uFFFD") return text;
  return text.replaceAll(marks[0], "\uE000").replaceAll(marks[1], "\uE001");
}

/**
 * `text` (asRead) with what scrub replaces first replaced by HIDDEN_VALUE (valueSpans), cut off
 * past MAX_LOGGED_TEXT.
 * The cut is placed as logCut places it on this text, and as it was placed before configured
 * values were found escaped, folded or overlapping, on the text with only each value as it came
 * replaced, longest first: the earlier of the two, moved by logCut in each until neither moves
 * it. A value found here and not before can make the text shorter, and its cut fall later; text
 * cut off before is never let in.
 *
 * A long text is read only as far as the cut needs (cappedPrefix): a prefix, doubled until each
 * reading of it holds MAX_LOGGED_TEXT characters and logCut's window past them, before the part
 * of the prefix its end can change. logCut reads the readings without their configured values
 * (replaced already): the cut is moved out of a value by its span (settle).
 */
function cappedValues(text: string, marks?: StandIns): string {
  const margin = LOG_CUT_WINDOW + valueReach;
  for (let size = MAX_LOGGED_TEXT + LOG_CUT_WINDOW + margin; size < text.length; ) {
    const capped = cappedPrefix(text, size, margin, marks);
    if (typeof capped === "string") return capped;
    // Twice as long, or as long as the readings' share of the prefix says the cut needs.
    const needed = MAX_LOGGED_TEXT + LOG_CUT_WINDOW;
    size = Math.max(2 * size, Math.ceil(((size - margin) * needed * 1.25) / Math.max(capped, 1)));
  }
  return cappedPrefix(text, text.length, margin, marks) as string;
}

/**
 * cappedValues on the first `size` characters of `text`; when they are too few to place the cut
 * as on the whole text, how many characters the shorter reading holds before the part the end of
 * the prefix can change. Past `size - margin` (`margin`: logCut's window and a value's
 * reach), the spans found in a prefix can differ from those of the whole text (a value or a match
 * the prefix cuts off), and so can a span that crosses that point.
 */
function cappedPrefix(
  whole: string,
  size: number,
  margin: number,
  marks?: StandIns,
): string | number {
  const text = size < whole.length ? whole.slice(0, size) : whole;
  const spans = valueSpans(text);
  const read = asRead(text, marks);
  if (text === whole) {
    const length = spans.reduce((sum, [start, end]) => sum + REDACTED.length - (end - start), 0);
    // Each value before took at least MIN_SECRET_LENGTH characters, and REDACTED's in their place.
    const before =
      text.length * REDACTED.length > MAX_LOGGED_TEXT * MIN_SECRET_LENGTH
        ? replaceAll(text, secretStrings, REDACTED).length
        : 0;
    if (text.length + length <= MAX_LOGGED_TEXT && before <= MAX_LOGGED_TEXT) {
      return spans.length > 0 ? hideSpans(read, spans, read.length, HIDDEN_VALUE) : read;
    }
  }
  const hidden: Array<[number, number]> = [];
  const readings = [
    rewrite({ text: read }, asRewrites(spans), []),
    secretStrings.reduce(
      (current, value) => rewrite(current, occurrences(current.text, value, REDACTED), hidden),
      { text } as Rewritten,
    ),
  ];
  if (text !== whole) {
    // Where the part of the prefix its end can change starts, and whether each reading holds
    // what the cut reads before it.
    const boundary = size - margin;
    let settled = boundary;
    for (const [start, end] of [...spans, ...hidden]) {
      if (end > boundary) settled = Math.min(settled, start);
    }
    const held = Math.min(...readings.map((reading) => renderedAt(reading, settled)));
    if (held < MAX_LOGGED_TEXT + LOG_CUT_WINDOW) return held;
  }
  const sourceAt = (reading: Rewritten, at: number) =>
    at >= reading.text.length ? text.length : reading.from ? (reading.from[at] as number) : at;
  let at = text.length;
  for (const reading of readings) {
    if (reading.text.length > MAX_LOGGED_TEXT) {
      const cut = logCut(reading.text, MAX_LOGGED_TEXT, [], { pairs: false, values: false });
      at = Math.min(at, sourceAt(reading, cut));
    }
  }
  for (let moved = true; moved; ) {
    moved = false;
    at = settle([...spans, ...hidden], at);
    for (const reading of readings) {
      const there = renderedAt(reading, at);
      const cut = logCut(reading.text, there, [], { pairs: false, values: false });
      if (cut < there) {
        at = sourceAt(reading, cut);
        moved = true;
      }
    }
  }
  return at < whole.length
    ? `${hideSpans(read, spans, at, HIDDEN_VALUE)}${TRUNCATED}`
    : hideSpans(read, spans, read.length, HIDDEN_VALUE);
}

/** Where `at`, a place in the text `reading` rewrote, falls in it: before what starts there. */
function renderedAt(reading: Rewritten, at: number): number {
  const from = reading.from;
  if (!from) return at;
  let low = 0;
  let high = reading.text.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((from[middle] as number) < at) low = middle + 1;
    else high = middle;
  }
  return low;
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
    // The cap falls on the text as it came, never inside a link or a host (logCut), whose part
    // the rules below would no longer know, nor inside an Authorization credential, whose part
    // can be too short for its rule (a Basic one needs 8 characters). Replaced first, they would
    // shorten the text and let in more of it.
    const text = asText(input);
    const marks = standIns(text);
    let out = cappedValues(text, marks);
    out = out.replace(URL_IN_TEXT, (url) => {
      const host = hostOf(url);
      if (host && PREVIEW_HOST.test(host)) return PREVIEW_LINK;
      if (host && secretHosts.includes(host)) return PROVIDER_ENDPOINT;
      return url.replace(USERINFO, `$1${REDACTED}@`).replace(SECRET_PARAM, `$1${REDACTED}`);
    });
    out = replaceAll(out, secretHosts, PROVIDER_ENDPOINT)
      .replace(BARE_PREVIEW, PREVIEW_LINK)
      .replace(PROVIDER_HOST, PROVIDER_ENDPOINT);
    // What the rules of moreSpans hide is read on the text the two rules below read, and hidden
    // in what they write: they only add to what is hidden.
    const more = moreSpans(out);
    out = (
      more.length > 0
        ? withMoreSpans(out, more)
        : out
            .replace(SECRET_PAIR, `$1$2${REDACTED}`)
            .replace(
              AUTH_SCHEME,
              (_match, scheme?: string, basic?: string) => `${scheme ?? basic}${REDACTED}`,
            )
    ).replaceAll(HIDDEN_VALUE, REDACTED);
    return writtenBack(out, marks);
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
 * Basic before a credential that scrub's Authorization rule replaces (see readPairs). The
 * configured values are found as scrub finds them (valueSpans): escaped, folded, overlapping ones
 * as one span. The cap is not applied: past it, a span holds text scrub cuts off. The redaction
 * of source errors (sources/http.ts) reads them, so that the log line of a text it redacts
 * further never shows what the log line of the text it redacted before hid. Reads the text once
 * per rule. With `pairs` or `auth` false, secret pairs or Authorization values are left out:
 * what is left is what scrub replaces whole, which a part of no longer matches (configured
 * values, links, hosts). With `cut`, the span of a link's user info takes its "@" too, without
 * which the rest is no longer read as user info.
 */
export function scrubbedSpans(text: string, rules: SpanRules = {}): Array<[number, number]> {
  const hidden: Array<[number, number]> = [];
  const read = { text: asRead(text) };
  const values = rules.values === false ? [] : valueSpans(text);
  return spansAfterValues(rewrite(read, asRewrites(values), hidden), hidden, rules);
}

/** Configured values' spans as Rewrites, each by HIDDEN_VALUE as scrub writes it for its rules. */
const asRewrites = (spans: ReadonlyArray<readonly [number, number]>) =>
  spans.map(([start, end]): Rewrite => [start, end, HIDDEN_VALUE, start, end]);

/**
 * What scrub replaces first in `text`, as [start, end) spans sorted by start, none overlapping
 * another: its configured values (configuredSpans) and, where those differ from the values as
 * they came (one is found escaped, folded or overlapping), whatever the other rules hide in the
 * text with only the values as they came replaced, longest first, as they were before, and would
 * not hide in the text with these replaced. A value replaced where it was not before can end a
 * word or take a quote: in `R6x\"password: password: <secret>`, with the value before the first
 * `password` found escaped, that `password` starts a pair, which takes the second's name as its
 * value and leaves the secret. What the rules hid before is replaced too, and the text read
 * again; if anything is still lost, all they hid before is replaced.
 */
function valueSpans(text: string): Array<[number, number]> {
  let spans = configuredSpans(text);
  const hidden: Array<[number, number]> = [];
  const before = secretStrings.reduce(
    (current, value) => rewrite(current, occurrences(current.text, value, REDACTED), hidden),
    { text } as Rewritten,
  );
  hidden.sort((a, b) => a[0] - b[0]);
  if (
    hidden.length === spans.length &&
    hidden.every(([start, end], i) => spans[i]?.[0] === start && spans[i]?.[1] === end)
  ) {
    return spans;
  }
  const old = spansAfterValues(before, hidden, {});
  const read = { text: asRead(text) };
  for (let round = 0; round < 2; round++) {
    const now: Array<[number, number]> = [];
    const lost = lostSpans(
      old,
      spansAfterValues(rewrite(read, asRewrites(spans), now), now, {}),
    ).filter(([start, end]) => !SCHEME_WORD.test(text.slice(start, end)));
    if (lost.length === 0) return spans;
    spans = unionSpans(spans, round === 0 ? lost : old);
  }
  return spans;
}

/**
 * An Authorization scheme word alone, which a lost part can be: the Authorization rule's span of a
 * Basic credential keeps the word (readPairs), and a pair's span of the same credential does not.
 * It holds no secret. Replaced as a configured value, it would leave the credential after it with
 * no scheme, which the Authorization rule then no longer reads, and a cut through the credential
 * would no longer fall before it.
 */
const SCHEME_WORD = new RegExp(String.raw`^${SCHEMES}\s+$`, "i");

/** The parts of `old` (sorted, not overlapping) that none of `now` (the same) covers. */
function lostSpans(
  old: ReadonlyArray<readonly [number, number]>,
  now: ReadonlyArray<readonly [number, number]>,
): Array<[number, number]> {
  const lost: Array<[number, number]> = [];
  let j = 0;
  for (const [start, end] of old) {
    let at = start;
    while (j < now.length && (now[j] as [number, number])[1] <= at) j++;
    for (let k = j; k < now.length && at < end; k++) {
      const [from, to] = now[k] as [number, number];
      if (from >= end) break;
      if (from > at) lost.push([at, from]);
      at = Math.max(at, to);
    }
    if (at < end) lost.push([at, end]);
  }
  return lost;
}

/** Two lists of spans as one, sorted by start, spans that overlap as one. */
function unionSpans(
  a: ReadonlyArray<readonly [number, number]>,
  b: ReadonlyArray<readonly [number, number]>,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [start, end] of [...a, ...b].sort((x, y) => x[0] - y[0])) {
    const last = out.at(-1);
    if (last && start < last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

/** scrubbedSpans' rules after the configured values, on `current`; `hidden` holds the values'. */
function spansAfterValues(
  before: Rewritten,
  hidden: Array<[number, number]>,
  { pairs = true, auth = true, cut = false, shapes = true }: SpanRules,
  added?: Array<[number, number]>,
): Array<[number, number]> {
  let current = before;
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
  readPairs(current, hidden, pairs, auth, { shapes, added });
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
  /** False for a text whose configured values are replaced already (cappedValues' readings). */
  values?: boolean;
  /** False to leave out what moreSpans adds to the pair and Authorization rules. */
  shapes?: boolean;
}

/**
 * scrubbedSpans' last two rules, secret pairs and Authorization values, on `current`, and what
 * the rules of moreSpans hide in it.
 */
function readPairs(
  before: Rewritten,
  hidden: Array<[number, number]>,
  withPairs: boolean,
  withAuth: boolean,
  { shapes = true, added }: { shapes?: boolean; added?: Array<[number, number]> } = {},
): void {
  const fromOf = (i: number) => (before.from ? (before.from[i] ?? 0) : i);
  const toOf = (i: number) => (before.to ? (before.to[i] ?? 0) : i + 1);
  if (added) {
    // What moreSpans adds to the two rules (pairShapeSpans), but pairs glued to a word; a
    // credential after a scheme that looks like one, which the Authorization rule hides and the
    // redaction of source errors does not read (it needs 12 token characters after one space);
    // and a pair's value that looks like a credential (pairCredential), which that redaction
    // reads in few shapes (`authorization: "<token>"` it does not).
    const more = moreSpans(before.text, false);
    const pairs: Array<[number, number]> = [];
    pairRules({ text: before.text }, pairs, true, false);
    const values = pairs.filter(([start, end]) => pairCredential(before.text, start, end));
    for (const [start, end] of values) added.push([fromOf(start), toOf(end - 1)]);
    if (more.length === 0) return;
    const two: Array<[number, number]> = [];
    pairRules({ text: before.text }, two, true, true);
    const credentials = schemeSpans(before.text).filter(([start, end]) => {
      const credential = before.text.slice(start, end);
      const head = before.text.slice(Math.max(0, start - 8), start);
      const read = READ_THERE.test(head) && BEARER_TOKEN.test(credential);
      // As that redaction reads them, the schemes are capitalised: `basic <word>` is prose there.
      return (
        CREDENTIAL_LIKE.test(credential) &&
        (credential.includes("&") || !read) &&
        !LOWER_SCHEME.test(head)
      );
    });
    const lost = lostSpans(more, unionSpans(two, []));
    for (const [start, end] of unionSpans(lost, credentials)) {
      added.push([fromOf(start), toOf(end - 1)]);
    }
    return;
  }
  if (shapes && (withPairs || withAuth)) {
    const more = moreSpans(before.text);
    if (more.length > 0) {
      // What the two rules leave of them is hidden with the whole of what those rules rewrite
      // around it (withWholeRewrites).
      const two: Array<[number, number]> = [];
      pairRules({ text: before.text }, two, withPairs, withAuth);
      const lost = lostSpans(more, unionSpans(two, []));
      const whole = lost.length > 0 ? withWholeRewrites(before.text, lost) : lost;
      for (const [start, end] of unionSpans(more, whole)) {
        hidden.push([fromOf(start), toOf(end - 1)]);
      }
    }
  }
  pairRules(before, hidden, withPairs, withAuth);
}

/** A run of token characters. */
const TOKEN_RUN = /^[A-Za-z0-9._~+/=-]+$/;

/**
 * Whether the value of a pair at [start, end) of `text` looks like a credential: one run of token
 * characters that GLUED_CREDENTIAL takes, on the line of its name.
 */
function pairCredential(text: string, start: number, end: number): boolean {
  const value = text.slice(start, end);
  if (!TOKEN_RUN.test(value) || !GLUED_CREDENTIAL.test(value)) return false;
  let at = start - 1;
  while (at >= 0 && /[\s"'`]/.test(text.charAt(at))) {
    if (/[\r\n\v\f\u0085\u2028\u2029]/.test(text.charAt(at))) return false;
    at--;
  }
  return true;
}

/**
 * A credential the redaction of source errors reads itself: 12 token characters after Bearer or
 * Basic and one space, not glued to a word before.
 */
const READ_THERE = /(?:^|[^A-Za-z0-9_])(?:Bearer|Basic) $/;
const BEARER_TOKEN = /^[A-Za-z0-9._~+/=-]{12}/;
/** A scheme written in lower case right before a credential. */
const LOWER_SCHEME = /\b(?:bearer|basic)[ \t]+["']?$/;

/**
 * readPairs' two rules of scrub, secret pairs and Authorization values, on `current`; with
 * `pairPattern`, pairs of another shape (GLUED_PAIR); without `basicWord`, a Basic credential's
 * span starts after its scheme word, as scrub writes it.
 */
function pairRules(
  before: Rewritten,
  hidden: Array<[number, number]>,
  withPairs: boolean,
  withAuth: boolean,
  pairPattern = SECRET_PAIR,
  basicWord = true,
): void {
  let current = before;
  const pairs: Rewrite[] = [];
  for (const pair of withPairs ? current.text.matchAll(pairPattern) : []) {
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
    const from = auth.index + (auth[1] ?? (basicWord ? "" : auth[2]) ?? "").length;
    auths.push(valueRewrite(current.text, from, auth.index + auth[0].length));
  }
  rewrite(current, auths, hidden);
}

// =============================================================================
// Pair and scheme shapes the two rules do not read
// =============================================================================

/**
 * A character as moreSpans reads it written another way: a curly quote (`‘ ’ ‚ ‛ “ ” „ ‟`), or an
 * HTML entity (`&quot;`, `&#61;`, `&#x3d;`, `&colon;`), also without its ";" where no letter or
 * digit follows. Group 1 is a named entity, 2 a decimal one, 3 a hexadecimal one.
 */
const WRITTEN_AS =
  /[\u2018-\u201f]|&(?:(lt|gt|amp|quot|apos|equals|colon)|#(\d{1,7})|#x([0-9a-f]{1,6}))(?:;|(?![0-9a-z]))/gi;
const NAMED_CHARS: Readonly<Record<string, string>> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
  equals: "=",
  colon: ":",
};

/** What a match of WRITTEN_AS stands for; undefined for a private-use character or none. */
function writtenChar(match: RegExpExecArray | RegExpMatchArray): string | undefined {
  const written = match[0];
  if (!written.startsWith("&")) return written <= "\u201b" ? "'" : '"';
  if (match[1]) return NAMED_CHARS[match[1].toLowerCase()];
  const code = match[2] ? Number(match[2]) : Number.parseInt(match[3] ?? "", 16);
  // A private-use character could stand for the start or the end of a HIDDEN_VALUE.
  if (code > 0x10ffff || (code >= 0xe000 && code <= 0xf8ff)) return undefined;
  return String.fromCodePoint(code);
}

/**
 * `text` with its curly quotes as straight ones and its HTML entities as the characters they
 * stand for (WRITTEN_AS), each character of it standing for what it was written as; undefined
 * when nothing is written another way.
 */
function readAsWritten(text: string): Rewritten | undefined {
  if (!/[\u2018-\u201f&]/.test(text)) return undefined;
  const parts: Rewrite[] = [];
  for (const match of text.matchAll(WRITTEN_AS)) {
    const char = writtenChar(match);
    const end = match.index + match[0].length;
    if (char !== undefined) parts.push([match.index, end, char, match.index, end]);
  }
  return parts.length > 0 ? rewrite({ text }, parts, []) : undefined;
}

/**
 * The Authorization schemes besides SCHEMES: read (moreSpans) only right after an Authorization
 * name and its ":" or "=" (and a quote), since most of them are words of prose too (`Token`).
 */
const MORE_SCHEMES =
  "Token|Digest|Bot|ApiKey|Api-Key|OAuth|SSWS|JWT|DPoP|MAC|Hawk|Negotiate|NTLM|AWS4-HMAC-SHA256";
/**
 * Where an Authorization scheme starts (group 1: Bearer, Basic, or Discogs before its `token=`),
 * or one of MORE_SCHEMES or Discogs after an Authorization name. The name is looked for at most a
 * few characters back. Discogs alone is the name of a source (`Discogs not asked`), not a scheme.
 */
const SCHEME_AT = new RegExp(
  String.raw`\b(?:(Bearer|Basic|Discogs(?=[ \t]+token=))|(?<=authorization["']?[ \t]{0,8}[:=][ \t]{0,8}${QUOTE}?)(?:${MORE_SCHEMES}|Discogs))(?![\w-])`,
  "gi",
);
/**
 * Bearer or Basic glued to the word before it (`failedBasic <credential>`), as written: read only
 * before a credential that looks like one (GLUED_CREDENTIAL), not before a word of prose.
 */
const GLUED_SCHEME = /(?<=[A-Za-z0-9_])(Bearer|Basic)(?=[ \t])/g;
/**
 * A credential after a glued scheme or a glued pair's name: 12 characters or more, with a "+",
 * "/" or "=", or two digits and both cases, or 20 characters or more with a digit and both cases
 * (`VisualBasic ProgrammingInVB6` and `mypassword=must-be-set-here` are prose).
 */
const GLUED_CREDENTIAL =
  /^(?=.{12})(?:[^+/=]*[+/=]|(?=(?:[^0-9]*[0-9]){2})(?=[^A-Z]*[A-Z])(?=[^a-z]*[a-z])|(?=.{20})(?=[^0-9]*[0-9])(?=[^A-Z]*[A-Z])(?=[^a-z]*[a-z]))/s;
/** A credential that looks like one (GLUED_CREDENTIAL), or that holds an `&`. */
const CREDENTIAL_LIKE = /&|^(?=.{12})(?:.*[0-9+/=]|.*[A-Z].*[A-Z])/s;
/** The next scheme of a run of them (`Bearer Bearer <token>`): any, or SCHEMES only (group 1). */
const NEXT_SCHEME = new RegExp(String.raw`(?:(${SCHEMES})|(?:${MORE_SCHEMES}))(?![\w-])`, "iy");
/** After `Discogs`: its `token=`. */
const DISCOGS_TOKEN = /[ \t]+token=[ \t]*/iy;
/** Between a scheme and what follows it: spaces and tabs. */
const SCHEME_SPACE = /[ \t]+/y;
/** Inside quotes only: a comma, or one line break, between a scheme and its credential. */
const SCHEME_COMMA = /[ \t]*,[ \t]*/y;
const SCHEME_BREAK = /[ \t]*(?:\r\n|[\r\n\v\f\u0085\u2028\u2029])[ \t]*/y;
/** An Authorization value's parameters (`Digest username="u", response="v"`), quoted or not. */
const AUTH_PARAM = String.raw`[A-Za-z0-9_.-]+[ \t]*=[ \t]*(?:\\?"[^"\r\n]*?\\?"|[^\s,"'\`;}\]]*)`;
const AUTH_PARAMS = new RegExp(String.raw`${AUTH_PARAM}(?:[ \t]*,[ \t]*${AUTH_PARAM})*`, "y");
/** A first parameter whose value is quoted (`username="u"`). */
const QUOTED_FIRST_PARAM = /[A-Za-z0-9_.-]+[ \t]*=[ \t]*\\?"/y;
/** Each parameter of a list AUTH_PARAMS read: group 1 its name, group 2 or 3 its value. */
const AUTH_PARAM_VALUE = /([A-Za-z0-9_.-]+)[ \t]*=[ \t]*(?:\\?"([^"\r\n]*?)\\?"|([^\s,"'`;}\]]*))/g;
/**
 * The parameters of an Authorization value that hold a secret: Digest's `response` and `cnonce`,
 * Hawk's `mac`, and any whose name says so (`oauth_signature`, `Credential`, `secret`); the
 * others (`username`, `nonce`, `uri`, `qop`, `ts`) are read as they are.
 */
const SECRET_PARAM_NAME = /^(?:response|cnonce|mac)$|token|secret|passw|key|sig|credential/i;
/** A word in place of a credential, which says it is missing or bad (`Token expired`). */
const STATUS_WORD =
  /^(?:invalid|required|missing|expired|undefined|null|none|empty|true|false|unknown|revoked|nil|unset)[.!,;]*$/i;
/** A credential written as one token (RFC 7235's token68), "=" only at its end. */
const TOKEN68 = /[A-Za-z0-9._~+/-]+=*/y;
/**
 * A credential: what an Authorization value holds after its scheme, to a quote, a space or the
 * "…" a cut writes.
 */
const CREDENTIAL = /[^\s"'`,;}\]\u2026]+/y;
/** A Basic credential's start, as AUTH_SCHEME reads one: 8 characters of base64. */
const BASIC_START = /[A-Za-z0-9+/=]{8}/y;
/** A character of a token, glued to a closing quote after a scheme (`'Bearer'<token>`). */
const GLUED = /[A-Za-z0-9._~+/=-]/;

/** Whether `pattern` (sticky) matches at `at`; where it ends, or -1. */
function stickyEnd(pattern: RegExp, text: string, at: number): number {
  pattern.lastIndex = at;
  return pattern.test(text) ? pattern.lastIndex : -1;
}

/**
 * Where the credential lies after the Authorization scheme that SCHEME_AT found at `at`, in the
 * shapes the two rules leave it in, and where reading stopped. A run of schemes is read whole
 * (`Bearer Bearer '<token>'`, `Discogs Discogs token=<token>`); in quotes (the one before the
 * first scheme), a comma or one line break can follow a scheme (`'Bearer, <token>'`, `'Basic
 * <line break> <credential>'`), and then only a credential that looks like one (CREDENTIAL_LIKE)
 * and ends at the closing quote, or at the end of the text, is taken: a line of prose after a
 * quoted scheme stays, and so does a word (`"Bearer, please"`). The quote can close right after
 * the scheme, with the token glued to it (`'Bearer'<token>`). The credential is one run to a
 * space, a quote, a comma or a ";" (an `&` too: `Bearer abc&<token>`), or the value of each
 * parameter of a list that holds a secret (SECRET_PARAM_NAME: `Digest username="u",
 * response="v"`), or of each but the realm in a list that names none; a Basic one starts with 8
 * characters of base64, as AUTH_SCHEME reads it. A value that starts with a REDACTED or a configured value (a
 * MASK) is left, and so is a status word (`Token expired`).
 */
function credentialAt(
  text: string,
  at: number,
  scheme: RegExpExecArray,
  glued = false,
): { spans: Array<[number, number]>; end: number } {
  const quote = at > 0 && /["'`]/.test(text.charAt(at - 1)) ? text.charAt(at - 1) : "";
  const anyScheme = scheme[1] === undefined;
  let last = scheme[0].toLowerCase();
  let p = at + scheme[0].length;
  let open = quote;
  let shape: "space" | "comma" | "break" | "glued" = "space";
  for (;;) {
    if (last === "discogs") {
      const end = stickyEnd(DISCOGS_TOKEN, text, p);
      if (end !== -1) {
        p = end;
        shape = "space";
        break;
      }
    }
    if (open && text.charAt(p) === open && GLUED.test(text.charAt(p + 1))) {
      p++;
      open = "";
      shape = "glued";
      break;
    }
    let end = stickyEnd(SCHEME_SPACE, text, p);
    shape = "space";
    if (open) {
      for (const [pattern, kind] of [
        [SCHEME_COMMA, "comma"],
        [SCHEME_BREAK, "break"],
      ] as const) {
        const other = stickyEnd(pattern, text, p);
        if (other > end) [end, shape] = [other, kind];
      }
    }
    if (end === -1) return { spans: [], end: p };
    p = end;
    NEXT_SCHEME.lastIndex = p;
    const next = NEXT_SCHEME.exec(text);
    if (!next || (next[1] === undefined && !anyScheme)) break;
    // Discogs is a scheme of the run only before its `token=`, or in an Authorization value.
    const word = next[0].toLowerCase();
    if (
      word === "discogs" &&
      !anyScheme &&
      stickyEnd(DISCOGS_TOKEN, text, NEXT_SCHEME.lastIndex) === -1
    )
      break;
    last = word;
    p = NEXT_SCHEME.lastIndex;
  }
  let inner = "";
  if (shape === "space" && /["'`]/.test(text.charAt(p))) {
    inner = text.charAt(p);
    p++;
  }
  if (text.startsWith(REDACTED, p) || text.startsWith(HIDDEN_VALUE, p))
    return { spans: [], end: p };
  if (last === "basic" && stickyEnd(BASIC_START, text, p) === -1) return { spans: [], end: p };
  // A list of parameters reads further than the token its first name starts: one token
  // (`Basic <base64>==`) is a credential, not a parameter. Nor is a token with "=" in it and more
  // after (`<token68>=&x`): a list is one whose first value is quoted, or with a second parameter
  // after a comma.
  const list = stickyEnd(AUTH_PARAMS, text, p);
  const isList =
    list > stickyEnd(TOKEN68, text, p) &&
    (stickyEnd(QUOTED_FIRST_PARAM, text, p) !== -1 || text.slice(p, list).includes(","));
  const params = isList ? list : -1;
  const end = params > p ? params : stickyEnd(CREDENTIAL, text, p);
  if (end <= p) return { spans: [], end: p };
  const credential = text.slice(p, end);
  const closer = inner || open;
  if (glued && !GLUED_CREDENTIAL.test(credential)) return { spans: [], end };
  if (params <= p && STATUS_WORD.test(credential)) return { spans: [], end };
  const quoted = shape === "comma" || shape === "break";
  // Taken before the closing quote, or where a cut ended the text (its end, or the "…" it
  // writes): a cut between the two leaves a credential still read as one. The quote is not part
  // of it.
  const closed = end === text.length || text.charAt(end) === closer || text.charAt(end) === "…";
  if (quoted && !closed) return { spans: [], end };
  if (quoted && !CREDENTIAL_LIKE.test(credential)) return { spans: [], end };
  const spans: Array<[number, number]> = [];
  if (params > p) {
    // The parameters that hold a secret; in a list that names none, each but the realm.
    const list = [...credential.matchAll(AUTH_PARAM_VALUE)];
    const named = list.some((param) => SECRET_PARAM_NAME.test(param[1] ?? ""));
    for (const param of list) {
      const value = param[2] ?? param[3] ?? "";
      const name = param[1] ?? "";
      const secret = named ? SECRET_PARAM_NAME.test(name) : name.toLowerCase() !== "realm";
      if (!value || !secret || STATUS_WORD.test(value)) continue;
      const close = param[2] === undefined ? 0 : param[0].endsWith('\\"') ? 2 : 1;
      const stop = p + param.index + param[0].length - close;
      spans.push([stop - value.length, stop]);
    }
  } else spans.push([p, end]);
  return { spans, end };
}

/** Each credential credentialAt finds in `text`, as spans of it. */
function schemeSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const pattern of [SCHEME_AT, GLUED_SCHEME]) {
    pattern.lastIndex = 0;
    for (let scheme = pattern.exec(text); scheme; scheme = pattern.exec(text)) {
      const found = credentialAt(text, scheme.index, scheme, pattern === GLUED_SCHEME);
      for (const span of found.spans) spans.push(span);
      const end = found.end;
      // The schemes of the run and the credential are read once: a later scheme of the run finds
      // the same credential, or none.
      pattern.lastIndex = Math.max(pattern.lastIndex, end);
    }
  }
  return spans;
}

/**
 * A pair whose name is glued to the word before it (`db_password: v`, `xapi_key=v`), which
 * SECRET_PAIR, starting at a word's first character, does not read: SECRET_PAIR from any
 * character after a letter, a digit or "_".
 */
const GLUED_PAIR = new RegExp(`(?<=[A-Za-z0-9_])${SECRET_PAIR.source.replace(/^\\b/, "")}`, "gi");
/** A pair's name glued to the word before it and its ":" or "=", for a quick look first. */
const GLUED_NAME = new RegExp(String.raw`[A-Za-z0-9_](?:${PAIR_NAMES})["']?\s*[:=]`, "i");
/** The user info of a link glued to the word before it (`failedhttps://user:password@host`). */
const GLUED_USERINFO = /(?<=[A-Za-z0-9_])https?:\/\/([^/?#@\s"'<>\\`]+)@/gi;

/**
 * What scrub hides besides its pair and Authorization rules, in `text` (as those two rules read
 * it, after links and hosts), as spans of it sorted by start, those that overlap as one:
 * - the credential after a scheme in the shapes those rules leave (credentialAt): a run of
 *   schemes before a token that holds an `&` or opens a quote, `'Bearer, <token>'`,
 *   `'Bearer'<token>`, a line break inside the quotes, and the other schemes of an Authorization
 *   value (`'Token <token>'`, `Digest response="<hash>"`);
 * - what the two rules and these hide in the text read with straight quotes for curly ones and
 *   the characters HTML entities stand for (`‘Bearer <token>’`, `&quot;token&quot;:&quot;v&quot;`,
 *   `password&#61;v`);
 * - with `glued`, what those rules leave where a word is glued before them: a pair's name
 *   (GLUED_PAIR), Bearer or Basic before a credential (GLUED_SCHEME) and a link with user info.
 * scrub hides them in what the two rules write; what they hid stays hidden. A scheme word alone
 * (what a pair's value is read as before quotes with nothing in them) is not a credential.
 */
function moreSpans(text: string, glued = true): Array<[number, number]> {
  if (!SHAPE_HINT.test(text)) return [];
  const spans = schemeSpans(text);
  if (NESTED_NAME.test(text)) nestedPairs(text, spans);
  if (glued) {
    if (GLUED_NAME.test(text)) gluedPairs({ text }, text, spans);
    for (const link of text.matchAll(GLUED_USERINFO)) {
      const start = link.index + link[0].indexOf("//") + 2;
      spans.push([start, start + (link[1] ?? "").length]);
    }
  }
  const read = readAsWritten(text);
  if (read) {
    const from = read.from as Int32Array;
    const to = read.to as Int32Array;
    // The word Basic is not hidden with its credential here: scrub writes it.
    pairRules(read, spans, true, true, SECRET_PAIR, false);
    if (glued) gluedPairs(read, text, spans);
    for (const [start, end] of schemeSpans(read.text)) {
      spans.push([from[start] as number, to[end - 1] as number]);
    }
  }
  const credentials: Array<[number, number]> = [];
  for (const [from, to] of spans) {
    // A quote at either end holds no secret: hidden, it would break the text around it (a JSON
    // string, a title in curly quotes) or show as a second mask.
    let start = from;
    let end = to;
    while (start < end && QUOTE_CHAR.test(text.charAt(start))) start++;
    while (end > start && QUOTE_CHAR.test(text.charAt(end - 1))) end--;
    if (start < end && !QUOTED_SCHEME_WORD.test(text.slice(start, end)))
      credentials.push([start, end]);
  }
  return unionSpans(credentials, []);
}

/** A pair's name and its ":" or "=", then another's, for a quick look first. */
const NESTED_NAME = new RegExp(
  String.raw`(?:${PAIR_NAMES})["']?[ \t]*[:=][ \t]*["']?(?:${PAIR_NAMES})["']?[ \t]*[:=]`,
  "i",
);
/** A pair's name, in a quote or not, and its ":" or "=", where a value starts. */
const PAIR_START = new RegExp(String.raw`["']?\b(?:${PAIR_NAMES})["']?\s*[:=]`, "iy");
/** SECRET_PAIR, read only where it is placed. */
const SECRET_PAIR_HERE = new RegExp(SECRET_PAIR.source, "iy");
/** How many pairs, one in the value of the other, nestedPairs reads after the first. */
const NESTED_DEPTH = 4;

/**
 * The values of the pairs whose name is the value of another pair (`token: authorization:
 * "<secret>"`) that look like a credential (CREDENTIAL_LIKE), added to `spans`: the pair rule
 * takes the second name as the first one's value, and the second pair is not read. A few levels
 * deep only.
 */
function nestedPairs(text: string, spans: Array<[number, number]>): void {
  for (const pair of text.matchAll(SECRET_PAIR)) {
    let from = pair.index + (pair[1] ?? "").length + (pair[2] ?? "").length;
    for (let depth = 0; depth < NESTED_DEPTH; depth++) {
      if (stickyEnd(PAIR_START, text, from) === -1) break;
      const at = /["']/.test(text.charAt(from)) ? from + 1 : from;
      SECRET_PAIR_HERE.lastIndex = at;
      const inner = SECRET_PAIR_HERE.exec(text);
      if (!inner) break;
      const value = at + (inner[1] ?? "").length + (inner[2] ?? "").length;
      const part = valueRewrite(text, value, at + inner[0].length);
      const scheme = inner[3] ?? "";
      if (scheme && value + scheme.length < part[1])
        part[3] = Math.max(part[3], value + scheme.length);
      // Only a value that looks like a credential: the name of the next pair, or a word, is not.
      if (part[4] > part[3] && CREDENTIAL_LIKE.test(text.slice(part[3], part[4])))
        spans.push([part[3], part[4]]);
      from = value;
    }
  }
}

/** A straight or curly quote. */
const QUOTE_CHAR = /["'`\u2018-\u201f]/;
/**
 * The values of the pairs whose name is glued to the word before it (GLUED_PAIR) in `read` (a
 * reading of `text`), added to `spans` as spans of `text`: only a value that looks like a
 * credential (GLUED_CREDENTIAL), since a longer name in prose is often followed by one
 * (`db_password: must be set`).
 */
function gluedPairs(read: Rewritten, text: string, spans: Array<[number, number]>): void {
  const found: Array<[number, number]> = [];
  pairRules(read, found, true, false, GLUED_PAIR);
  for (const [start, end] of found) {
    if (GLUED_CREDENTIAL.test(text.slice(start, end))) spans.push([start, end]);
  }
}

/** A scheme word alone, in any quotes. */
const QUOTED_SCHEME_WORD = new RegExp(
  String.raw`^[\s"'\`\u2018-\u201f]*(?:${SCHEMES}|${MORE_SCHEMES})[\s"'\`\u2018-\u201f]*$`,
  "i",
);

/**
 * What moreSpans adds in `text` to scrub's pair and Authorization rules, read as scrub reads
 * them (after configured values, links and hosts): the parts of its spans that those two rules do
 * not hide, but a pair glued to a word, whose value can be prose. The redaction of source errors
 * (sources/http.ts) masks them in the text it shows a client, whose own rules read none of these
 * shapes; what the two rules alone hide there is left to it, as it was (`Bearer token`, a pair in
 * prose).
 */
export function pairShapeSpans(text: string): Array<[number, number]> {
  if (!SHAPE_HINT.test(text)) return [];
  const added: Array<[number, number]> = [];
  const values = valueSpans(text);
  spansAfterValues(rewrite({ text: asRead(text) }, asRewrites(values), []), [], {}, added);
  return unionSpans(added, []);
}

/** What a text holds when moreSpans can find anything in it. */
const SHAPE_HINT = new RegExp(
  String.raw`bearer|basic|discogs|authorization|https?:\/\/|[&\u2018-\u201f]|${PAIR_NAMES}`,
  "i",
);

/** `text` as scrub's pair and Authorization rules write it, each REDACTED where it stands. */
function twoRules(text: string): Rewritten {
  const pairs: Rewrite[] = [];
  for (const pair of text.matchAll(SECRET_PAIR)) {
    const from = pair.index + (pair[1] ?? "").length + (pair[2] ?? "").length;
    pairs.push([from, pair.index + pair[0].length, REDACTED, from, from]);
  }
  const current = rewrite({ text }, pairs, []);
  const auths: Rewrite[] = [];
  for (const auth of current.text.matchAll(AUTH_SCHEME)) {
    const from = auth.index + (auth[1] ?? auth[2] ?? "").length;
    auths.push([from, auth.index + auth[0].length, REDACTED, from, from]);
  }
  return rewrite(current, auths, []);
}

/**
 * `more` (spans of `text`, sorted, not overlapping), each with the whole of what scrub's pair or
 * Authorization rule writes as one REDACTED where it overlaps one: scrub hides that REDACTED, so
 * none of what it stands for is written (a pair's value `Bearer Bearer '<token>'`, scheme words
 * and spaces too).
 */
function withWholeRewrites(
  text: string,
  more: ReadonlyArray<readonly [number, number]>,
): Array<[number, number]> {
  const current = twoRules(text);
  const out: Array<[number, number]> = more.map(([start, end]) => [start, end]);
  if (!current.from || !current.to) return out;
  let span = 0;
  for (
    let at = current.text.indexOf(REDACTED);
    at !== -1;
    at = current.text.indexOf(REDACTED, at + 1)
  ) {
    const end = at + REDACTED.length;
    const from = current.from[at] as number;
    const to = current.to[end - 1] as number;
    // Only a REDACTED a rule wrote stands for more than its own characters.
    if (to - from === REDACTED.length && text.startsWith(REDACTED, from)) continue;
    while (span < more.length && (more[span] as readonly [number, number])[1] <= from) span++;
    if (span < more.length && (more[span] as readonly [number, number])[0] < to)
      out.push([from, to]);
  }
  return unionSpans(out, []);
}

/**
 * `text` as scrub's pair and Authorization rules write it, with each character that stands for a
 * part of one of `more` (spans of `text`) hidden too: a run of them as one REDACTED.
 */
function withMoreSpans(text: string, more: ReadonlyArray<readonly [number, number]>): string {
  const current = twoRules(text);
  const out: string[] = [];
  let span = 0;
  let hiding = false;
  let kept = 0;
  for (let i = 0; i < current.text.length; i++) {
    const from = current.from ? (current.from[i] as number) : i;
    const to = current.to ? (current.to[i] as number) : i + 1;
    while (span < more.length && (more[span] as readonly [number, number])[1] <= from) span++;
    const hidden = span < more.length && (more[span] as readonly [number, number])[0] < to;
    if (hidden !== hiding) {
      out.push(hiding ? REDACTED : current.text.slice(kept, i));
      kept = i;
      hiding = hidden;
    }
  }
  out.push(hiding ? REDACTED : current.text.slice(kept));
  return out.join("");
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
  // A configured value longer than the window, escaped or folded, is read up to its own reach.
  if (rules.values !== false && valueReach > LOG_CUT_WINDOW)
    spans.push(...configuredSpans(text.slice(0, at + valueReach)));
  const end = settle(spans, at);
  if (end === at) return at;
  const credentials: Array<[number, number]> = [];
  for (const auth of window.matchAll(AUTH_SCHEME)) {
    credentials.push([auth.index + (auth[1] ?? auth[2] ?? "").length, auth.index + auth[0].length]);
  }
  return settle([...spans, ...credentials], end);
}

/** `at`, moved to the start of each of `spans` that it falls inside, until it falls inside none. */
function settle(spans: ReadonlyArray<readonly [number, number]>, at: number): number {
  let end = at;
  for (let moved = true; moved; ) {
    moved = false;
    for (const [start, stop] of spans) {
      if (start < end && end < stop) {
        end = start;
        moved = true;
      }
    }
  }
  return end;
}

/**
 * The last pass, over the serialized line: only the configured secret values (configuredSpans,
 * which reads the line's escapes as JSON writes them) and endpoint hosts, which no JSON syntax is
 * part of. A line this pass would leave invalid JSON is withheld (withheldLine).
 */
function scrubLine(line: string): string {
  try {
    const out = replaceAll(hideValues(line), secretHosts, PROVIDER_ENDPOINT);
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
