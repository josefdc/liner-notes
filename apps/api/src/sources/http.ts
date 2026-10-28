/**
 * The one way the source clients reach the network.
 *
 * Every request has a timeout, every failure is a typed SourceError, and responses can be
 * recorded to or replayed from a cassette:
 *
 *   SOURCE_CASSETTE=record   live requests; each response is scrubbed and written to the cassette
 *   SOURCE_CASSETTE=replay   no network: a request without a cassette entry fails (cassette_miss)
 *   SOURCE_CASSETTE_DIR      where cassettes live (default: apps/api/cassettes)
 *   SOURCE_TIMEOUT_MS        default timeout per request (default: 10000)
 *
 * Cassettes are for tests and evals: either mode is refused when NODE_ENV=production.
 *
 * Recorded payloads keep only the fields the pipeline reads (the request's `scrub`); every
 * recorded value, error and text bodies included, loses secrets, media URLs, e-mail addresses
 * and phone numbers, and long text is capped, so a cassette can be committed. Error messages
 * are redacted the same way before they reach a log or a tool result, and hold the status and at
 * most a short plain-text reason, never a response body (which is logged at debug level only).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SOURCE_CREDENTIALS } from "../config/settings.js";
import { logCut, logger, MAX_LOGGED_TEXT, scrubbedSpans } from "../logger.js";
import { PaceRefused, pacingClock, type RequestPacer } from "./pacing.js";

const log = logger("sources");

// =============================================================================
// Redaction
// =============================================================================

/** Cap for recorded data the pipeline reads: well above what any consumer reads (800). */
const MAX_TEXT = 4000;
/** Cap for recorded error and text bodies, which only feed error handling and the debug log. */
const MAX_ERROR_TEXT = 500;
/** Cap for a source's own reason in an error message: a short line, never a body. */
const MAX_DETAIL = 120;
/**
 * Cap, in UTF-8 bytes, for a JSON error body that is parsed (an error answer is a short
 * message). A longer one is not read at all: neither its text nor anything in it is kept, only
 * its size, and its status speaks for it.
 */
const MAX_ERROR_JSON = 64 * 1024;

/** The source credentials, redacted whatever their length: each is sent on every request. */
const SOURCE_CREDENTIAL_NAMES: ReadonlySet<string> = new Set(Object.values(SOURCE_CREDENTIALS));

/** Values of the environment's credentials, so an echoed key is recognised wherever it appears. */
function knownSecrets(): string[] {
  return (
    Object.entries(process.env)
      .filter(([name, value]) =>
        SOURCE_CREDENTIAL_NAMES.has(name)
          ? Boolean(value)
          : /KEY|SECRET|TOKEN|PASSWORD/i.test(name) && (value?.length ?? 0) >= 8,
      )
      .map(([, value]) => value as string)
      // Longest first, so a key that contains a shorter one is removed whole.
      .sort((a, b) => b.length - a.length)
  );
}

/** Names of a `name=value` pair whose value is a secret (a query parameter, an attribute). */
const SECRET_PARAM_NAMES =
  "api_?key|key|token|access_token|refresh_token|client_secret|password|secret";

/**
 * A part of a text being redacted: its characters from `from` to `to`, kept, or a mask written in
 * their place. The parts of a text cover it in order, so what a mask hides is always known in
 * the text as it came, whatever rules ran before.
 */
type Piece = { from: number; to: number; mask?: string };
/** A span of a text as it reads now, [start, end), and the mask that takes its place. */
type Hide = [start: number, end: number, mask: string];
/** What a rule hides in a text, as the text reads when the rule runs. */
type HideStep = (text: string) => Hide[];

/** The text as one kept part. */
const wholeText = (text: string): Piece[] => (text ? [{ from: 0, to: text.length }] : []);

/** The text that `pieces` of `text` read as now. */
const render = (text: string, pieces: readonly Piece[]) =>
  pieces.map((piece) => piece.mask ?? text.slice(piece.from, piece.to)).join("");

const pieceLength = (piece: Piece) => piece.mask?.length ?? piece.to - piece.from;

/**
 * `pieces` with each of `hides` (spans of the text they read as, sorted by start) masked. A hide
 * that reaches into a mask takes the whole of it, and hides that then overlap are one, with the
 * first one's mask. Reads the pieces and the hides once.
 */
function hide(pieces: readonly Piece[], hides: readonly Hide[]): Piece[] {
  if (hides.length === 0) return [...pieces];
  const starts: number[] = [];
  let at = 0;
  for (const piece of pieces) {
    starts.push(at);
    at += pieceLength(piece);
  }
  const grown: Hide[] = [];
  let first = 0;
  for (const [start, end, mask] of hides) {
    if (end < start) continue;
    let from = start;
    let to = end;
    while (first + 1 < pieces.length && (starts[first + 1] as number) <= from) first++;
    const firstPiece = pieces[first];
    if (from === to) {
      // An empty span writes its mask between two characters, or takes a mask it falls inside.
      if (firstPiece?.mask !== undefined && (starts[first] as number) < from) {
        from = starts[first] as number;
        to = from + firstPiece.mask.length;
      }
    } else {
      if (firstPiece?.mask !== undefined) from = starts[first] as number;
      let last = first;
      while (last + 1 < pieces.length && (starts[last + 1] as number) < to) last++;
      const lastPiece = pieces[last] as Piece;
      if (lastPiece.mask !== undefined) to = (starts[last] as number) + lastPiece.mask.length;
    }
    const previous = grown.at(-1);
    if (previous && from < previous[1]) previous[1] = Math.max(previous[1], to);
    else grown.push([from, to, mask]);
  }
  const out: Piece[] = [];
  let next = 0;
  let open: Piece | undefined;
  pieces.forEach((piece, index) => {
    const start = starts[index] as number;
    const end = start + pieceLength(piece);
    if (end === start) {
      // A mask written as nothing (a trimmed space): inside a hide it is hidden with it.
      if (open) open.to = piece.to;
      else out.push(piece);
      return;
    }
    // The part [a, b) of this piece, in the text as it came.
    const part = (a: number, b: number): Piece =>
      piece.mask !== undefined
        ? { from: piece.from, to: piece.to }
        : { from: piece.from + (a - start), to: piece.from + (b - start) };
    let cursor = start;
    while (cursor < end) {
      const current = grown[next];
      if (!current || current[0] >= end) {
        out.push(piece.mask !== undefined ? piece : part(cursor, end));
        break;
      }
      if (cursor < current[0]) {
        out.push(part(cursor, current[0]));
        cursor = current[0];
      }
      const stop = Math.min(current[1], end);
      const hidden =
        cursor === stop
          ? { from: piece.from + (piece.mask === undefined ? cursor - start : 0), to: 0 }
          : part(cursor, stop);
      if (cursor === stop) hidden.to = hidden.from;
      if (open) open.to = hidden.to;
      else {
        open = { from: hidden.from, to: hidden.to, mask: current[2] };
        out.push(open);
      }
      cursor = stop;
      if (current[1] <= end) {
        open = undefined;
        next++;
      }
    }
  });
  // Empty spans at the end of the text.
  const textEnd = pieces.at(-1)?.to ?? 0;
  for (; next < grown.length; next++) {
    out.push({ from: textEnd, to: textEnd, mask: (grown[next] as Hide)[2] });
  }
  return out;
}

/** The pieces of `text` once each step has run on the text as the steps before it left it. */
function runSteps(text: string, steps: readonly HideStep[], pieces = wholeText(text)): Piece[] {
  let out = pieces;
  for (const step of steps) out = hide(out, step(render(text, out)));
  return out;
}

/** `text` with what each step hides masked, the steps run in order. */
const redactWith = (text: string, steps: readonly HideStep[]) =>
  render(text, runSteps(text, steps));

/** Each match of `pattern` (global), with the part `part` picks hidden behind `mask`. */
function hidesOf(
  text: string,
  pattern: RegExp,
  part: (match: RegExpExecArray) => Span | undefined,
  mask = "[redacted]",
): Hide[] {
  const out: Hide[] = [];
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const span = part(match);
    if (span && span[1] > span[0]) out.push([span[0], span[1], mask]);
  }
  return out;
}

/** Spans (sorted by start) as hides behind "[redacted]", spans that overlap or touch as one. */
function spanHides(spans: readonly Span[]): Hide[] {
  const out: Hide[] = [];
  for (const [start, end] of spans) {
    const last = out.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end, "[redacted]"]);
  }
  return out;
}

/** Each place `secret` appears, left to right, as split() finds it. */
function secretHides(text: string, secret: string): Hide[] {
  const out: Hide[] = [];
  for (let at = text.indexOf(secret); at !== -1; at = text.indexOf(secret, at + secret.length)) {
    out.push([at, at + secret.length, "[redacted]"]);
  }
  return out;
}

// Case-sensitive and token-shaped, so prose such as "the basic track" is left alone.
const BEARER = /\b(Bearer|Basic) [A-Za-z0-9._~+/=-]{12,}/g;
// An unquoted value; a quoted one is read by quotedParamSpans.
const SECRET_PARAM = new RegExp(`\\b(${SECRET_PARAM_NAMES})=([^&\\s"'<>]+)`, "gi");
const TAVILY_KEY = /\btvly-[A-Za-z0-9_-]+/g;
// Spotify access tokens (any other long mixed-case token-like run: tokenRunHides).
const SPOTIFY_TOKEN = /\bBQ[A-Za-z0-9_-]{40,}/g;

/**
 * A run of token characters ([A-Za-z0-9_-]) without its dashes at either end, which is where a
 * word boundary falls. The run is matched once, never rescanned from each dash inside it.
 */
const TOKEN_RUN = /[A-Za-z0-9_](?:[A-Za-z0-9_-]*[A-Za-z0-9_])?/g;

/**
 * Each long mixed-case token-like run: 64 characters or more, with a digit, an upper and a lower
 * case letter. What
 * /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])[A-Za-z0-9_-]{64,}\b/g
 * matched, in linear time.
 */
const tokenRunHides: HideStep = (text) =>
  hidesOf(text, TOKEN_RUN, (run) =>
    run[0].length >= 64 && /\d/.test(run[0]) && /[A-Z]/.test(run[0]) && /[a-z]/.test(run[0])
      ? [run.index, run.index + run[0].length]
      : undefined,
  );

/** Each long mixed-case token-like run (tokenRunHides) as "[redacted]". */
export const redactTokenRuns = (text: string) => redactWith(text, [tokenRunHides]);

/**
 * The rules that remove credentials from text, in order: quoted `name=` values, the values of
 * configured credentials, bearer tokens, `key=…` pairs, token shapes.
 */
const secretSteps = (): HideStep[] => [
  (text) => spanHides(quotedParamSpans(text)),
  ...knownSecrets().map(
    (secret): HideStep =>
      (text) =>
        secretHides(text, secret),
  ),
  (text) =>
    hidesOf(text, BEARER, (m) => [m.index + (m[1] ?? "").length + 1, m.index + m[0].length]),
  (text) =>
    hidesOf(text, SECRET_PARAM, (m) => [m.index + (m[1] ?? "").length + 1, m.index + m[0].length]),
  (text) => hidesOf(text, TAVILY_KEY, (m) => [m.index + 5, m.index + m[0].length]),
  (text) => hidesOf(text, SPOTIFY_TOKEN, (m) => [m.index, m.index + m[0].length]),
  tokenRunHides,
];

/** Removes credentials from text: known key values, bearer tokens, `key=…` pairs, token shapes. */
const redactSecrets = (text: string) => redactWith(text, secretSteps());

/** A key as it is compared: lower case, without "_" or "-" (`accessToken` is `access_token`). */
const keyForm = (key: string) => key.toLowerCase().replace(/[-_]/g, "");

/**
 * Keys whose value is redacted whatever it holds, in a parsed body and quoted in text: compared
 * in any case and with or without "_" and "-" (isSecretKey), so `clientSecret`, `CLIENT-SECRET`
 * and `client_secret` are one key.
 */
const SECRET_KEYS: ReadonlySet<string> = new Set(
  [
    "x-api-key",
    "access_token",
    "refresh_token",
    "id_token",
    "auth_token",
    "api_key",
    "client_secret",
    "private_key",
    "password",
    "token",
    "secret",
    "authorization",
  ].map(keyForm),
);

/** True for a key whose value is a secret (SECRET_KEYS); the parsed path and text use this. */
export const isSecretKey = (key: string) => SECRET_KEYS.has(keyForm(key));

/**
 * A quoted key and its colon: `"password":`, `'token' :`, or `\"api_key\":` inside a JSON string.
 * Group 1 is the backslash before each quote, if any; group 3 the key, which isSecretKey judges.
 * A key is at most 64 characters, so each quote is read on for at most that many.
 */
