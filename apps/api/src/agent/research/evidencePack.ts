/**
 * The run's evidence pack: the Evidence items the composer may cite, each built from what a
 * source answered (an API payload), never from text a model wrote.
 *
 * Items reach the pack only through this module's constructors, which take a source's typed
 * answer: `primaryRecordEvidence` the primary sources' results (MusicBrainz by ISRC, Discogs,
 * SecondHandSongs, Genius), whose items the source modules built from their payloads
 * (`primaryEvidence`), and `webSearchEvidence` the web search's results (Tavily's title, URL
 * and page text). `EvidencePack.add` throws on anything else: a string, such as a summary a
 * model wrote, an object shaped like Evidence (one parsed from a model's answer, or a copy of an
 * item), or an item that breaks the contract's evidence checks.
 *
 * A research-cache hit gives the evidence of the run that made the research: `restoredEvidence`
 * takes those items back from the cache (what this module built and the cache stored), checking
 * each one as the constructors would have made it; one that is not is refused, and with it the
 * cached evidence.
 *
 * The constructors are called only from the code that reads the sources (agent/research/,
 * sources/; a test pins it). The web tier rests on that: its results reach the researcher as the
 * search tool's JSON text, which carries no object brand, and the researcher's Tavily reader is
 * their one caller.
 *
 * The pack keeps an id once (the first item wins), lists items by tier (primary records, then
 * editorial, then web; within primary records the recording's own items, then a release's,
 * then the song's) and keeps at most EVIDENCE_PACK_MAX_ITEMS; how many it left out is counted.
 */

import {
  EVIDENCE_EXCERPT_MAX,
  type Evidence,
  evidenceIssues,
  type SourceError,
} from "@liner-notes/contract";
import type { PrimarySources } from "../../sources/identity.js";
import {
  type EvidenceScope,
  evidenceScope,
  isPrimaryRecordEvidence,
} from "../../sources/records.js";
import { isLyricPage, type WebResult } from "../../sources/search.js";
import { isPreviewUrl } from "../../store/runs.js";
import { isErrorPage, isPlaceholder, type SearchedTrack } from "./plan.js";

/** The most items a run's pack keeps; the lowest-ranked are left out and counted. */
export const EVIDENCE_PACK_MAX_ITEMS = 80;

declare const fromSource: unique symbol;

/** An Evidence item built by this module from a source's answer; frozen. */
export type SourcedEvidence = Readonly<Evidence> & { readonly [fromSource]: true };

/** Thrown when something that was not built from a source's answer is offered as Evidence. */
export class EvidenceOriginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceOriginError";
  }
}

/** The items this module built. A copy of one, or any other object, is not in it. */
const sourced = new WeakSet<object>();

function seal(item: Evidence): SourcedEvidence {
  const issues = evidenceIssues(item);
  if (issues.length > 0) {
    throw new EvidenceOriginError(`evidence ${item.id} breaks the contract: ${issues.join("; ")}`);
  }
  const frozen = Object.freeze({ ...item });
  sourced.add(frozen);
  return frozen as SourcedEvidence;
}

/** True for an item built by this module's constructors (that very object). */
export function isSourcedEvidence(item: unknown): item is SourcedEvidence {
  return typeof item === "object" && item !== null && sourced.has(item);
}

const PRIMARY_KEYS = ["musicbrainz", "discogs", "genius", "secondhandsongs"] as const;

/**
 * The Evidence of the primary sources' answers, in source order. Every item must be one the
 * source module built from its payload, of that source, as a primary record with a scoped
 * recordRef; anything else is a bug and throws.
 */
export function primaryRecordEvidence(sources: PrimarySources): SourcedEvidence[] {
  const items: SourcedEvidence[] = [];
  for (const key of PRIMARY_KEYS) {
    const result = sources[key];
    if (result.status !== "found") continue;
    for (const item of result.evidence) {
      if (!isPrimaryRecordEvidence(item)) {
        throw new EvidenceOriginError(
          `an item offered as ${key} evidence was not built from its answer`,
        );
      }
      if (item.source !== result.source || item.sourceTier !== "primary-record") {
        throw new EvidenceOriginError(`evidence ${item.id} is not a ${key} primary record`);
      }
      if (evidenceScope(item) === null) {
        throw new EvidenceOriginError(`evidence ${item.id} does not say what it is about`);
      }
      items.push(seal(item));
    }
  }
  return items;
}

/**
 * The primary sources' errors, for the run's source errors: each source that could not be read,
 * and each that answered but lost records to a failed request (`lostRecords`).
 */
export function primarySourceErrors(sources: PrimarySources): SourceError[] {
  return PRIMARY_KEYS.flatMap((key) => {
    const { error } = sources[key];
    return error ? [error] : [];
  });
}

/**
 * The sources that answered with records but lost some to a failed request: the MusicBrainz
 * work, and so its covers, when its read failed or the deadline cut it (recordings that could
 * not be dated lose nothing: that is a note, not an error). Each with the source's note on what
 * is missing. The error blocks the research cache and the stored result whatever its code: a
 * retry may complete them.
 */
export function lostRecords(
  sources: PrimarySources,
): Array<{ error: SourceError; note: string | null }> {
  return PRIMARY_KEYS.flatMap((key) => {
    const result = sources[key];
    return result.status === "found" && result.error
      ? [{ error: result.error, note: result.incomplete }]
      : [];
  });
}

/**
 * The errors of the primary sources that answered JSON of a shape their reader does not know
 * (marked lasting by `unexpectedShape`): a retry gets the same answer, so they do not keep the
 * result from being stored; it is stored with them and reports them when served.
 */