const QUOTED_KEY = /(\\?)(["'])([A-Za-z0-9_-]{1,64})\1\2\s*:\s*/g;

/**
 * Where a quoted value whose content starts at `start` ends (the index of its closing quote, or
 * the end of the text when it has none). `escaped`: the quotes are written `\"` (a JSON string
 * inside a JSON string), where a backslash of the inner string is written `\\`.
 */
function quotedValueEnd(text: string, start: number, quote: string, escaped: boolean): number {
  let i = start;
  while (i < text.length) {
    const char = text.charAt(i);
    if (!escaped) {
      if (char === quote) return i;
      i += char === "\\" ? 2 : 1;
    } else if (char !== "\\") {
      i += 1;
    } else if (text.charAt(i + 1) === quote) {
      return i;
    } else if (text.charAt(i + 1) === "\\") {
      // An escaped backslash of the inner string: the inner character after it is skipped too.
      i += text.charAt(i + 2) === "\\" ? 4 : 3;
    } else {
      i += 2;
    }
  }
  return text.length;
}

/** A span of text, [start, end): where a value's content lies. */
type Span = [start: number, end: number];

/**
 * Where each quoted value of a quoted secret key lies (its content, without the quotes): in either
 * quote, escapes included, up to its closing quote or the end of the text. Reads the text once.
 */
function quotedKeySpans(text: string): Span[] {
  const spans: Span[] = [];
  QUOTED_KEY.lastIndex = 0;
  for (let key = QUOTED_KEY.exec(text); key; key = QUOTED_KEY.exec(text)) {
    if (!isSecretKey(key[3] ?? "")) continue;
    const at = key.index + key[0].length;
    const backslash = key[1] ?? "";
    const quote = text.charAt(at + backslash.length);
    if (!text.startsWith(backslash, at) || (quote !== '"' && quote !== "'")) continue;
    const start = at + backslash.length + 1;
    const end = quotedValueEnd(text, start, quote, backslash !== "");
    if (end === start) continue;
    spans.push([start, end]);
    QUOTED_KEY.lastIndex = Math.max(end, QUOTED_KEY.lastIndex);
  }
  return spans;
}

/** A secret `name=` pair whose value is quoted: `password="…"`, `token='…'`, `key=\"…\"`. */
const QUOTED_PARAM = new RegExp(`\\b(?:${SECRET_PARAM_NAMES})=(\\\\?)(["'])`, "gi");

/** Where each quoted value of a secret `name=` pair lies, as quotedKeySpans reads it. */
function quotedParamSpans(text: string): Span[] {
  const spans: Span[] = [];
  QUOTED_PARAM.lastIndex = 0;
  for (let pair = QUOTED_PARAM.exec(text); pair; pair = QUOTED_PARAM.exec(text)) {
    const start = pair.index + pair[0].length;
    const end = quotedValueEnd(text, start, pair[2] ?? '"', pair[1] === "\\");
    if (end === start) continue;
    // An escaped opening quote goes with the value: the rule for an unquoted value would
    // otherwise take its backslash for one.
    spans.push([pair[1] ? start - 2 : start, end]);
    QUOTED_PARAM.lastIndex = Math.max(end, QUOTED_PARAM.lastIndex);
  }
  return spans;
}

/**
 * The content of each pair of double quotes, paired as /"[^"]*"/g pairs them; a quote inside one
 * of `skip` (sorted, not overlapping) is not a quote here.
 */
function doubleQuotedSpans(text: string, skip: readonly Span[] = []): Span[] {
  const spans: Span[] = [];
  let next = 0;
  let open = -1;
  for (let i = text.indexOf('"'); i !== -1; i = text.indexOf('"', i + 1)) {
    while (next < skip.length && (skip[next] as Span)[1] <= i) next++;
    const inside = skip[next];
    if (inside && inside[0] <= i) {
      i = inside[1] - 1;
      continue;
    }
    if (open === -1) {
      open = i;
    } else {
      spans.push([open + 1, i]);
      open = -1;
    }
  }
  return spans;
}

/** Two lists of spans, each sorted by start, as one list sorted by start. */
function mergeSpans(a: readonly Span[], b: readonly Span[]): Span[] {
  const out: Span[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const first = a[i];
    const second = b[j];
    if (first && (!second || first[0] <= second[0])) {
      out.push(first);
      i++;
    } else if (second) {
      out.push(second);
      j++;
    }
  }
  return out;
}

/** `text` with each span (sorted by start; spans that overlap or touch as one) as "[redacted]". */
function maskSpans(text: string, spans: readonly Span[]): string {
  let out = "";
  let kept = 0;
  for (let i = 0; i < spans.length; ) {
    let [start, end] = spans[i] as Span;
    for (i++; i < spans.length && (spans[i] as Span)[0] <= end; i++) {
      end = Math.max(end, (spans[i] as Span)[1]);
    }
    out += `${text.slice(kept, start)}[redacted]`;
    kept = end;
  }
  return out + text.slice(kept);
}

/** Where each quoted secret value lies: of a quoted secret key, or of a secret `name=` pair. */
const quotedSecretSpans = (text: string) =>
  maskableUnion(quotedKeySpans(text), quotedParamSpans(text));

/** Two lists of spans as one sorted list in which no two spans overlap. */
function maskableUnion(a: readonly Span[], b: readonly Span[]): Span[] {
  const out: Span[] = [];
  for (const [start, end] of mergeSpans(a, b)) {
    const last = out.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

/**
 * Each quoted value of a quoted secret key, or of a secret `name=` pair, in text that was not
 * parsed (an HTML page, a JSON body that does not parse, a message) as "[redacted]", as the parsed
 * path redacts it by key (`"client_secret": "…"` → `"client_secret": "[redacted]"`,
 * `password="…"` → `password="[redacted]"`). Reads the text once.
 *
 * Known limits, left to the other rules:
 * - a value that is not a quoted string (a number, an object, a list): where it ends is not plain
 *   from the text;
 * - quotes written as HTML entities (`&quot;`), and keys escaped more than once
 *   (`\\\"password\\\":`): redactText and scrubText read these in the decoded text
 *   (moreSecretSpans);
 * - a key and its value at different escape levels (`\"token\":"v"`);
 * - links escaped twice (`https:\\\/\\\/…`) or written with `/` for "/".
 */
export function redactQuotedSecrets(text: string): string {
  return maskSpans(text, quotedSecretSpans(text));
}

/**
 * An object key without quotes, as JavaScript and util.inspect write it (`{ token: 'a' }`,
 * `, apiKey: abc }`), and its colon. Only just after "{" or ",", so a key in prose ("the token: a
 * short sentence") is not one. Group 1 is the key, which isSecretKey judges.
 */
const OBJECT_KEY = /[{,]\s*([A-Za-z0-9_-]{1,64})\s*:\s*/g;
/**
 * A value without quotes: up to whitespace, ",", "}" or "{" (an object is not a value here). A run
 * that holds a quote, "<", ">" or "&" (a string cut off, markup, a query string) is not one
 * either.
 */
const BARE_VALUE = /[^\s,{}"'<>&]+/y;
/**
 * A status word a reason gives in place of a value (`token: invalid`, `Token: expired.`,
 * `api_key: missing`), in any case: a value without quotes that is one is kept.
 */
const STATUS_WORD =
  /^(?:invalid|required|missing|expired|undefined|null|none|empty|true|false|unknown|not set|not found|revoked)[.!,;]*$/i;
/** What ends a value without quotes: "," or "}", after any whitespace, or the end of the text. */
const BARE_VALUE_END = /\s*(?:[,}]|$)/y;

/**
 * Where the value that starts at `at`, after an unquoted object key, lies: a quoted value as
 * quotedKeySpans reads it (also `\"…\"` inside a JSON string, or `…` in backquotes), or a run
 * that "," or "}" ends. A run that more words follow is prose, not a value.
 */
function objectValueSpan(text: string, at: number): Span | undefined {
  const escaped = text.charAt(at) === "\\";
  const quote = text.charAt(escaped ? at + 1 : at);
  if (quote === '"' || quote === "'" || (quote === "`" && !escaped)) {
    const start = at + (escaped ? 2 : 1);
    const end = quotedValueEnd(text, start, quote, escaped);
    return end > start ? [start, end] : undefined;
  }
  BARE_VALUE.lastIndex = at;
  const run = BARE_VALUE.exec(text);
  if (!run || STATUS_WORD.test(run[0])) return undefined;
  const end = at + run[0].length;
  BARE_VALUE_END.lastIndex = end;
  return BARE_VALUE_END.test(text) ? [at, end] : undefined;
}

/**
 * Where the value of each secret object key without quotes lies, a key `judge` takes for a
 * secret. Reads the text once.
 */
function objectKeySpans(text: string, judge = isSecretKey): Span[] {
  const spans: Span[] = [];
  OBJECT_KEY.lastIndex = 0;
  for (let key = OBJECT_KEY.exec(text); key; key = OBJECT_KEY.exec(text)) {
    if (!judge(key[1] ?? "")) continue;
    const span = objectValueSpan(text, key.index + key[0].length);
    if (!span) continue;
    spans.push(span);
    // A key inside the value is not read again; "," or "}" after it can start the next key.
    OBJECT_KEY.lastIndex = Math.max(span[1], OBJECT_KEY.lastIndex);
  }
  return spans;
}

/**
 * An XML or HTML opening tag, with any attributes and an optional namespace prefix
 * (`<access_token>`, `<wsse:Password Type="…">`). Group 1 is its name, group 2 the name without
 * the prefix, which isSecretKey judges.
 */
const OPEN_TAG = /<((?:[A-Za-z_][\w.-]{0,63}:)?([A-Za-z_][\w.-]{0,63}))(?:\s[^<>]*)?>/g;
/** A closing tag; group 1 is its name. */
const CLOSE_TAG = /<\/((?:[A-Za-z_][\w.-]{0,63}:)?[A-Za-z_][\w.-]{0,63})\s*>/g;

/**
 * Where the content of each element named after a secret key lies, in any case: from its opening
 * tag to the first closing tag of the same name after it, unless it is a status word. An element
 * without one (a placeholder such as "--token <token>" in a usage line) is left alone. `judge`
 * takes the name without its prefix for a secret. Reads the text twice: once for the closing
 * tags, once for the opening ones, each closing tag passed once.
 */
function elementSpans(text: string, judge = isSecretKey): Span[] {
  const closing = new Map<string, Span[]>();
  CLOSE_TAG.lastIndex = 0;
  for (let tag = CLOSE_TAG.exec(text); tag; tag = CLOSE_TAG.exec(text)) {
    const written = tag[1] ?? "";
    const name = written.toLowerCase();
    if (!judge(written.slice(written.indexOf(":") + 1))) continue;
    const list = closing.get(name) ?? [];
    list.push([tag.index, tag.index + tag[0].length]);
    closing.set(name, list);
  }
  const spans: Span[] = [];
  if (closing.size === 0) return spans;
  const passed = new Map<string, number>();
  OPEN_TAG.lastIndex = 0;
  for (let tag = OPEN_TAG.exec(text); tag; tag = OPEN_TAG.exec(text)) {
    const start = tag.index + tag[0].length;
    const name = (tag[1] ?? "").toLowerCase();
    const list = closing.get(name);
    // Not a secret element, or one that closes itself (`<token/>`).
    if (!list || text.charAt(start - 2) === "/") continue;
    let next = passed.get(name) ?? 0;
    while (next < list.length && (list[next] as Span)[0] < start) next++;
    passed.set(name, next);
    const close = list[next];
    if (!close) continue;
    // A status word (`<token>expired</token>`) is kept, as a value without quotes is.
    if (close[0] > start && !STATUS_WORD.test(text.slice(start, close[0]).trim())) {
      spans.push([start, close[0]]);
    }
    OPEN_TAG.lastIndex = close[1];
  }
  return spans;
}

/**
 * A `Name: value` header line: a name at the start of a line (after any indent, or curl's "> "
 * before a request header or "< " before a response header), then its colon. Group 1 is the name.
 * A line ends at CR, LF, VT, FF, NEL, U+2028 or U+2029.
 */
const HEADER_LINE =
  /(?:^|[\r\n\v\f\u0085\u2028\u2029])[ \t]*(?:[<>][ \t]+)?([A-Za-z0-9_-]{1,64})[ \t]*:[ \t]*/g;
/** A header value: one run without whitespace or NEL to the end of its line (or a quoted one). */
const HEADER_VALUE = /[^\s\u0085]+/y;
/** Any whitespace after a header value that is not a line break, then the line's end. */
const HEADER_VALUE_END = /[^\S\r\n\v\f\u2028\u2029]*(?:[\r\n\v\f\u0085\u2028\u2029]|$)/y;

/**
 * Where the value of each header line for a secret lies (`X-Api-Key: abc`, `Api-Key: abc`,
 * `X-Auth-Token: abc`): its name, without an "X-" prefix, is a secret key, and its value is one
 * run to the end of the line, or a quoted value read as quotedKeySpans reads one. Reads the text
 * once.
 */
function headerLineSpans(text: string): Span[] {
  const spans: Span[] = [];
  HEADER_LINE.lastIndex = 0;
  for (let line = HEADER_LINE.exec(text); line; line = HEADER_LINE.exec(text)) {
    const name = line[1] ?? "";
    if (!isSecretKey(name) && !isSecretKey(name.replace(/^x-/i, ""))) continue;
    const start = line.index + line[0].length;
    const quote = text.charAt(start);
    if (quote === '"' || quote === "'") {
      // A quoted value (`password: "a b"`, an indented line of util.inspect): its content.
      const end = quotedValueEnd(text, start + 1, quote, false);
      if (end > start + 1) spans.push([start + 1, end]);
      HEADER_LINE.lastIndex = Math.max(end, HEADER_LINE.lastIndex);
      continue;
    }
    HEADER_VALUE.lastIndex = start;
    const value = HEADER_VALUE.exec(text);
    if (!value || STATUS_WORD.test(value[0])) continue;
    const end = start + value[0].length;
    HEADER_VALUE_END.lastIndex = end;
    if (!HEADER_VALUE_END.test(text)) continue;
    spans.push([start, end]);
    HEADER_LINE.lastIndex = end;
  }
  return spans;
}

/**
 * Where each secret value of a key without quotes lies in text that was not parsed: after an
 * object key, inside an element named after a secret key, or on a header line. A value without
 * quotes that is a status word (STATUS_WORD: `token: invalid`, `Token: expired.`) is a reason a
 * person reads, not a secret, and is kept; a quoted value is a value whatever it says.
 *
 * Known limits of the shapes without a quoted key, left to the other rules:
 * - an object key without quotes counts only just after "{" or ",", and a value without quotes
 *   only when "," or "}" (or the end of the text) follows it: "the token: a short sentence" and
 *   "Hello, token: a short sentence" are prose. A value that is an object or a list is left;
 * - a header line counts only at the start of a line, and only with a value of one run to the end
 *   of the line: "Invalid token: abc123" mid-line, "Password: must be 8 characters" and
 *   "Authorization: Basic …" (the Bearer|Basic rule reads that one) are left, and so are lines
 *   written with escaped line breaks (`\n` inside a JSON string);
 * - an element needs its closing tag (a body cut off inside one keeps the rest), and tags written
 *   as entities (`&lt;token&gt;`) are not read;
 * - an "X-" prefix is dropped only from a header line's name: `{ x_auth_token: v }` and
 *   `<X-Auth-Token>` are not read, while `x-api-key`, a secret key itself, is read in every shape.
 * moreSecretSpans reads the escaped line breaks, the entities and the "X-" prefixes.
 */
const unquotedKeySpans = (text: string) =>
  maskableUnion(objectKeySpans(text), maskableUnion(elementSpans(text), headerLineSpans(text)));

/**
 * Names whose value is a secret besides SECRET_KEYS, compared as keys are (keyForm). A short list
 * on purpose: headers named after their service, and two well-known fields. A header or field
 * name that ends in a secret key (`X-Vault-Token`, `X-Goog-Api-Key`) needs no entry
 * (isSecretFieldName).
 */
const MORE_SECRET_NAMES: ReadonlySet<string> = new Set(
  [
    // Azure API Management and Azure Functions.
    "ocp-apim-subscription-key",
    "functions-key",
    // AWS: `<SecretAccessKey>`, `aws_secret_access_key = …`.
    "secret-access-key",
    // Django's form field, and the CSRF field of Express and Spring (`_csrf`).
    "csrfmiddlewaretoken",
    "csrf",
    // Django's and Flask's signing key (`SECRET_KEY`).
    "secret-key",
  ].map(keyForm),
);

/** The longest of SECRET_KEYS and MORE_SECRET_NAMES: the last words of a name are read up to it. */
const MAX_NAME_LENGTH = Math.max(
  ...[...SECRET_KEYS, ...MORE_SECRET_NAMES].map((key) => key.length),
);

/** The first word of a pagination or sync cursor (`next_page_token`, `pageToken`): not a secret. */
const CURSOR_WORD = /^(?:next|page|continuation|sync)$/i;

/** A name without an "X-" prefix and an index ("-0", "_1"): `X-Auth-Token`, `Token-0`. */
const bareName = (name: string) => name.replace(/^x[-_]/i, "").replace(/[-_]\d{1,4}$/, "");

/**
 * True for a key whose value is a secret in the shapes moreSecretSpans reads: a secret key
 * (isSecretKey) or one of MORE_SECRET_NAMES, also with an "X-" prefix or an index
 * (`x_auth_token`, `Token-0`).
 */
function isSecretName(name: string): boolean {
  const bare = bareName(name);
  return (
    isSecretKey(name) ||
    isSecretKey(bare) ||
    MORE_SECRET_NAMES.has(keyForm(name)) ||
    MORE_SECRET_NAMES.has(keyForm(bare))
  );
}

/**
 * The words of a name, as "-", "_", "." and a change of case part them (`RapidAPI-Key`); digits go
 * with the letters around them (`pw1token` is one word).
 */
const NAME_WORD = /[A-Z0-9]+(?=[A-Z][a-z])|[A-Z0-9]?[a-z0-9]+|[A-Z0-9]+/g;

/**
 * True for the name of a header, a config field, an element or a form field whose value is a
 * secret: a secret name (isSecretName), or a name whose last words are a secret key
 * (`X-Vault-Token`, `Private-Token`, `X-Goog-Api-Key`, `github_token`, `SessionToken`,
 * `csrf-token`). `token_count`, `tokenizer`, `Idempotency-Key` and `PRIMARY_KEY` are not: "key"
 * alone is not a secret key; nor is a cursor (CURSOR_WORD). An object key is judged by
 * isSecretName only, so `{ my_token: 'kept' }` reads as it did. The last words are joined from
 * the end and read no further than MAX_NAME_LENGTH, so a long name is read in linear time.
 */
function isSecretFieldName(name: string): boolean {
  if (isSecretName(name)) return true;
  const words = bareName(name).match(NAME_WORD) ?? [];
  if (CURSOR_WORD.test(words[0] ?? "")) return false;
  let last = "";
  for (let i = words.length - 1; i >= 1; i--) {
    last = keyForm(words[i] ?? "") + last;
    if (last.length > MAX_NAME_LENGTH) break;
    if (SECRET_KEYS.has(last) || MORE_SECRET_NAMES.has(last)) return true;
  }
  return false;
}

/** An environment variable's name: upper-case letters, digits and "_". */
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * True for an environment variable named for a secret, judged as a field name
 * (isSecretFieldName): `GITHUB_TOKEN`, `OPENAI_API_KEY`, `DB_PASSWORD`, `SECRET_KEY`; not
 * `IDEMPOTENCY_KEY` or `S3_KEY`.
 */
const isSecretEnvName = (name: string) => ENV_NAME.test(name) && isSecretFieldName(name);

/**
 * A scheme an Authorization value names before its credentials (`Token abc`, `Bot abc`). A
 * value that is a scheme word alone (`Bearer`) names what is missing, and is kept.
 */
const AUTH_SCHEME =
  /^(?:Bearer|Basic|Token|Bot|Digest|ApiKey|Api-Key|OAuth|SSWS|JWT|DPoP|MAC|Hawk|Negotiate|NTLM|Discogs|AWS4-HMAC-SHA256)$/i;
/** Credentials written as one token (RFC 7235's token68), "=" only at its end. */
const TOKEN68 = /^[A-Za-z0-9._~+/-]+=*$/;
/** Where an Authorization value's parameters start: a name and "=". */
const AUTH_PARAM_START = /^[A-Za-z0-9_.-]+[ \t]*=/;
/**
 * A `name=value` parameter of an Authorization value; group 2 is a quoted value's content. A name
 * starts only where no name character comes before it, so a long run is read from its start
 * once, never again from each of its characters.
 */
const AUTH_PARAM =
  /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]+)[ \t]*=[ \t]*(?:"((?:[^"\\]|\\.)*)"?|([^\s,"]*))/g;

/** Words a value without quotes can be besides STATUS_WORD, read by the shapes below only. */
const MORE_STATUS_WORD = /^(?:nil|unset)[.!,;]*$/i;

/** True for a status word (STATUS_WORD, MORE_STATUS_WORD) in place of a value. */
const isStatusWord = (value: string) => STATUS_WORD.test(value) || MORE_STATUS_WORD.test(value);

const LINE_BREAK = /[\r\n\v\f\u0085\u2028\u2029]/;
/** The next line break (CR, LF, VT, FF, NEL, U+2028, U+2029) or the end of the text. */
const LINE_END = /[\r\n\v\f\u0085\u2028\u2029]|$/g;

/** Where the line that `at` is on ends: its line break, or the end of the text. */
function lineEnd(text: string, at: number): number {
  LINE_END.lastIndex = at;
  return LINE_END.exec(text)?.index ?? text.length;
}

/** `end` moved back over any whitespace before it, not before `start`. */
function trimmedEnd(text: string, start: number, end: number): number {
  let stop = end;
  while (stop > start && /\s/.test(text.charAt(stop - 1))) stop--;
  return stop;
}

/** Attributes of a Set-Cookie value, which say where and how long, not what: kept. */
const COOKIE_ATTRIBUTES: ReadonlySet<string> = new Set([
  "path",
  "domain",
  "expires",
  "max-age",
  "samesite",
  "priority",
  "version",
  "comment",
]);

/**
 * Adds to `spans` where each cookie value lies in a `Cookie` or `Set-Cookie` value from `start` to
 * `end`: the value of each `name=value` pair (also `name = value`), up to ";" (its content when
 * quoted). Cookie names are kept, and so are the attributes of a Set-Cookie value (`Path=/`,
 * `Expires=…`); there, where fetch joins several cookies with ",", a value also ends and a pair
 * starts at ",", which a cookie value without quotes never holds. A status word is kept.
 * Reads the value once.
 */
function cookieSpans(text: string, start: number, end: number, set: boolean, spans: Span[]): void {
  const separator = (char: string) => char === ";" || (set && char === ",");
  let at = start;
  while (at < end) {
    while (at < end && /[\s;,]/.test(text.charAt(at))) at++;
    let i = at;
    while (i < end && !/[=;,\s]/.test(text.charAt(i))) i++;
    if (at >= end) break;
    // `sid = v`: spaces around "=" are read too.
    let equals = i;
    while (equals < end && /[ \t]/.test(text.charAt(equals))) equals++;
    if (i === at || text.charAt(equals) !== "=") {
      // Not a pair: a flag (`HttpOnly`) or the words of a date. On to the next separator.
      while (i < end && !separator(text.charAt(i))) i++;
      at = i;
      continue;
    }
    const attribute = set && COOKIE_ATTRIBUTES.has(text.slice(at, i).toLowerCase());
    let from = equals + 1;
    while (from < end && /[ \t]/.test(text.charAt(from))) from++;
    // A quoted value runs to its closing quote; then to the next separator.
    let stop = from;
    if (text.charAt(from) === '"') {
      stop++;
      while (stop < end && text.charAt(stop) !== '"') stop++;
    }
    while (stop < end && !separator(text.charAt(stop))) stop++;
    if (!attribute) {
      let to = trimmedEnd(text, from, stop);
      if (to - from >= 2 && text.charAt(from) === '"' && text.charAt(to - 1) === '"') {
        from++;
        to--;
      }
      if (to > from && !isStatusWord(text.slice(from, to))) spans.push([from, to]);
    }
    at = stop;
  }
}

/**
 * A field at the start of a line: a header (`X-Api-Key: v`, after curl's "> " or "< "), a YAML
 * mapping or list item (`token: v`, `- api_key: v`), a TOML assignment (`api_key = "v"`, also
 * with a quoted name) or an environment line (`export GITHUB_TOKEN=v`). Group 1, 2 or 3 is the
 * name, group 5 the ":" or "=" after it, groups 4 and 6 the spaces around that.
 */
const FIELD_LINE =
  /(?:^|[\r\n\v\f\u0085\u2028\u2029])[ \t]*(?:[<>][ \t]+|-[ \t]+|export[ \t]+)?(?:"([A-Za-z0-9_.-]{1,64})"|'([A-Za-z0-9_.-]{1,64})'|([A-Za-z0-9_.-]{1,64}))([ \t]*)([:=])([ \t]*)/g;

/**
 * Adds where the value without quotes of a field line lies, from `start` to the end of its line:
 * one run, or after an Authorization scheme (`Token abc`), its credentials: one token, or the
 * value of each `name=value` parameter but `realm` (`Digest username="a", realm="b"`: `username`
 * and `nonce` are masked too, as any parameter but the realm may be one). After
 * "=", the run holds no quote, "<", ">" or "&" (as a `name=` value, which SECRET_PARAM reads)
 * and a "#" comment may follow it. A status word, or a scheme word alone, is kept.
 */