export function lastingErrors(sources: PrimarySources): SourceError[] {
  return PRIMARY_KEYS.flatMap((key) => {
    const result = sources[key];
    return result.status === "missing" && result.lasting && result.error ? [result.error] : [];
  });
}

/** One web search result as the search read it, and when. */
export interface WebFinding {
  result: WebResult;
  retrievedAt: string;
  /** The track the search was about: a result naming it is never taken for an error page. */
  track?: SearchedTrack;
}

/**
 * A web page's URL as the WHATWG URL parser writes it (ASCII, percent-encoded), so the id and
 * link read the same in the prompt, which normalises text; null when it is not an http(s) URL.
 */
function webPage(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

/**
 * Web-tier Evidence from the web search's results: the page's title, URL and the text the
 * search returned for it, cut to the contract's excerpt limit. One item per URL; a result
 * without a web URL or text, a placeholder text, an error page ("404 Not Found", a bot wall), a
 * page on a lyric site, or one whose URL is a preview or signed link gives none.
 */
export function webSearchEvidence(findings: readonly WebFinding[]): SourcedEvidence[] {
  const items: SourcedEvidence[] = [];
  const seen = new Set<string>();
  for (const { result, retrievedAt, track } of findings) {
    const raw = typeof result?.url === "string" ? result.url.trim() : "";
    const url = raw ? webPage(raw) : null;
    const text = typeof result?.content === "string" ? result.content.trim() : "";
    if (!url || isPlaceholder(text) || isErrorPage(result, track)) continue;
    if (isLyricPage(url) || isPreviewUrl(url) || isPreviewUrl(raw)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const title = typeof result.title === "string" && result.title.trim() ? result.title : url;
    items.push(
      seal({
        id: `tavily:${url}`,
        source: "tavily",
        sourceTier: "web",
        url,
        title: title.trim(),
        retrievedAt,
        excerpt:
          text.length > EVIDENCE_EXCERPT_MAX ? `${text.slice(0, EVIDENCE_EXCERPT_MAX - 1)}…` : text,
        recordRef: null,
      }),
    );
  }
  return items;
}

/**
 * Why a stored item is not one this module's constructors would have made, or null: a primary
 * record of a primary source with a scoped recordRef and the id the source module gives it, or a
 * web page of the web search with its id, a web URL and none of the pages the web tier leaves
 * out; and the contract's evidence checks.
 */
function storedItemIssue(item: Evidence): string | null {
  if (item.sourceTier === "primary-record") {
    if (!(PRIMARY_KEYS as readonly string[]).includes(item.source)) return "not a primary source";
    if (evidenceScope(item) === null) return "no scope";
    if (item.id !== `${item.source}:${item.recordRef}`) return "not the source's id";
    return null;
  }
  if (item.sourceTier === "web") {
    if (item.source !== "tavily" || item.recordRef !== null) return "not a web search result";
    const url = item.url ? webPage(item.url) : null;
    if (!url || url !== item.url || item.id !== `tavily:${url}`) return "not a web page's id";
    if (isLyricPage(url) || isPreviewUrl(url)) return "a page the web tier leaves out";
    if (isPlaceholder(item.excerpt)) return "a placeholder";
    return null;
  }
  return "a tier no source module builds";
}

/**
 * The evidence of a cached research, as items of a pack again: each stored item checked as above
 * and sealed. Null when any item fails a check: the cached evidence is then not used at all,
 * never in part.
 */
export function restoredEvidence(items: readonly Evidence[]): SourcedEvidence[] | null {
  const restored: SourcedEvidence[] = [];
  for (const item of items) {
    if (storedItemIssue(item) !== null) return null;
    try {
      restored.push(seal({ ...item }));
    } catch (error) {
      if (error instanceof EvidenceOriginError) return null;
      throw error;
    }
  }
  return restored;
}

const SCOPE_RANK: Record<EvidenceScope, number> = { track: 0, release: 1, work: 2 };

/** Primary records first (the recording's, a release's, the song's), then editorial, then web. */
function rank(item: Evidence): number {
  if (item.sourceTier === "primary-record") {
    const scope = evidenceScope(item);
    return scope ? SCOPE_RANK[scope] : 3;
  }
  return item.sourceTier === "editorial" ? 4 : 5;
}

/** A run's evidence pack. */
export class EvidencePack {
  readonly #items = new Map<string, SourcedEvidence>();

  constructor(readonly maxItems = EVIDENCE_PACK_MAX_ITEMS) {}

  /**
   * Adds an item built from a source's answer; false when its id is already in the pack (the
   * first item is kept). Throws EvidenceOriginError for anything else.
   */
  add(item: SourcedEvidence): boolean {
    if (!isSourcedEvidence(item)) {
      throw new EvidenceOriginError(
        typeof item === "string"
          ? "text is not evidence: only an item built from a source's answer can be added"
          : "only an item built from a source's answer can be added",
      );
    }
    if (this.#items.has(item.id)) return false;
    this.#items.set(item.id, item);
    return true;
  }

  /** Adds each item; the number added. */
  addAll(items: readonly SourcedEvidence[]): number {
    let added = 0;
    for (const item of items) if (this.add(item)) added++;
    return added;
  }

  /** How many distinct items were added, kept or not. */
  get size(): number {
    return this.#items.size;
  }

  /** How many items the size cap leaves out. */
  get omitted(): number {
    return Math.max(0, this.#items.size - this.maxItems);
  }

  /** The kept items, best tier first; within a rank, in the order they were added. */
  items(): SourcedEvidence[] {
    return [...this.#items.values()]
      .map((item, index) => ({ item, index, rank: rank(item) }))
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .slice(0, this.maxItems)
      .map(({ item }) => item);
  }
}