function fieldValueSpans(text: string, start: number, assignment: boolean, spans: Span[]): void {
  const stop = trimmedEnd(text, start, lineEnd(text, start));
  const value = text.slice(start, stop);
  const space = value.search(/\s/);
  const first = space === -1 ? value : value.slice(0, space);
  const rest = space === -1 ? "" : value.slice(space).trimStart();
  if (assignment) {
    if (!first || /["'<>&]/.test(first) || isStatusWord(first)) return;
    if (rest === "" || rest.startsWith("#")) spans.push([start, start + first.length]);
    return;
  }
  if (space === -1) {
    if (value && !isStatusWord(value) && !AUTH_SCHEME.test(value)) spans.push([start, stop]);
    return;
  }
  if (!AUTH_SCHEME.test(first) || isStatusWord(rest)) return;
  const from = stop - rest.length;
  if (TOKEN68.test(rest) || (!rest.includes("=") && !/\s/.test(rest))) {
    spans.push([from, stop]);
    return;
  }
  // Parameters (`username="a", realm="b"`): the value starts with one.
  if (!AUTH_PARAM_START.test(rest)) return;
  AUTH_PARAM.lastIndex = 0;
  for (let param = AUTH_PARAM.exec(rest); param; param = AUTH_PARAM.exec(rest)) {
    if ((param[1] ?? "").toLowerCase() === "realm") continue;
    const content = param[2] ?? param[3] ?? "";
    if (!content || isStatusWord(content)) continue;
    // The value's content ends the match, but for a closing quote.
    const close = param[2] !== undefined && param[0].endsWith('"') ? 1 : 0;
    const end = from + param.index + param[0].length - close;
    spans.push([end - content.length, end]);
  }
}

/**
 * Where the value of each field line for a secret lies (FIELD_LINE): its name is a secret field
 * name (isSecretFieldName). A quoted
 * value is read as quotedKeySpans reads one; a `Cookie` or `Set-Cookie` line by cookieSpans.
 * Reads the text once.
 */
function fieldLineSpans(text: string): Span[] {
  const spans: Span[] = [];
  FIELD_LINE.lastIndex = 0;
  for (let line = FIELD_LINE.exec(text); line; line = FIELD_LINE.exec(text)) {
    const name = line[1] ?? line[2] ?? line[3] ?? "";
    const assignment = line[5] === "=";
    const start = line.index + line[0].length;
    const cookie = assignment ? "" : name.toLowerCase();
    // `name= v` or `name =v`: neither an environment line nor a TOML assignment as written.
    const lopsided = assignment && !line[4] !== !line[6];
    let end = start;
    if (cookie === "cookie" || cookie === "set-cookie") {
      end = lineEnd(text, start);
      cookieSpans(text, start, end, cookie === "set-cookie", spans);
    } else if (!lopsided && isSecretFieldName(name)) {
      const quote = text.charAt(start);
      if (quote === '"' || quote === "'") {
        end = quotedValueEnd(text, start + 1, quote, false);
        if (end > start + 1) spans.push([start + 1, end]);
      } else {
        end = lineEnd(text, start);
        fieldValueSpans(text, start, assignment, spans);
      }
    }
    FIELD_LINE.lastIndex = Math.max(end, FIELD_LINE.lastIndex);
  }
  return spans;
}

/** An environment assignment anywhere in a line (`-e OPENAI_API_KEY=v`); group 1 is the name. */
const ENV_PAIR = /(?<![\w$.-])([A-Z][A-Z0-9_]{0,63})=/g;
/** An environment value without quotes: up to whitespace, a quote, or a shell or list separator. */
const ENV_VALUE = /[^\s"'`;&|<>()[\]{},]+/y;

/** A template's reference as a value: `${{ secrets.GH }}`, `${TOKEN}`, read on one line. */
const TEMPLATE_REFERENCE = /^\$\{\{[^\r\n}]*\}\}|^\$\{[^\r\n}]*\}/;
/** How far a template's reference is read, at most. */
const MAX_TEMPLATE_REFERENCE = 256;

/** A status word of two words (`not set`): the word after a value. */
const NEXT_WORD = /[ \t]+([^\s"'`;&|<>()[\]{},]+)/y;

/**
 * Where the value of each environment assignment named for a secret (isSecretEnvName) lies. A
 * status word is kept, also of two words (`API_TOKEN=not set`). Reads the text once.
 */
function envPairSpans(text: string): Span[] {
  const spans: Span[] = [];
  ENV_PAIR.lastIndex = 0;
  for (let pair = ENV_PAIR.exec(text); pair; pair = ENV_PAIR.exec(text)) {
    if (!isSecretEnvName(pair[1] ?? "")) continue;
    const at = pair.index + pair[0].length;
    const quote = text.charAt(at);
    if (quote === '"' || quote === "'") {
      const end = quotedValueEnd(text, at + 1, quote, false);
      if (end > at + 1) spans.push([at + 1, end]);
      ENV_PAIR.lastIndex = Math.max(end, ENV_PAIR.lastIndex);
      continue;
    }
    // A template's reference (`${{ secrets.GH }}`, `${TOKEN}`) is masked whole.
    const template = TEMPLATE_REFERENCE.exec(text.slice(at, at + MAX_TEMPLATE_REFERENCE));
    if (template) {
      spans.push([at, at + template[0].length]);
      ENV_PAIR.lastIndex = Math.max(at + template[0].length, ENV_PAIR.lastIndex);
      continue;
    }
    ENV_VALUE.lastIndex = at;
    const value = ENV_VALUE.exec(text);
    if (!value) continue;
    NEXT_WORD.lastIndex = at + value[0].length;
    const next = NEXT_WORD.exec(text)?.[1];
    if (!isStatusWord(value[0]) && !(next && isStatusWord(`${value[0]} ${next}`))) {
      spans.push([at, at + value[0].length]);
    }
    // A name inside the value is not read again.
    ENV_PAIR.lastIndex = Math.max(at + value[0].length, ENV_PAIR.lastIndex);
  }
  return spans;
}

/**
 * A cookie header as an object key or a Map entry, with a quoted value (`Cookie: 'a=1'`,
 * `"set-cookie": "a"`, `'cookie' => 'a=1'`).
 */
const COOKIE_KEY = /(?<![\w-])(["']?)(set-cookie|cookie)\1[ \t]*(?::|=>)[ \t]*(["'])/gi;

/** Where each cookie value lies in the quoted value of a cookie key (cookieSpans). */
function cookieKeySpans(text: string): Span[] {
  const spans: Span[] = [];
  COOKIE_KEY.lastIndex = 0;
  for (let key = COOKIE_KEY.exec(text); key; key = COOKIE_KEY.exec(text)) {
    const start = key.index + key[0].length;
    const end = quotedValueEnd(text, start, key[3] ?? '"', false);
    cookieSpans(text, start, end, (key[2] ?? "").toLowerCase() === "set-cookie", spans);
    COOKIE_KEY.lastIndex = Math.max(end, COOKIE_KEY.lastIndex);
  }
  return spans;
}

/**
 * Where the value of each key that `pattern` (global) finds lies, read as after an object key
 * without quotes (objectValueSpan), when `key` picks a secret name from the match.
 */
function keyValueSpans(
  text: string,
  pattern: RegExp,
  key: (match: RegExpExecArray) => string | undefined,
): Span[] {
  const spans: Span[] = [];
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (!isSecretName(key(match) ?? "")) continue;
    const span = objectValueSpan(text, match.index + match[0].length);
    if (!span) continue;
    spans.push(span);
    pattern.lastIndex = Math.max(span[1], pattern.lastIndex);
  }
  return spans;
}

/**
 * A key and its arrow, as util.inspect writes a Map entry and PHP or Ruby a hash entry:
 * `'authorization' => `, `"token" => `, `:token => `. Group 2 or 3 is the key.
 */
const ARROW_KEY = /(?:(["'])([A-Za-z0-9_-]{1,64})\1|(?<![\w:]):([A-Za-z0-9_]{1,64}))\s*=>\s*/g;

/**
 * A print_r entry, `[api_key] => `, spaced any way (`[api_key]=>`), also of a property
 * (`[token:protected] => `).
 */
const PRINT_R_KEY = /\[([A-Za-z0-9_-]{1,64})(?::[^\]\r\n]{0,128})?\][ \t]*=>[ \t]*/g;
/** A print_r value that opens a nested array or object, which is read entry by entry. */
const PRINT_R_NESTED = /^(?:Array|[\w\\]+ Object)$/;

/** Where the value of each print_r entry for a secret lies: the rest of its line. */
function printRSpans(text: string): Span[] {
  const spans: Span[] = [];
  PRINT_R_KEY.lastIndex = 0;
  for (let key = PRINT_R_KEY.exec(text); key; key = PRINT_R_KEY.exec(text)) {
    if (!isSecretName(key[1] ?? "")) continue;
    const start = key.index + key[0].length;
    const end = lineEnd(text, start);
    const stop = trimmedEnd(text, start, end);
    const value = text.slice(start, stop);
    if (value && !isStatusWord(value) && !PRINT_R_NESTED.test(value)) spans.push([start, stop]);
    PRINT_R_KEY.lastIndex = Math.max(end, PRINT_R_KEY.lastIndex);
  }
  return spans;
}

/**
 * A var_dump entry holding a string, `["token"]=>` and `string(3) "`, on one line or two (also of
 * a property, `["token":protected]=>`, and a reference, `&string(3)`). Group 1 is the key,
 * group 2 the string's length in bytes.
 */
const VAR_DUMP_STRING =
  /\["([A-Za-z0-9_-]{1,64})"(?::[^\]\r\n]{0,128})?\]=>\s*&?string\((\d{1,9})\) "/g;

/** Where the string of each var_dump entry for a secret lies: its length in UTF-8 bytes. */
function varDumpSpans(text: string): Span[] {
  const spans: Span[] = [];
  // Where the line of `at` ends, read once for all the entries on one line.
  let knownEnd = -1;
  const lineAfter = (at: number) => {
    if (at > knownEnd) knownEnd = lineEnd(text, at);
    return knownEnd;
  };
  VAR_DUMP_STRING.lastIndex = 0;
  for (let key = VAR_DUMP_STRING.exec(text); key; key = VAR_DUMP_STRING.exec(text)) {
    if (!isSecretName(key[1] ?? "")) continue;
    const start = key.index + key[0].length;
    const bytes = Number(key[2]);
    let end = start;
    for (let read = 0; end < text.length && read < bytes; ) {
      const code = text.codePointAt(end) ?? 0;
      read += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
      end += code > 0xffff ? 2 : 1;
    }
    // A length that does not match the text as it reads (another encoding, a length past the
    // string): to the quote that ends the line the string starts on, if one does, so the next
    // entries stay readable; else to the end of the line the count reached.
    if (text.charAt(end) !== '"') {
      const line = lineAfter(start);
      const close = trimmedEnd(text, start, line) - 1;
      end = close >= start && text.charAt(close) === '"' ? close : lineEnd(text, end);
    }
    if (end > start) spans.push([start, end]);
    VAR_DUMP_STRING.lastIndex = Math.max(end, VAR_DUMP_STRING.lastIndex);
  }
  return spans;
}

/** An `<input>` or `<meta>` tag's start; group 1 is its name. */
const FORM_TAG = /<(input|meta)(?=[\s/>])/gi;

/**
 * Where the value of each form field for a secret lies: `<input name="token" value="v">`, its
 * attributes in any order, also `type="password"`, and `<meta name="csrf-token" content="v">`.
 * A field is named by its `name` or `id` (isSecretFieldName). An attribute value is read to its
 * closing quote, a ">" inside it included. Reads each tag once.
 */
function formFieldSpans(text: string): Span[] {
  const spans: Span[] = [];
  FORM_TAG.lastIndex = 0;
  for (let tag = FORM_TAG.exec(text); tag; tag = FORM_TAG.exec(text)) {
    const attributes = new Map<string, Span>();
    let at = tag.index + tag[0].length;
    for (;;) {
      while (at < text.length && /[\s/]/.test(text.charAt(at))) at++;
      const char = text.charAt(at);
      if (!char || char === ">" || char === "<") break;
      const nameStart = at;
      while (at < text.length && !/[\s/>=<"']/.test(text.charAt(at))) at++;
      if (at === nameStart) {
        at++;
        continue;
      }
      const name = text.slice(nameStart, at).toLowerCase();
      let value = at;
      while (value < text.length && /\s/.test(text.charAt(value))) value++;
      if (text.charAt(value) !== "=") continue;
      value++;
      while (value < text.length && /\s/.test(text.charAt(value))) value++;
      const quote = text.charAt(value);
      let span: Span;
      if (quote === '"' || quote === "'") {
        const close = text.indexOf(quote, value + 1);
        span = [value + 1, close === -1 ? text.length : close];
        at = close === -1 ? text.length : close + 1;
      } else {
        at = value;
        while (at < text.length && !/[\s>]/.test(text.charAt(at))) at++;
        span = [value, at];
      }
      if (!attributes.has(name)) attributes.set(name, span);
    }
    const read = (name: string) => {
      const span = attributes.get(name);
      return span ? text.slice(span[0], span[1]) : "";
    };
    const input = (tag[1] ?? "").toLowerCase() === "input";
    const type = read("type").toLowerCase();
    // A choice (`show_password`) is not a secret, whatever it is named.
    const choice = input && (type === "checkbox" || type === "radio");
    const secret =
      !choice &&
      (isSecretFieldName(read("name")) ||
        isSecretFieldName(read("id")) ||
        (input && type === "password"));
    const field = attributes.get(input ? "value" : "content");
    if (secret && field && field[1] > field[0]) spans.push(field);
    FORM_TAG.lastIndex = Math.max(at, FORM_TAG.lastIndex);
  }
  return spans;
}

/**
 * Where pydantic echoes the input of a field that failed: `[type=…, input_value=`. Group 1 is
 * the error's type.
 */
const PYDANTIC_INPUT = /\[type=([A-Za-z0-9_.]{1,64}), input_value=/g;
/** The line before it, which names the field (`password`, `body.api_key`); group 1 is the name. */
const PYDANTIC_FIELD = /^[ \t]*([A-Za-z0-9_.-]{1,128})[ \t]*$/;

/**
 * Where each `input_value` of a pydantic validation error lies when the line before names a
 * secret field (isSecretFieldName, its last part): a quoted value's content, or what is written
 * up to ", input_type=" or "]". A status word (`None`, `True`) is kept, and so is the input of
 * any other field, and of a missing field (`type=missing`), which is the object around it.
 * Reads the text once.
 */
function pydanticInputSpans(text: string): Span[] {
  const spans: Span[] = [];
  let scanned = 0;
  let lineStart = 0;
  let previousStart = -1;
  let judgedLine = -1;
  let secret = false;
  PYDANTIC_INPUT.lastIndex = 0;
  for (let input = PYDANTIC_INPUT.exec(text); input; input = PYDANTIC_INPUT.exec(text)) {
    for (; scanned < input.index; scanned++) {
      const char = text.charAt(scanned);
      if (!LINE_BREAK.test(char)) continue;
      // CR LF is one line break.
      if (!(char === "\n" && text.charAt(scanned - 1) === "\r")) previousStart = lineStart;
      lineStart = scanned + 1;
    }
    if (previousStart < 0) continue;
    if (judgedLine !== lineStart) {
      judgedLine = lineStart;
      let previousEnd = lineStart - 1;
      if (text.charAt(previousEnd) === "\n" && text.charAt(previousEnd - 1) === "\r") previousEnd--;
      const field = PYDANTIC_FIELD.exec(text.slice(previousStart, previousEnd))?.[1] ?? "";
      const last =
        field
          .split(".")
          .filter((part) => part && !/^\d+$/.test(part))
          .at(-1) ?? "";
      secret = isSecretFieldName(last);
    }
    if (!secret || input[1] === "missing") continue;
    const at = input.index + input[0].length;
    const quote = text.charAt(at);
    let end: number;
    if (quote === "'" || quote === '"') {
      end = quotedValueEnd(text, at + 1, quote, false);
      if (end > at + 1) spans.push([at + 1, end]);
    } else {
      end = at;
      while (
        end < text.length &&
        text.charAt(end) !== "]" &&
        !LINE_BREAK.test(text.charAt(end)) &&
        !text.startsWith(", input_type=", end)
      ) {
        end++;
      }
      const value = text.slice(at, end);
      if (value && !isStatusWord(value)) spans.push([at, end]);
    }
    PYDANTIC_INPUT.lastIndex = Math.max(end, PYDANTIC_INPUT.lastIndex);
  }
  return spans;
}

/** The shapes moreSecretSpans reads that are not read line by line. */
const inlineShapeSpans = (text: string): Span[] =>
  [
    envPairSpans(text),
    cookieKeySpans(text),
    objectKeySpans(text, isSecretName),
    keyValueSpans(text, QUOTED_KEY, (key) => key[3]),
    keyValueSpans(text, ARROW_KEY, (key) => key[2] ?? key[3]),
    varDumpSpans(text),
    elementSpans(text, isSecretFieldName),
    formFieldSpans(text),
  ].reduce(maskableUnion);

/** The shapes moreSecretSpans reads line by line: fields, print_r entries, pydantic inputs. */
const lineShapeSpans = (text: string): Span[] =>
  [fieldLineSpans(text), printRSpans(text), pydanticInputSpans(text)].reduce(maskableUnion);

/** The shapes moreSecretSpans reads in the text as it is written. */
const shapeSpans = (text: string) => maskableUnion(inlineShapeSpans(text), lineShapeSpans(text));

/**
 * A text decoded from another: its character i was written as the characters [from[i], to[i]) of
 * the text as it came. Without `from` and `to`, it is that text.
 */
interface Decoded {
  text: string;
  from?: Int32Array;
  to?: Int32Array;
}

/**
 * `source` with each match of `pattern` (global) that `decode` reads written as what it returns
 * (never longer than the match), or undefined when there is none. Reads the text once.
 */
function decoded(
  source: Decoded,
  pattern: RegExp,
  decode: (match: RegExpExecArray) => string | undefined,
): Decoded | undefined {
  const { text } = source;
  const from = new Int32Array(text.length);
  const to = new Int32Array(text.length);
  const fromAt = (i: number) => source.from?.[i] ?? i;
  const toAt = (i: number) => source.to?.[i] ?? i + 1;
  let out = "";
  let length = 0;
  let kept = 0;
  const keep = (end: number) => {
    out += text.slice(kept, end);
    for (let i = kept; i < end; i++, length++) {
      from[length] = fromAt(i);
      to[length] = toAt(i);
    }
  };
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const value = decode(match);
    if (value === undefined) continue;
    keep(match.index);
    out += value;
    for (let i = 0; i < value.length; i++, length++) {
      from[length] = fromAt(match.index);
      to[length] = toAt(match.index + match[0].length - 1);
    }
    kept = match.index + match[0].length;
  }
  if (kept === 0) return undefined;
  keep(text.length);
  return { text: out, from: from.subarray(0, length), to: to.subarray(0, length) };
}

/**
 * A character written as an HTML entity: `&lt;`, `&quot;`, `&#39;`, `&#x3c;`, also without its
 * ";" where no letter or digit follows (`&lt;/token&gt` at the end of a text).
 */
const ENTITY = /&(?:(lt|gt|amp|quot|apos)|#(\d{1,7})|#x([0-9a-f]{1,6}))(?:;|(?![0-9a-z]))/gi;
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

function entityText(match: RegExpExecArray): string | undefined {
  if (match[1]) return NAMED_ENTITIES[match[1].toLowerCase()];
  const code = match[2] ? Number(match[2]) : Number.parseInt(match[3] ?? "", 16);
  return code <= 0x10ffff ? String.fromCodePoint(code) : undefined;
}

/** A backslash escape of a JSON or JavaScript string: `\n`, `\"`, `\\`, `\/`, `<`. */
const STRING_ESCAPE = /\\(?:u([0-9a-fA-F]{4})|([nrtbf"'\\/]))/g;
/** STRING_ESCAPE, or a quote no backslash escapes (group 3): where a JSON string starts or ends. */
const STRING_ESCAPE_OR_QUOTE = /\\(?:u([0-9a-fA-F]{4})|([nrtbf"'\\/]))|(")/g;
const ESCAPED_CHARS: Readonly<Record<string, string>> = {
  n: "\n",
  r: "\r",
  t: "\t",
  b: "\b",
  f: "\f",
};

const escapeText = (match: RegExpExecArray) =>
  match[1]
    ? String.fromCharCode(Number.parseInt(match[1], 16))
    : (ESCAPED_CHARS[match[2] ?? ""] ?? match[2]);

/**
 * escapeText, and a line break in place of a quote no backslash escapes: the string it starts
 * or ends is read as lines of its own, one character for one.
 */
const escapeTextOrBreak = (match: RegExpExecArray) => (match[3] ? "\n" : escapeText(match));

/** How many times a text is decoded, at most, as entities and as string escapes. */
const MAX_DECODINGS = 2;

/** Every rule that reads a key: quoted, without quotes, and shapeSpans. */
const keySpans = (text: string) =>
  [quotedSecretSpans(text), unquotedKeySpans(text), shapeSpans(text)].reduce(maskableUnion);

/** keySpans but the rules that read a line: quoted keys, object keys, elements, inline shapes. */
const inlineKeySpans = (text: string) =>
  [
    quotedSecretSpans(text),
    objectKeySpans(text),
    elementSpans(text),
    inlineShapeSpans(text),
  ].reduce(maskableUnion);

/** An escape that STRING_ESCAPE decodes. */
const HAS_STRING_ESCAPE = /\\(?:u[0-9a-fA-F]{4}|[nrtbf"'\\/])/;

/**
 * Where each secret value lies in the text decoded from HTML entities (`&lt;token&gt;v`,
 * `&quot;token&quot;: &quot;v&quot;`) and from string escapes, each up to MAX_DECODINGS times;
 * what a rule finds there is masked where it was written:
 * - decoded from entities, every rule that reads a key (keySpans);
 * - decoded from string escapes with each quote no backslash escapes read as a line break, so a
 *   line inside a JSON string ends where the string does and starts where it does
 *   (`{"e":"a\r\nX-Api-Key: v","status":401}`), in a text that holds an escape: every rule;
 * - decoded from string escapes alone (`{ token: \\"v\\" }`, where a quote of the outer string
 *   is a quote of the value): every rule but those that read a line, which would run across the
 *   end of the string.
 */
function decodedSpans(text: string): Span[] {
  let spans: Span[] = [];
  const decodings: Array<
    [RegExp, (match: RegExpExecArray) => string | undefined, (text: string) => Span[]]
  > = [];
  if (text.includes("&")) decodings.push([ENTITY, entityText, keySpans]);
  if (text.includes("\\")) {
    decodings.push([STRING_ESCAPE_OR_QUOTE, escapeTextOrBreak, keySpans]);
    decodings.push([STRING_ESCAPE, escapeText, inlineKeySpans]);
  }
  for (const [pattern, decode, rules] of decodings) {
    let view: Decoded = { text };
    for (let level = 0; level < MAX_DECODINGS; level++) {
      // A view in which no escape was decoded holds nothing the text before it does not.
      if (pattern !== ENTITY && !HAS_STRING_ESCAPE.test(view.text)) break;
      const next = decoded(view, pattern, decode);
      if (!next?.from || !next.to) break;
      view = next;
      const { from, to } = next;
      const found = rules(view.text).map(
        ([start, end]): Span => [from[start] ?? 0, to[end - 1] ?? 0],
      );
      spans = maskableUnion(spans, found);
    }
  }
  return spans;
}

/**
 * Where each secret value lies in shapes the rules above do not read, measured on the text as it
 * came; redactKeyValues masks them over what the other rules hide, so they only add masks. A value
 * without quotes that is a status word is kept, as above; a quoted value is a value.
 * - `Cookie:` and `Set-Cookie:` lines (each cookie's value; names and attributes are kept), and
 *   `Authorization: Token v` (any scheme of AUTH_SCHEME; of `Digest a="v"`, the parameters'
 *   values but `realm`);
 * - config text: YAML mappings and list items, TOML assignments and environment lines, at the
 *   start of a line, for a secret field name or a variable named for a secret
 *   (`export GITHUB_TOKEN=v`, also anywhere in a line: `-e OPENAI_API_KEY=v`);
 * - PHP's print_r (`[api_key] => v`) and var_dump (`["token"]=> string(1) "v"`), util.inspect's
 *   Map entries and other `=>` pairs (`'authorization' => 'v'`, `'cookie' => 'sid=v'`), a quoted
 *   key with a value without quotes (`{ 'x-api-key': v }`);
 * - `<input name="token" value="v">` and `<meta name="csrf-token" content="v">` (a checkbox or a
 *   radio button is a choice, and is kept);
 * - vendor headers and fields named after their service (MORE_SECRET_NAMES), a header, field or
 *   element name that ends in a secret key (`X-Vault-Token`, `<SessionToken>`), an "X-" prefix
 *   or an index (`x_auth_token`, S3's `<Token-0>`);
 * - pydantic's `input_value=…` under the line that names a secret field;
 * - all of these, and the quoted and unquoted keys above, in text written with HTML entities or
 *   string escapes (decodedSpans).
 *
 * Known limits, left to the other rules:
 * - a field or an assignment counts only at the start of a line (an environment variable named
 *   for a secret anywhere), with "=" spaced on both sides or on neither, and a value without
 *   quotes only when it is one run to the end of the line (or, after "=", before a "#" comment):
 *   `token: a b # c` and multi-line values (YAML block scalars, TOML's `"""`, a print_r string
 *   with line breaks) are left, since where they end is not plain from the line;
 * - a line indented with a no-break space or another space than " " and a tab, or opened by a
 *   bullet other than "- " (`• token: v`): a line that does not start like a field could be
 *   prose that names one;
 * - shell forms other than `NAME=v` and `export NAME=v`: PowerShell's `$env:TOKEN = "v"`,
 *   Windows' `setx TOKEN v` and bash's `TOKEN=$'v'` (where `$'` opens the value, so the value
 *   read is `$`), each a syntax of its own;
 * - YAML's doubled quote inside a single-quoted value (`token: 'it''s'`) ends the value at the
 *   first quote: what follows is shown;
 * - pydantic's union errors, which name the field with the union's member after it
 *   (`token.str`, `token.function-after[…]`), and an `input_value` written over several lines:
 *   neither the field nor the value's end is plain from a line;
 * - a TOML inline table (`creds = { token = "v" }`) and a curl `-H 'Cookie: …'` argument are not
 *   read, nor a cookie header whose value holds no `name=` pair;
 * - an object key is judged by isSecretName, not by the last words of its name: `{ my_token: v }`
 *   reads as before;
 * - pydantic's input is read only under the line that names its field; written on one line
 *   (`password String should … [type=…, input_value='v']`) the field is not plain;
 * - a var_dump value that is not a string (`int(1234)`);
 * - a JSON text without a single escape is not decoded, so a field inside one of its strings
 *   (`{"raw": "X-Api-Key: v"}`) is not at the start of a line and is not read: such a text is
 *   read only by the rules above;
 * - text decoded more than MAX_DECODINGS times, and entities other than `&lt;`, `&gt;`, `&amp;`,
 *   `&quot;`, `&apos;` and numeric ones;
 * - a cursor (`next_page_token`, `pageToken`) and an environment variable whose name ends in a
 *   bare "key" (`S3_KEY`, `IDEMPOTENCY_KEY`, `STRIPE_KEY`) are kept: most such names are not
 *   secrets, and a configured key is caught by its value (knownSecrets).
 */
function moreSecretSpans(text: string): Span[] {
  return maskableUnion(shapeSpans(text), decodedSpans(text));
}

/**
 * `pieces` with each of `spans` (in the text as it came, sorted by start) masked as
 * "[redacted]", together with any mask it overlaps: what was hidden stays hidden, and a mask
 * only grows.
 */
function maskSource(pieces: readonly Piece[], spans: readonly Span[]): Piece[] {
  return spans.length === 0 ? [...pieces] : hide(pieces, sourceHides(pieces, spans));
}

/**
 * `spans` of the text as it came (sorted by start) as hides behind "[redacted]" in the text that
 * `pieces` read as: each reaches to the ends of a mask it starts or ends inside.
 */
function sourceHides(pieces: readonly Piece[], spans: readonly Span[]): Hide[] {
  const hides: Hide[] = [];
  let index = 0;
  let at = 0;
  // Where the character at `offset` (or, for an end, just before it) is in the text as it reads.
  const position = (offset: number, end: boolean) => {
    for (let piece = pieces[index]; piece; piece = pieces[++index]) {
      if (end ? piece.to >= offset : piece.to > offset) break;
      at += pieceLength(piece);
    }
    const piece = pieces[index];
    if (!piece) return at;
    if (piece.mask !== undefined) return end ? at + piece.mask.length : at;
    return at + (offset - piece.from);
  };
  // An empty span hides nothing: where a mask already touches it, it is not written again.
  let maskEnds: Set<number> | undefined;
  for (const [start, end, mask] of spanHides(spans)) {
    if (start === end) {
      maskEnds ??= new Set(pieces.flatMap((p) => (p.mask === undefined ? [] : [p.from, p.to])));
      if (maskEnds.has(start)) continue;
    }
    hides.push([position(start, false), position(end, true), mask]);
  }
  return hides;
}

/**
 * Removes credentials from an error message or log line, then runs `steps` (scrubText's link,
 * e-mail and phone rules) after them:
 * - each quoted secret value (redactQuotedSecrets); in a text that mentions a header, every
 *   double-quoted value, since fetch echoes an invalid header value, which is the credential;
 *   then `redactSecrets`, then `steps`, each on the text as the rules before it left it;
 * - then each value of a secret key without quotes (unquotedKeySpans) and each secret value of the
 *   shapes moreSecretSpans reads, and in a text that mentions a header, each double-quoted value
 *   as the quotes pair once every secret value is gone (with and without moreSecretSpans). These
 *   are measured on the text as it came and masked with whatever they overlap, so they only add
 *   to what the other rules hide: a link or a `name=` value that reaches into one is still hidden
 *   whole, as it was before.
 *
 * The header rule pairs quotes without reading escapes. It is measured on the text as it came,
 * as it pairs quotes there, as it pairs them once the quoted secret values are gone, and as it
 * pairs them once every secret value is gone; what any of these hides is hidden, so a quote inside
 * a secret value cannot move a later pair and show what the rule hid before. Text without a secret
 * value reads as it always did.
 */
function redactKeyValues(
  text: string,
  steps: readonly HideStep[],
  extra: readonly Span[] = [],
): string {
  return render(text, keyValuePieces(text, steps, extra));
}

/**
 * The pieces of `text` as redactKeyValues masks them, with `more` (by default what
 * moreSecretSpans finds) as the values of the shapes it reads; with none, as the other rules
 * alone mask them (with `before` in place of `extra`). When `more` holds a value, or `extra` holds
 * more than `before` (the values of the shapes plainLine read on the lines a text had), what
 * follows is kept hidden too.
 *
 * A log line of the text is scrubbed once more by the logger's own rules (scrubbedSpans), which
 * read a key (`token: v`, `Bearer v`) or a whole configured value: a value masked here can take
 * that key, or part of that value. So when `more` holds a value, what those rules hide in the
 * text the other rules alone leave, and would no longer hide in this one, is masked here too
 * (lostToLog), until nothing is lost.
 */
function keyValuePieces(
  text: string,
  steps: readonly HideStep[],
  extra: readonly Span[],
  more: readonly Span[] = moreSecretSpans(text),
  before: readonly Span[] = extra,
): Piece[] {
  // The other rules alone: nothing to keep hidden beyond what they hide.
  if (more.length === 0 && sameSpans(extra, before)) return maskedPieces(text, steps, extra, more);
  const other = maskedPieces(text, steps, before, []);
  // A redacted text is often redacted again (a SourceError's message, then describeError): what
  // the other rules hide in the text they leave, once and twice more, stays hidden too.
  const again = redactedAgain(text, other);
  let added = again.length > 0 ? maskableUnion(extra, again) : extra;
  let pieces = maskedPieces(text, steps, added, more);
  const logged = loggedSpans(text, other);
  for (let round = 0; logged.length > 0 && round < MAX_LOG_ROUNDS; round++) {
    const lost = lostToLog(text, pieces, logged);
    if (lost.length === 0) break;
    added = maskableUnion(added, lost);
    pieces = maskedPieces(text, steps, added, more);
  }
  return pieces;
}

/** True when two lists of spans hold the same spans. */
const sameSpans = (a: readonly Span[], b: readonly Span[]) =>
  a === b ||
  (a.length === b.length && a.every(([start, end], i) => b[i]?.[0] === start && b[i]?.[1] === end));

/**
 * What the other rules hide when they redact once more the text their `pieces` leave of `text`,
 * and once more after that, in `text`: the redaction is not always the same the second time (a
 * quote the header rule paired can be gone).
 */
function redactedAgain(text: string, pieces: readonly Piece[]): Span[] {
  const once = render(text, pieces);
  const twice = maskedPieces(once, [], [], []);
  const thrice = maskedPieces(render(once, twice), [], [], []);
  return maskableUnion(sourceOf(pieces, twice), sourceSpans(pieces, sourceOf(twice, thrice)));
}

/** How many times keyValuePieces masks what a log line would lose, at most. */
const MAX_LOG_ROUNDS = 4;

/** What the logger's rules hide in a log line of the text that `pieces` cover, in that text. */
const loggedSpans = (text: string, pieces: readonly Piece[]) =>
  sourceSpans(pieces, scrubbedSpans(render(text, pieces)));

/**
 * The parts of `logged` (spans of `text`) that a log line of the text `pieces` cover would show:
 * neither masked there nor hidden by the logger's rules in it.
 */
function lostToLog(text: string, pieces: readonly Piece[], logged: readonly Span[]): Span[] {
  const hidden = new Uint8Array(text.length + 1);
  for (const piece of pieces) if (piece.mask !== undefined) hidden.fill(1, piece.from, piece.to);
  for (const [start, end] of loggedSpans(text, pieces)) hidden.fill(1, start, end);
  const lost: Span[] = [];
  for (const [start, end] of logged) {
    for (let i = start; i < end; i++) {
      if (hidden[i]) continue;
      const last = lost.at(-1);
      if (last && last[1] === i) last[1] = i + 1;
      else lost.push([i, i + 1]);
    }
  }
  return maskableUnion(lost, []);
}

/** keyValuePieces without what the logger's rules hide. */
function maskedPieces(
  text: string,
  steps: readonly HideStep[],
  extra: readonly Span[],
  more: readonly Span[],
): Piece[] {
  const quoted = quotedSecretSpans(text);
  const header = /header/i.test(text);
  const first = header
    ? mergeSpans(quoted, mergeSpans(doubleQuotedSpans(text), doubleQuotedSpans(text, quoted)))
    : quoted;
  const pieces = runSteps(
    text,
    [...secretSteps(), ...steps],
    hide(wholeText(text), spanHides(first)),
  );
  const unquoted = unquotedKeySpans(text);
  if (unquoted.length === 0 && more.length === 0 && extra.length === 0) return pieces;
  let values = header
    ? mergeSpans(unquoted, doubleQuotedSpans(text, maskableUnion(quoted, unquoted)))
    : unquoted;
  if (more.length > 0) {
    // The header rule's pairs as above are kept, and so are its pairs once these values are gone.
    const secrets = maskableUnion(quoted, maskableUnion(unquoted, more));
    values = mergeSpans(values, header ? mergeSpans(more, doubleQuotedSpans(text, secrets)) : more);
  }
  return maskSource(pieces, mergeSpans(values, extra));
}

/** Removes credentials from an error message or log line (redactKeyValues). */
export const redactText = (text: string) => redactKeyValues(text, []);

/** What the HTTP error log keeps of an error's message (logText in http/middleware/errors.ts). */
const MAX_LOGGED_MESSAGE = 200;
/**
 * Room for the words a log line puts before a described error, within MAX_LOGGED_TEXT. Every
 * caller's own words are bounded well under it: fixed words under 64 characters ("Error: ",
 * "Suggest failed: ", a search's fixed label, INTERNAL_ERROR_PREFIX), and agent/enricher.ts's
 * `Spotify search for "…" failed: `, whose graph-node label searchFailedPrefix cuts to 200
 * characters (under 250 in all).
 */
const LOG_PREFIX_ROOM = 1024;

/**
 * `text` redacted (redactText), for a log that cuts it to `max` characters, keeping `keep`. A
 * value moreSecretSpans masks can make the text shorter than the other rules leave it, so the
 * cut would fall further on: where they alone leave the text longer than `max`, it stops where
 * they would be cut, with "…", and the log never shows what that cut left out.
 */
function redactForLog(text: string, max: number, keep: number): string {
  const more = moreSecretSpans(text);
  const pieces = keyValuePieces(text, [], [], more);
  if (more.length === 0) return render(text, pieces);
  const shown = safeCut(text, pieces, keyValuePieces(text, [], [], []), max, keep);
  return shown < text.length
    ? `${render(text, piecesBefore(pieces, shown))}…`
    : render(text, pieces);
}

/**
 * Where a cut of the text that `pieces` cover falls when it keeps `keep` characters of a
 * rendering longer than `max` (cutAt): no further than the same cut of `other`, the other rules'
 * pieces, and never inside what the logger hides in the log line of either rendering, as the
 * logger itself cuts a text (logCut): there, at its start, since a part of one is no longer
 * known to it. The whole text when nothing is cut.
 */
function safeCut(
  text: string,
  pieces: readonly Piece[],
  other: readonly Piece[],
  max: number,
  keep: number,
): number {
  let at = Math.min(cutAt(pieces, max, keep), cutAt(other, max, keep));
  if (at >= text.length) return at;
  const renderings = [pieces, other].map((all) => ({ all, text: render(text, all) }));
  // Each rendering's cut moved by logCut, back in this text, until neither moves it.
  for (let moved = true; moved; ) {
    moved = false;
    for (const { all, text: rendered } of renderings) {
      const there = renderedAt(all, at);
      const cut = logCut(rendered, there);
      if (cut < there) {
        at = Math.min(at, sourceAt(all, cut));
        moved = true;
      }
    }
  }
  return at;
}

/** Where `at`, a place in the text that `pieces` cover, falls in the text they read as. */
function renderedAt(pieces: readonly Piece[], at: number): number {
  let out = 0;
  for (const piece of pieces) {
    if (piece.to <= at) out += pieceLength(piece);
    else {
      if (piece.mask === undefined && piece.from < at) out += at - piece.from;
      break;
    }
  }
  return out;
}

/**
 * Where `at`, a place in the text that `pieces` read as, falls in the text they cover: at a mask's
 * start when it falls inside one.
 */
function sourceAt(pieces: readonly Piece[], at: number): number {
  let start = 0;
  for (const piece of pieces) {
    const length = pieceLength(piece);
    if (at < start + length) return piece.mask === undefined ? piece.from + at - start : piece.from;
    start += length;
  }
  return pieces.at(-1)?.to ?? 0;
}

/** Ids the pipeline reads (MBIDs, Spotify ids, ISRCs) are never rewritten by a scrubber. */
const ID_SHAPED =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9A-Za-z]{22}|[A-Z]{2}[A-Z0-9]{3}\d{7})$/i;

const MEDIA_HOST =
  /(?:^|\.)(?:scdn\.co|dzcdn\.net|coverartarchive\.org|us\.archive\.org|lastfm\.freetls\.fastly\.net|mzstatic\.com|ytimg\.com|ggpht\.com)$/i;
const MEDIA_PATH =
  /\.(?:jpe?g|png|gif|webp|avif|svg|bmp|ico|heic|mp3|mp4|m4a|aac|ogg|oga|opus|flac|wav|webm|mov)$|\/images?(?:\/|$)/i;

/** True for a URL (absolute or protocol-relative) to an image, audio or video file or CDN. */
export function isMediaUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value.startsWith("//") ? `https:${value}` : value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return MEDIA_HOST.test(url.hostname) || MEDIA_PATH.test(url.pathname);
}

const URL_IN_TEXT = /(?:https?:)?\/\/[^\s"'<>()[\]{}]+/gi;
/** The characters of an e-mail address before "@". */
const EMAIL_LOCAL = /[\w.+-]+/g;
/** An e-mail address's domain, just after "@" (set lastIndex). */
const EMAIL_DOMAIN = /[\w-]+(?:\.[\w-]+)+/y;

/**
 * Each e-mail address: what /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g matched, in linear time. Every start
 * inside a run of local-part characters reaches the same "@", so the run is read once, not once
 * per character.
 */
const emailHides: HideStep = (text) => {
  const out: Hide[] = [];
  EMAIL_LOCAL.lastIndex = 0;
  for (let local = EMAIL_LOCAL.exec(text); local; local = EMAIL_LOCAL.exec(text)) {
    const at = local.index + local[0].length;
    if (text.charAt(at) !== "@") continue;
    EMAIL_DOMAIN.lastIndex = at + 1;
    const domain = EMAIL_DOMAIN.exec(text);
    if (!domain) continue;
    out.push([local.index, at + 1 + domain[0].length, "[email]"]);
    EMAIL_LOCAL.lastIndex = at + 1 + domain[0].length;
  }
  return out;
};

/** Each e-mail address (emailHides) as "[email]". */
export const withoutEmails = (text: string) => redactWith(text, [emailHides]);

/**
 * Where a phone number may start (not inside a longer token: a UUID's digit groups are not a
 * phone number) and the run of number characters after it. The number is read from the run by
 * replacePhoneLike.
 */
const PHONE_RUN = /(?<![\w-])\+?\(?\d[\d\s().-]*/g;

/**
 * Replaces each phone-like number: what /(?<![\w-])\+?\(?\d[\d\s().-]{7,}\d(?![\w-])/g matched,
 * in linear time. A number ends at the last digit of its run that no word character or "-"
 * follows, at least eight characters after its first digit; a run holds at most one number.
 */
export function replacePhoneLike(text: string, replace: (match: string) => string): string {
  return text.replace(PHONE_RUN, (run: string, offset: number) => {
    const end = phoneEnd(text, run, offset);
    return end === undefined ? run : replace(run.slice(0, end)) + run.slice(end);
  });
}

/** Where the phone-like number at the start of `run` (at `offset` in `text`) ends, if it holds one. */
function phoneEnd(text: string, run: string, offset: number): number | undefined {
  const first = run.search(/\d/);
  for (let end = run.length; end >= first + 9; end--) {
    if (/\d/.test(run.charAt(end - 1)) && !/[\w-]/.test(text.charAt(offset + end))) return end;
  }
  return undefined;
}

/** A phone-like number that is a phone number: 9 to 15 digits, and not a date. */
function isPhoneNumber(match: string): boolean {
  const digits = match.replace(/\D/g, "").length;
  const isDate = /^\d{4}-\d{2}-\d{2}/.test(match);
  return digits >= 9 && digits <= 15 && !isDate;
}

/** Each phone number (replacePhoneLike, isPhoneNumber). */
const phoneHides: HideStep = (text) =>
  hidesOf(
    text,
    PHONE_RUN,
    (run) => {
      const end = phoneEnd(text, run[0], run.index);
      return end !== undefined && isPhoneNumber(run[0].slice(0, end))
        ? [run.index, run.index + end]
        : undefined;
    },
    "[phone]",
  );

/** Each media URL. */
const mediaUrlHides: HideStep = (text) =>
  hidesOf(
    text,
    URL_IN_TEXT,
    (url) => (isMediaUrl(url[0]) ? [url.index, url.index + url[0].length] : undefined),
    "[media]",
  );

const withoutMediaUrls = (text: string) => redactWith(text, [mediaUrlHides]);

/** A URL whose slashes are JSON-escaped (`https:\/\/host\/path`), absolute or protocol-relative. */
const ESCAPED_URL_IN_TEXT = /(?:https?:)?\\\/\\\/[^\s"'<>()[\]{}]+/gi;

/**
 * Each media URL written with JSON-escaped slashes as "[media]", as withoutMediaUrls removes the
 * same URL written plainly: a signed preview link in a body that was not parsed.
 */
const escapedMediaUrlHides: HideStep = (text) =>
  hidesOf(
    text,
    ESCAPED_URL_IN_TEXT,
    (url) =>
      isMediaUrl(url[0].replaceAll("\\/", "/"))
        ? [url.index, url.index + url[0].length]
        : undefined,
    "[media]",
  );

export const withoutEscapedMediaUrls = (text: string) => redactWith(text, [escapedMediaUrlHides]);

/**
 * A string the pipeline reads, for a cassette: secrets redacted and media URLs removed, capped
 * well above what consumers read. Nothing else changes, so replay reproduces the recorded run;
 * id-shaped values are kept as they are.
 */
export function scrubReadText(text: string): string {
  if (ID_SHAPED.test(text)) return text;
  const out = withoutMediaUrls(redactSecrets(text));
  return out.length > MAX_TEXT ? out.slice(0, MAX_TEXT) : out;
}

/**
 * An error or text body for a cassette: secrets (quoted secret keys included), media URLs (also
 * written with JSON-escaped slashes), e-mails and phone numbers removed, capped. These bodies
 * only feed error handling and the debug log.
 */
export function scrubText(text: string): string {
  if (ID_SHAPED.test(text)) return text;
  const steps = [mediaUrlHides, escapedMediaUrlHides, emailHides, phoneHides];
  const more = moreSecretSpans(text);
  const pieces = keyValuePieces(text, steps, [], more);
  let out = render(text, pieces);
  if (more.length > 0 || out.length > MAX_ERROR_TEXT) {
    // A value moreSecretSpans masks can make the text shorter than the other rules leave it, or
    // longer: the cap falls no further than on their text, and never inside a host or a
    // configured value a log line hides whole (safeCut).
    const other = more.length > 0 ? keyValuePieces(text, steps, [], []) : pieces;
    const shown = safeCut(text, pieces, other, MAX_ERROR_TEXT, MAX_ERROR_TEXT);
    if (shown < text.length) out = render(text, piecesBefore(pieces, shown));
  }
  // Past the cut above, the cap only takes the characters of a mask the cut fell inside.
  return out.length > MAX_ERROR_TEXT ? out.slice(0, MAX_ERROR_TEXT) : out;
}

// =============================================================================
// Typed errors
// =============================================================================

export type SourceName =
  | "spotify"
  | "musicbrainz"
  | "listenbrainz"
  | "lastfm"
  | "deezer"
  | "discogs"
  | "secondhandsongs"
  | "genius"
  | "tavily"
  | "audio";

export type SourceErrorKind =
  /** The source is not configured (e.g. no API key); nothing was requested. */
  | "unavailable"
  /** The input was rejected before any request (e.g. a malformed id). */
  | "invalid_input"
  | "timeout"
  /** The caller's signal aborted the request. */
  | "aborted"
  /** DNS, connection or TLS failure. */
  | "network"
  /** 429, or the source's own "slow down" status; `retryAfterMs` when the source said. */
  | "rate_limited"
  /** Any other non-2xx status; `status` and `body` hold the answer. */
  | "http"
  /** A 2xx answer that is not JSON (e.g. an HTML bot challenge). */
  | "content_type"
  /** A JSON content type whose body does not parse, or a body of the wrong shape. */
  | "parse"
  /** Replay mode and the cassette has no entry for this request. */
  | "cassette_miss"
  /** A cassette could not be read, parsed or written. */
  | "cassette_io";

export class SourceError extends Error {
  override readonly name = "SourceError";
  readonly status?: number;
  readonly retryAfterMs?: number;
  /** The error body: parsed JSON, or text that was not parsed, scrubbed (scrubText) and capped. */
  readonly body?: unknown;

  constructor(
    readonly source: SourceName,
    readonly kind: SourceErrorKind,
    message: string,
    details: { status?: number; retryAfterMs?: number; body?: unknown; cause?: unknown } = {},
  ) {
    super(
      redactForLog(`${source}: ${message}`, MAX_LOGGED_MESSAGE, MAX_LOGGED_MESSAGE),
      details.cause === undefined ? {} : { cause: details.cause },
    );
    this.status = details.status;
    this.retryAfterMs = details.retryAfterMs;
    this.body = details.body;
  }
}

export function isSourceError(error: unknown, kind?: SourceErrorKind): error is SourceError {
  return error instanceof SourceError && (kind === undefined || error.kind === kind);
}

/**
 * One line for logs and tool results, with credentials redacted. A log line keeps
 * MAX_LOGGED_TEXT characters, its own words before the error included: past that, the line
 * stops where the other rules alone would leave it with LOG_PREFIX_ROOM to spare (redactForLog).
 */
export function describeError(error: unknown): string {
  return redactForLog(
    error instanceof Error ? error.message : String(error),
    MAX_LOGGED_TEXT - LOG_PREFIX_ROOM,
    MAX_LOGGED_TEXT - LOG_PREFIX_ROOM,
  );
}

// =============================================================================
// Configuration
// =============================================================================

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Identifies the app to the APIs that ask for it (MusicBrainz requires a name, version and
 * contact). Override with SOURCE_USER_AGENT (or MUSICBRAINZ_USER_AGENT).
 */
export function userAgent(): string {
  return (
    process.env.SOURCE_USER_AGENT ||
    process.env.MUSICBRAINZ_USER_AGENT ||
    "LinerNotes/0.1.0 ( https://github.com/josefdc/liner-notes )"
  );
}

function defaultTimeoutMs(): number {
  const value = Number(process.env.SOURCE_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

type CassetteMode = "off" | "record" | "replay";

function requestedMode(): CassetteMode {
  const mode = process.env.SOURCE_CASSETTE?.trim() ?? "";
  if (mode === "record" || mode === "replay") return mode;
  if (mode === "" || mode === "off") return "off";
  throw new Error(`SOURCE_CASSETTE: expected "record", "replay" or "off", got "${mode}"`);
}

/**
 * Throws on an unknown SOURCE_CASSETTE value, and when a cassette mode is set in production;
 * called at startup and on every request.
 */
export function assertCassetteAllowed(): void {
  const mode = requestedMode();
  if (mode !== "off" && process.env.NODE_ENV === "production") {
    throw new Error(
      `SOURCE_CASSETTE=${mode} is not allowed when NODE_ENV=production: cassettes are for tests ` +
        "and evals. Unset SOURCE_CASSETTE.",
    );
  }
}

let loggedMode: CassetteMode | null = null;

export function cassetteMode(): CassetteMode {
  assertCassetteAllowed();
  const mode = requestedMode();
  if (mode !== "off" && loggedMode !== mode) {
    loggedMode = mode;
    log.warn(
      `SOURCE_CASSETTE=${mode}: ${
        mode === "replay" ? "answers come from" : "answers are recorded to"
      } ${cassetteDir()}`,
    );
  }
  return mode;
}

// A cassette mode in production stops the server at startup, not at the first request.
assertCassetteAllowed();

function apiRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

/**
 * A credential from the environment. Under replay nothing is sent, so a missing credential is
 * a placeholder and the cassette decides the answer. In any other mode a missing credential
 * stays missing.
 */
export function credential(name: string): string | undefined {
  const value = process.env[name];
  if (value) return value;
  return requestedMode() === "replay" && cassetteMode() === "replay" ? "replay" : undefined;
}

export function cassetteDir(): string {
  return process.env.SOURCE_CASSETTE_DIR || join(apiRoot(), "cassettes");
}

// =============================================================================
// Scrubbing
// =============================================================================

/**
 * Which fields of a payload to keep: `true` keeps the value, an object keeps the listed keys,
 * `[shape]` applies the shape to each item. A single object where a list is expected (Last.fm
 * sends one tag as an object) is kept as an object, so replay sees what the API sent.
 */
export type Shape = true | { readonly [key: string]: Shape } | readonly [Shape];

export function pick(value: unknown, shape: Shape): unknown {
  if (shape === true || value === null || typeof value !== "object") return value;
  if (Array.isArray(shape)) {
    const item = shape[0];
    return Array.isArray(value) ? value.map((v) => pick(v, item)) : pick(value, item);
  }
  if (Array.isArray(value)) return value.map((v) => pick(v, shape));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(shape as Record<string, Shape>)) {
    if (key in value) out[key] = pick((value as Record<string, unknown>)[key], inner);
  }
  return out;
}

const MEDIA_KEY =
  /^(?:preview|images?|picture|cover|thumbnail|artwork|favicon|avatar)(?:[_-]?\w*)$/i;

function scrubWith(text: (value: string) => string) {
  const scrub = (value: unknown): unknown => {
    if (typeof value === "string") return isMediaUrl(value.trim()) ? null : text(value);
    if (Array.isArray(value)) return value.map(scrub);
    if (value === null || typeof value !== "object") return value;
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      if (MEDIA_KEY.test(key)) continue;
      out[key] = isSecretKey(key) ? "[redacted]" : scrub(inner);
    }
    return out;
  };
  return scrub;
}

/**
 * Data the pipeline reads (a successful answer, already cut to its shape): drops preview and
 * image fields and media URLs and redacts secrets (by key and by value). Values are otherwise
 * kept byte for byte, so a replayed run matches the recorded one.
 */
export const scrubReadPayload = scrubWith(scrubReadText);

/**
 * An error body: as scrubReadPayload, and also masks e-mails and phone numbers and caps text.
 */
export const scrubPayload = scrubWith(scrubText);

const SECRET_PARAMS = new Set([
  "api_key",
  "apikey",
  "key",
  "token",
  "access_token",
  "client_secret",
  "secret",
  "password",
]);

/**
 * The cassette key: method, URL without credentials (secret parameters in any case, user info)
 * and a digest of the body, so two POSTs to one URL with different bodies are different entries.
 */
export function cassetteKey(method: string, url: string, body?: string): string {
  const parsed = new URL(url);
  parsed.username = "";
  parsed.password = "";
  for (const name of [...parsed.searchParams.keys()]) {
    if (SECRET_PARAMS.has(name.toLowerCase())) parsed.searchParams.delete(name);
  }
  parsed.searchParams.sort();
  const digest = body ? ` #${createHash("sha256").update(body).digest("hex").slice(0, 16)}` : "";
  return `${method} ${parsed.href}${digest}`;
}

// =============================================================================
// Cassettes
// =============================================================================

/** A response as it is recorded: exactly one of `json` and `text`. */
interface Recorded {
  status: number;
  contentType: string;
  retryAfterMs?: number;
  json?: unknown;
  text?: string;
  /** The size in bytes of a JSON error body over MAX_ERROR_JSON, which is not kept. */
  tooLarge?: number;
}

interface Cassette {
  version: 1;
  entries: Record<string, Recorded>;
}

function cassettePath(source: SourceName): string {
  return join(cassetteDir(), `${source}.json`);
}

function parseCassette(source: SourceName, text: string): Cassette {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new SourceError(source, "cassette_io", `cassette is not valid JSON`, { cause: error });
  }
  const entries = (data as { entries?: unknown })?.entries;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    throw new SourceError(source, "cassette_io", "cassette has no entries object");
  }
  return { version: 1, entries: entries as Record<string, Recorded> };
}

function readCassette(source: SourceName): Cassette {
  const path = cassettePath(source);
  let text: string;
  try {
    if (!existsSync(path)) return { version: 1, entries: {} };
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new SourceError(source, "cassette_io", `cannot read cassette: ${describeError(error)}`);
  }
  return parseCassette(source, text);
}

const LOCK_WAIT_MS = 5000;
let lockWaitMs = LOCK_WAIT_MS;
const LOCK_STALE_MS = 30_000;
let tmpCounter = 0;

/** False when no process has this pid (a recorder that crashed while holding the lock). */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * A lock file shared with other recording processes, holding the owner's pid; returns the
 * release function. A lock whose owner is no longer alive, or older than 30 s, is broken.
 */
async function acquireLock(path: string): Promise<() => Promise<void>> {
  const lock = `${path}.lock`;
  // The wait is measured on the monotonic clock, so a step of the wall clock neither cuts it
  // short nor drags it out. The lock's age is read from its mtime, so on the wall clock.
  const deadline = pacingClock() + lockWaitMs;
  for (;;) {
    try {
      const handle = await open(lock, "wx");
      try {
        await handle.writeFile(String(process.pid));
      } finally {
        await handle.close();
      }
      return () => unlink(lock).catch(() => {});
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = Number(await readFile(lock, "utf8").catch(() => ""));
      const age = await stat(lock).then(
        (s) => Date.now() - s.mtimeMs,
        () => 0,
      );
      const dead = Number.isSafeInteger(owner) && owner > 0 && !processAlive(owner);
      if (dead || age > LOCK_STALE_MS) {
        // Only if it is still the same lock: another recorder may have broken it and taken it.
        const again = Number(await readFile(lock, "utf8").catch(() => ""));
        if (again === owner) await unlink(lock).catch(() => {});
        continue;
      }
      if (pacingClock() > deadline) throw new Error(`cassette lock ${lock} is held`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

/** Tests only: shortens the wait for a held cassette lock; returns a restore function. */
export function setCassetteLockWaitForTests(ms: number): () => void {
  const previous = lockWaitMs;
  lockWaitMs = ms;
  return () => {
    lockWaitMs = previous;
  };
}

/** Adds one entry: under the lock, re-reads the file and replaces it atomically (temp + rename). */
async function writeEntry(source: SourceName, key: string, entry: Recorded): Promise<void> {
  const path = cassettePath(source);
  try {
    await mkdir(dirname(path), { recursive: true });
    const release = await acquireLock(path);
    try {
      const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      const cassette: Cassette =
        text === null ? { version: 1, entries: {} } : parseCassette(source, text);
      cassette.entries[key] = entry;
      const sorted = Object.fromEntries(
        Object.entries(cassette.entries).sort(([a], [b]) => a.localeCompare(b)),
      );
      // A partial write (full disk, crash) leaves the previous cassette intact.
      const tmp = `${path}.${process.pid}.${++tmpCounter}.tmp`;
      try {
        await writeFile(tmp, `${JSON.stringify({ version: 1, entries: sorted }, null, 2)}\n`);
        await rename(tmp, path);
      } catch (error) {
        await unlink(tmp).catch(() => {});
        throw error;
      }
    } finally {
      await release();
    }
  } catch (error) {
    if (isSourceError(error)) throw error;
    throw new SourceError(source, "cassette_io", `cannot write cassette: ${describeError(error)}`);
  }
}

// Writes from this process run one at a time; the lock file orders them with other processes.
let writeQueue: Promise<unknown> = Promise.resolve();

let lostRecordings = 0;

/** Counts an answer that could not be recorded; the count is reported once when the process exits. */
function recordingLost(): void {
  if (lostRecordings++ === 0) {
    process.once("exit", () => {
      log.warn(
        `SOURCE_CASSETTE=record: ${lostRecordings} answer(s) could not be recorded; ` +
          `the cassettes in ${cassetteDir()} are incomplete. Record again.`,
      );
    });
  }
}

function queueWrite(source: SourceName, key: string, entry: Recorded): Promise<void> {
  const next = writeQueue.then(() => writeEntry(source, key, entry));
  writeQueue = next.catch(() => {});
  return next;
}

// =============================================================================
// Requests
// =============================================================================

export interface SourceRequest {
  source: SourceName;
  url: string | URL;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Statuses that mean "slow down" (429 always; MusicBrainz also answers 503). */
  rateLimitStatuses?: readonly number[];
  /** The fields the pipeline reads, kept when a successful answer is recorded. */
  scrub?: Shape;
  /**
   * What a successful JSON answer is recorded as, before `scrub`: the source's own filter, so a
   * cassette keeps nothing the source would drop. Replaying it must give what the live answer
   * gave.
   */
  recordAs?: (json: unknown) => unknown;
  /** false: never recorded or replayed (local services). */
  cassette?: boolean;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  // A date in the past, or one that does not parse, says nothing: the caller's default applies.
  const date = Date.parse(value);
  return Number.isNaN(date) || date <= Date.now() ? undefined : date - Date.now();
}

const isJsonType = (contentType: string) => /\bjson\b/i.test(contentType);

/** Markup, also escaped as entities, once or more ("&lt;", "&#60;", "&#x3c;", "&amp;lt;"). */
export const MARKUP = /[<>]|&(?:amp;)*(?:lt|gt|#0*6[02]|#x0*3[ce]);/i;
/** A Python traceback. */
const PYTHON_TRACE = /Traceback \(most recent call last\)|File "[^"]+", line \d+/;

/** A word with a path, a line and a column: "/", "\" or "." somewhere before ":10:5". */
function isFrameLocation(word: string | undefined): boolean {
  const separator = word?.search(/[/\\.]/) ?? -1;
  return separator !== -1 && /:\d+:\d/.test(word?.slice(separator + 1) ?? "");
}

/**
 * True for a stack trace: a JavaScript frame ("at fn (/path/file.js:10:5)", with a path, so
 * "at 10:30:00" is not one) or a Python traceback. The frame is what
 * /\bat\s+(?:\S+\s+\()?\S*[/\\.]\S*:\d+:\d+/ matched, read word by word: that expression took
 * quadratic time on a long error body, and this runs in linear time.
 */
export function hasStackTrace(text: string): boolean {
  if (PYTHON_TRACE.test(text)) return true;
  const words = text.split(/\s+/);
  for (let i = 0; i + 1 < words.length; i++) {
    const word = words[i] ?? "";
    // "at" as a word of its own, or after a character that is not a word character ("(at").
    if (!word.endsWith("at") || /\w/.test(word.charAt(word.length - 3))) continue;
    const after = words[i + 2];
    if (isFrameLocation(words[i + 1]) || (after?.startsWith("(") && isFrameLocation(after))) {
      return true;
    }
  }
  return false;
}
/** A signature or token parameter, also in a link written without a scheme. */
const SIGNED_PARAM = /(?:^|[?&;~\s])(?:sig|signature|token|hdnts|hdnea)=|X-Amz-/i;

/**
 * Why a line is not one an error message keeps, or null: markup (an HTML page in a JSON field,
 * also entity-escaped), a stack trace, a signature or token parameter (a link without a scheme
 * can carry one), or a link (plainMessage writes "[link]" in its place). The readers of stored
 * results refuse a source error whose message has one (heldTextIssue).
 */
export function reasonIssue(text: string): string | null {
  if (MARKUP.test(text)) return "markup";
  if (hasStackTrace(text)) return "a stack trace";
  if (SIGNED_PARAM.test(text)) return "a signature or token parameter";
  if (text.search(URL_IN_TEXT) !== -1) return "a link";
  return null;
}

/**
 * A message as one line, as steps (so where each character came from is known): whitespace runs
 * become one space, the line is trimmed, and links become "[link]".
 */
const LINE_STEPS: HideStep[] = [
  (text) => hidesOf(text, /\s+/g, (m) => [m.index, m.index + m[0].length], " "),
  (text) => {
    const ends: Hide[] = [];
    if (text.startsWith(" ")) ends.push([0, 1, ""]);
    if (text.length > 1 && text.endsWith(" ")) ends.push([text.length - 1, text.length, ""]);
    return ends;
  },
  (text) => hidesOf(text, URL_IN_TEXT, (m) => [m.index, m.index + m[0].length], "[link]"),
];

/**
 * A message as one line of plain text, cut to MAX_DETAIL when `cut`; undefined when the line is
 * empty or has an issue (reasonIssue).
 *
 * The line is made as it always was: whitespace runs become one space, links become "[link]",
 * then the cut; whether it is kept is decided on that line, as before. It is then redacted
 * (redactText), so a rule that reads across what was a line break (`Bearer` at the end of one
 * line, its token on the next) reads it as it did on that line. Last, each value of a header line
 * (headerLineSpans) and each value moreSecretSpans finds, read on the lines the text had, is
 * masked where it lies in the line; it only adds to what is hidden. A line whose masks make it
 * longer is cut again; one that the masks of moreSecretSpans make shorter still stops where the
 * other rules alone would have cut it (cutAt). When moreSecretSpans finds a value, the line the
 * other rules alone leave is also redacted once more, as a message made from it is, and what that
 * hides stays hidden; and a line they leave with an issue is left out.
 *
 * A second check leaves out a line whose redacted form has an issue: a mask can make one (the
 * header rule turns `File "", line 4` into a stack trace). Such a line was kept before, and the
 * message made from it then held the issue, which the readers of stored results refuse.
 *
 * Last, when the cut splits a configured value, a link or a host (lineCut), whose part no rule
 * knows, the line stops at its start; what the line hid before it stays hidden.
 */
function plainLine(text: string, cut: boolean): string | undefined {
  const pieces = runSteps(text, LINE_STEPS);
  const line = render(text, pieces);
  if (!line || reasonIssue(line) !== null) return undefined;
  const short = cut && line.length > MAX_DETAIL ? `${line.slice(0, MAX_DETAIL - 1)}…` : line;
  const kept = short === line ? line.length : MAX_DETAIL - 1;
  // The values of the lines the text had, where they lie in the line, up to the cut.
  const inLine = (spans: readonly Span[]) => {
    const out: Span[] = [];
    for (const [start, end] of sourceHides(pieces, spans)) {
      if (start < kept) out.push([start, Math.min(end, kept)]);
    }
    return out;
  };
  const lineValues = headerLineSpans(text);
  const more = moreSecretSpans(text);
  const headerValues = inLine(more.length > 0 ? maskableUnion(lineValues, more) : lineValues);
  const lineOnly = inLine(lineValues);
  // keyValuePieces also keeps hidden what the other rules hide when an error message made from
  // the line is redacted again (redactedAgain).
  const masked = keyValuePieces(short, [], headerValues, undefined, lineOnly);
  let redacted = render(short, masked);
  let stop = short.length;
  const shapes = more.length + moreSecretSpans(short).length > 0;
  if (shapes || (cut && redacted.length > MAX_DETAIL)) {
    const before = shapes ? keyValuePieces(short, [], lineOnly, []) : masked;
    const old = render(short, before);
    // A value moreSecretSpans masks can make the line shorter than the other rules leave it, and
    // a mask longer than what it hides makes it longer: it stops no further than the other rules
    // alone cut it, and never inside a host or a configured value a log line hides whole
    // (safeCut), so the last cut below only takes a mask's own characters.
    const shown = cut ? safeCut(short, masked, before, MAX_DETAIL, MAX_DETAIL - 1) : short.length;
    if (shown < short.length) {
      redacted = `${render(short, piecesBefore(masked, shown))}…`;
      stop = shown;
    }
    // A mask can also hide what makes a line one with an issue (`File "[redacted]", line 4`):
    // a line the other rules alone leave with one is left out, as it was.
    const oldLine = cut && old.length > MAX_DETAIL ? `${old.slice(0, MAX_DETAIL - 1)}…` : old;
    if (reasonIssue(oldLine) !== null) return undefined;
  }
  const out =
    cut && redacted.length > MAX_DETAIL ? `${redacted.slice(0, MAX_DETAIL - 1)}…` : redacted;
  if (reasonIssue(out) !== null) return undefined;
  // A configured value, a link, a host or an Authorization credential the cut splits is left
  // out from its start (lineCut);
  // the line is redacted as it was cut, so what it hides before that stays hidden.
  const end = kept < line.length ? lineCut(line, kept) : kept;
  if (end >= Math.min(stop, kept)) return out;
  const shorter = render(short, piecesBefore(masked, end));
  const cutAgain = `${shorter.length > MAX_DETAIL - 1 ? shorter.slice(0, MAX_DETAIL - 1) : shorter}…`;
  return reasonIssue(cutAgain) === null ? cutAgain : undefined;
}

/**
 * Where a line's cut to `at` characters falls: there, or at the start of a configured value
 * (knownSecrets), of what a log line replaces whole (a link, a host) or of an Authorization
 * credential (logCut) that it would split. A part of one is no longer known to the rules that
 * hide it, or too short for them; a secret pair or header value cut is still masked up to the
 * cut.
 */
function lineCut(line: string, at: number): number {
  const values = knownSecrets().flatMap((secret) =>
    secretHides(line.slice(0, at + secret.length), secret).map(
      ([start, end]): Span => [start, end],
    ),
  );
  return logCut(line, at, values, { pairs: false });
}

/**
 * How much of the text that `pieces` cover a cut to `max` characters shows (the cut keeps `keep`
 * characters when the text is longer; a line keeps MAX_DETAIL - 1 and its "…"): up to the first
 * character it cuts, or past a mask the cut falls inside, whose characters it hides. The whole
 * text when nothing is cut.
 */
function cutAt(pieces: readonly Piece[], max = MAX_DETAIL, keep = MAX_DETAIL - 1): number {
  const length = pieces.reduce((sum, piece) => sum + pieceLength(piece), 0);
  if (length <= max) return pieces.at(-1)?.to ?? 0;
  let at = 0;
  for (const piece of pieces) {
    const next = at + pieceLength(piece);
    if (next > keep) {
      return piece.mask === undefined ? piece.from + (keep - at) : piece.to;
    }
    at = next;
  }
  return pieces.at(-1)?.to ?? 0;
}

/**
 * Where, in the text that `pieces` cover, lies each mask of `again` (pieces of the text `pieces`
 * read as): a kept character is where it was; one of a mask stands for all the mask hides.
 */
function sourceOf(pieces: readonly Piece[], again: readonly Piece[]): Span[] {
  const spans: Span[] = [];
  for (const piece of again) {
    if (piece.mask !== undefined && piece.to > piece.from) spans.push([piece.from, piece.to]);
  }
  return sourceSpans(pieces, spans);
}

/**
 * Where, in the text that `pieces` cover, lies each of `spans` (of the text they read as, sorted
 * by start): a kept character is where it was; one of a mask stands for all the mask hides.
 */
function sourceSpans(pieces: readonly Piece[], spans: readonly Span[]): Span[] {
  if (spans.length === 0) return [];
  // Where each piece starts in the text they read as.
  const starts: number[] = [];
  let length = 0;
  for (const piece of pieces) {
    starts.push(length);
    length += pieceLength(piece);
  }
  // The last piece that starts at or before `at`, a character of the text they read as.
  const pieceAt = (at: number) => {
    let low = 0;
    let high = pieces.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if ((starts[middle] ?? 0) <= at) low = middle;
      else high = middle - 1;
    }
    return low;
  };
  const from = (at: number) => {
    if (at < 0 || at >= length) return 0;
    const i = pieceAt(at);
    const piece = pieces[i] as Piece;
    return piece.mask === undefined ? piece.from + at - (starts[i] ?? 0) : piece.from;
  };
  const to = (at: number) => {
    if (at < 0 || at >= length) return 0;
    const i = pieceAt(at);
    const piece = pieces[i] as Piece;
    return piece.mask === undefined ? piece.from + at - (starts[i] ?? 0) + 1 : piece.to;
  };
  const out: Span[] = [];
  for (const [start, end] of spans) out.push([from(start), to(end - 1)]);
  return maskableUnion(out, []);
}

/** `pieces` that start before `end` in the text as it came, a kept one cut there. */
function piecesBefore(pieces: readonly Piece[], end: number): Piece[] {
  const out: Piece[] = [];
  for (const piece of pieces) {
    if (piece.from >= end) break;
    out.push(piece.mask === undefined && piece.to > end ? { from: piece.from, to: end } : piece);
  }
  return out;
}

/**
 * An error message as one line of plain text (plainLine): whitespace runs become one space, links
 * become "[link]", credentials are redacted; undefined when it is empty or has an issue
 * (reasonIssue: markup, a stack trace, a signature or token parameter). What it returns never has
 * one.
 */
export const plainMessage = (text: string): string | undefined => plainLine(text, false);

/**
 * A source's own reason for an error, as a short line of plain text (plainLine), cut to
 * MAX_DETAIL: undefined when it is not a string, is empty, or holds markup, a stack trace or a
 * signature or token parameter. Error messages are stored with the result and sent to the
 * client, so a page never reaches them.
 */
export function plainReason(text: unknown): string | undefined {
  return typeof text === "string" ? plainLine(text, true) : undefined;
}

/** What an error status says, in words, for an answer that gave no plain-text reason. */
function statusReason(status: number): string | undefined {
  if (status === 401 || status === 403) return "the source refused the request";
  if (status === 404) return "not found";
  if (status === 400 || status === 422) return "the source rejected the request";
  if (status >= 500) return "the source could not answer";
  return undefined;
}

/**
 * A short human-readable detail from a JSON error body (Last.fm, Tavily, FastAPI, Spotify), as
 * plain text. A text body (an HTML error page, a bot challenge) gives none: it is logged at
 * debug level only.
 */
function errorDetail(body: unknown): string | undefined {
  if (typeof body === "string") return plainReason(body);
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  const nested = (v: unknown) =>
    v && typeof v === "object" ? (v as Record<string, unknown>).message : undefined;
  const detail = b.detail;
  const candidates = [
    b.message,
    nested(b.error),
    typeof b.error === "string" ? b.error : undefined,
    b.error_description,
    typeof detail === "string" ? detail : nested(detail),
    detail && typeof detail === "object" ? (detail as Record<string, unknown>).error : undefined,
  ];
  return candidates.map(plainReason).find((reason) => reason !== undefined);
}

/** Headers that carry a credential: such a request never follows a redirect off its origin. */
const CREDENTIAL_HEADERS = new Set(["authorization", "proxy-authorization", "x-api-key", "cookie"]);
const MAX_REDIRECTS = 5;
/** Headers that describe a request body; dropped when a redirect turns the request into a GET. */
const BODY_HEADERS = new Set([
  "content-type",
  "content-length",
  "content-encoding",
  "content-language",
  "content-location",
]);

/**
 * Fetches `url`. A request that carries a credential follows redirects itself, and only within
 * its own origin: fetch drops Authorization on a cross-origin redirect but forwards other
 * headers (an X-API-Key), and a downgrade to http would send it in clear. As fetch does, a 303,
 * or a 301/302 answer to a POST, is followed as a GET without the body. The body of every
 * redirect answer is discarded, so its connection is released.
 */
async function fetchWithin(req: SourceRequest, url: string, init: RequestInit): Promise<Response> {
  const credentialed = Object.keys(req.headers ?? {}).some((name) =>
    CREDENTIAL_HEADERS.has(name.toLowerCase()),
  );
  if (!credentialed) return fetch(url, init);
  let current = new URL(url);
  let request: RequestInit = { ...init, redirect: "manual" };
  for (let hop = 0; ; hop++) {
    const response = await fetch(current, request);
    const location = response.headers.get("location");
    if (response.status < 300 || response.status > 399 || !location) return response;
    await response.body?.cancel().catch(() => {});
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new SourceError(
        req.source,
        "parse",
        `HTTP ${response.status} redirect to a Location that is not a URL`,
        { status: response.status },
      );
    }
    if (next.origin !== current.origin) {
      throw new SourceError(
        req.source,
        "http",
        `HTTP ${response.status} redirect to ${next.origin} refused: the request carries a credential`,
        { status: response.status },
      );
    }
    if (hop >= MAX_REDIRECTS) {
      throw new SourceError(req.source, "http", "too many redirects", { status: response.status });
    }
    const method = (request.method ?? "GET").toUpperCase();
    if (
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) && method === "POST")
    ) {
      const headers = Object.fromEntries(
        Object.entries((request.headers ?? {}) as Record<string, string>).filter(
          ([name]) => !BODY_HEADERS.has(name.toLowerCase()),
        ),
      );
      request = {
        ...request,
        method: method === "HEAD" ? "HEAD" : "GET",
        body: undefined,
        headers,
      };
    }
    current = next;
  }
}

/**
 * The error for a request stopped by its signal: "timeout" when the signal was a deadline
 * (AbortSignal.timeout), "aborted" when the caller cancelled it.
 */
export function abortError(source: SourceName, signal: AbortSignal, cause?: unknown): SourceError {
  const reason = signal.reason as { name?: string } | undefined;
  return reason?.name === "TimeoutError"
    ? new SourceError(source, "timeout", "deadline reached", { cause })
    : new SourceError(source, "aborted", "request aborted", { cause });
}

async function fetchLive(req: SourceRequest, url: string, method: string): Promise<Recorded> {
  const timeoutMs = req.timeoutMs ?? defaultTimeoutMs();
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
  try {
    const response = await fetchWithin(req, url, {
      method,
      headers: { "User-Agent": userAgent(), ...req.headers },
      body: req.body,
      signal,
    });
    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text();
    const recorded: Recorded = { status: response.status, contentType };
    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
    if (retryAfterMs !== undefined) recorded.retryAfterMs = retryAfterMs;
    const ok = response.status >= 200 && response.status <= 299;
    if (isJsonType(contentType) && !ok) {
      const bytes = Buffer.byteLength(text);
      if (bytes > MAX_ERROR_JSON) {
        recorded.tooLarge = bytes;
        return recorded;
      }
    }
    if (isJsonType(contentType)) {
      try {
        recorded.json = JSON.parse(text);
        return recorded;
      } catch {
        // Falls through: kept as text, reported as a parse error.
      }
    }
    // A body that is not parsed is kept scrubbed from here on: the error's body, the debug log
    // and the cassette all hold this text, so a replay gives the same error.
    recorded.text = scrubText(text.slice(0, MAX_TEXT * 4));
    return recorded;
  } catch (error) {
    if (isSourceError(error)) throw error;
    if (req.signal?.aborted) throw abortError(req.source, req.signal, error);
    if (timeout.aborted) {
      throw new SourceError(req.source, "timeout", `no answer within ${timeoutMs} ms`, {
        cause: error,
      });
    }
    // No cause: a fetch error can echo a header value, which may be a credential.
    throw new SourceError(req.source, "network", describeError(error));
  }
}

/** Turns a live or replayed answer into data or a typed error. */
function interpret<T>(req: SourceRequest, answer: Recorded): T {
  const { source } = req;
  const body = answer.json !== undefined ? answer.json : answer.text;
  const ok = answer.status >= 200 && answer.status <= 299;
  if (answer.tooLarge !== undefined) {
    // Only its size: a body this large was never read.
    log.debug(
      `${source} answered HTTP ${answer.status} with a JSON body too large to read ` +
        `(${answer.tooLarge} bytes, over ${MAX_ERROR_JSON} bytes)`,
    );
  } else if (answer.json === undefined && answer.text) {
    // An answer that is not JSON is an error; its text (an error page, a bot challenge) goes to
    // the debug log only, never into the error message.
    log.debug(`${source} answered HTTP ${answer.status} with a body that is not JSON`, {
      answerText: scrubText(answer.text),
    });
  }
  const detail = answer.json !== undefined ? errorDetail(answer.json) : undefined;
  const why = statusReason(answer.status);
  const reason = detail ? ` — ${detail}` : why ? ` (${why})` : "";
  const rateLimits = req.rateLimitStatuses ?? [429];
  if (rateLimits.includes(answer.status) || answer.status === 429) {
    const after = answer.retryAfterMs;
    const wait = after === undefined ? "" : `; retry after ${Math.ceil(after / 1000)} s`;
    throw new SourceError(source, "rate_limited", `rate limited (HTTP ${answer.status})${wait}`, {
      status: answer.status,
      retryAfterMs: after,
      body,
    });
  }
  if (!ok) {
    throw new SourceError(source, "http", `HTTP ${answer.status}${reason}`, {
      status: answer.status,
      body,
    });
  }
  if (!isJsonType(answer.contentType)) {
    const got = plainReason(answer.contentType.slice(0, 80)) ?? "no content type";
    throw new SourceError(source, "content_type", `expected JSON, got ${got}`, {
      status: answer.status,
      body: answer.text,
    });
  }
  if (answer.json === undefined) {
    throw new SourceError(source, "parse", "response body is not valid JSON", {
      status: answer.status,
      body: answer.text,
    });
  }
  return answer.json as T;
}

/**
 * The answer as it is written to a cassette: filtered by the source (`recordAs`) and picked (2xx
 * JSON), scrubbed, capped.
 */
function forCassette(req: SourceRequest, answer: Recorded): Recorded {
  const entry: Recorded = { status: answer.status, contentType: answer.contentType };
  if (answer.retryAfterMs !== undefined) entry.retryAfterMs = answer.retryAfterMs;
  const ok = answer.status >= 200 && answer.status <= 299;
  if (answer.tooLarge !== undefined) {
    // Its size only: the body was never read.
    entry.tooLarge = answer.tooLarge;
  } else if (answer.json !== undefined) {
    const kept = ok && req.recordAs ? req.recordAs(answer.json) : answer.json;
    entry.json = ok
      ? scrubReadPayload(req.scrub ? pick(kept, req.scrub) : kept)
      : scrubPayload(answer.json);
  } else {
    // Scrubbed when it was read (fetchLive), so the replayed error is the recorded one.
    entry.text = answer.text ?? "";
  }
  return entry;
}

/**
 * Requests JSON from a source. Resolves with the parsed body of a 2xx JSON answer; anything
 * else rejects with a SourceError.
 */
export async function fetchJson<T>(req: SourceRequest): Promise<T> {
  const url = String(req.url);
  const method = req.method ?? "GET";
  const mode = req.cassette === false ? "off" : cassetteMode();
  const key = mode === "off" ? "" : cassetteKey(method, url, req.body);

  if (mode === "replay") {
    const entry = readCassette(req.source).entries[key];
    if (!entry) {
      throw new SourceError(req.source, "cassette_miss", `no cassette entry for ${key}`);
    }
    return interpret<T>(req, entry);
  }

  const answer = await fetchLive(req, url, method);

  if (mode === "record") {
    try {
      await queueWrite(req.source, key, forCassette(req, answer));
    } catch (error) {
      // The live answer is still good; only the recording is lost.
      log.error(`${describeError(error)}`);
      recordingLost();
    }
  }

  return interpret<T>(req, answer);
}

// =============================================================================
// Paced requests
// =============================================================================

/** The longest wait honoured from a source's Retry-After before the one retry. */
export const MAX_RETRY_WAIT_MS = 5000;
/** The wait before the one retry when the source said "slow down" without a Retry-After. */
const DEFAULT_RETRY_WAIT_MS = 2000;

/** Waits `ms`, or rejects with the signal's reason as soon as it aborts. */
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Options of a paced request. */
export interface PacedOptions {
  /** On `pacingClock`: the latest the request may start (the caller's deadline, less a margin). */
  notAfter?: number;
}

/**
 * `fetchJson` through the source's pacer (sources/pacing.ts). A request the pacer refuses (its
 * slot is too far away, or later than `notAfter`) rejects with the pacer's PaceRefused and is
 * never sent ("pace"); so does one whose deadline (a TimeoutError abort of `req.signal`) had
 * passed before it was made or came while it waited for its slot ("deadline"). The caller reports such a source as not asked, never as a timeout.
 *
 * When the source answers "slow down" (429), its requests are held for its Retry-After (2 s when
 * it sends none or a date in the past; at most MAX_HOLD_MS) and the request is retried once
 * after it, when that is at most MAX_RETRY_WAIT_MS and still before `notAfter`; otherwise, or
 * on a second "slow down", the source's `rate_limited` error is the answer. A refusal of the
 * pacer is never retried. A replayed request is not paced: nothing reaches the source.
 */
export async function pacedFetchJson<T>(
  pacer: RequestPacer,
  req: SourceRequest,
  options: PacedOptions = {},
): Promise<T> {
  if (req.cassette !== false && cassetteMode() === "replay") return fetchJson<T>(req);
  const { signal } = req;
  const { notAfter } = options;
  const stopped = (error: unknown) =>
    signal?.aborted && !isSourceError(error) ? abortError(req.source, signal, error) : error;
  const deadlinePassed = () =>
    signal?.aborted === true && (signal.reason as { name?: string })?.name === "TimeoutError";
  const slot = async () => {
    try {
      await pacer.slot({ signal, notAfter });
    } catch (error) {
      if (error instanceof PaceRefused) throw error;
      // The caller's deadline had passed before the request was made, or came while it waited
      // for its slot (the pacer refuses a slot past `notAfter`, so the time went elsewhere):
      // the run's time ran out, and the request is not sent.
      if (deadlinePassed()) {
        throw new PaceRefused(
          0,
          `the deadline came before the ${pacer.name} request could start`,
          "deadline",
        );
      }
      throw stopped(error);
    }
  };
  await slot();
  try {
    return await fetchJson<T>(req);
  } catch (error) {
    // Only the source's own "slow down" answer is retried.
    if (signal?.aborted || !isSourceError(error, "rate_limited")) throw stopped(error);
    const after = error.retryAfterMs ?? DEFAULT_RETRY_WAIT_MS;
    const held = pacer.holdFor(after);
    if (held < after) {
      log.warn(
        `${req.source} asked to wait ${Math.ceil(after / 1000)} s; holding it ${Math.ceil(held / 1000)} s`,
      );
    }
    if (after > MAX_RETRY_WAIT_MS) throw error;
    if (notAfter !== undefined && pacingClock() + after > notAfter) throw error;
    log.info(`${req.source} asked to slow down; retrying once in ${Math.ceil(after / 1000)} s`);
    try {
      await wait(after, signal);
      await slot();
    } catch (stop) {
      // The retry is not made: the source's own answer stands.
      if (stop instanceof PaceRefused) throw error;
      throw stopped(stop);
    }
    return await fetchJson<T>(req);
  }
}
