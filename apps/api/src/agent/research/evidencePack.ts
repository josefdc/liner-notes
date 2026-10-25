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
  type SourceId,
} from "@liner-notes/contract";
import type { PrimarySources } from "../../sources/identity.js";
import {
  type EvidenceScope,
  evidenceScope,
  isPrimaryRecordEvidence,
} from "../../sources/records.js";
import { isLyricPage, type WebResult } from "../../sources/search.js";
import { isPreviewUrl } from "../../store/runs.js";

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

/** The primary-record sources read from the track's ISRC. */
export const PRIMARY_RECORD_SOURCES: ReadonlySet<SourceId> = new Set(PRIMARY_KEYS);

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
 * and each that answered but lost records to a failed request (`lostRecordErrors`).
 */
export function primarySourceErrors(sources: PrimarySources): SourceError[] {
  return PRIMARY_KEYS.flatMap((key) => {
    const { error } = sources[key];
    return error ? [error] : [];
  });
}

/**
 * The sources that answered with records but lost some to a failed request (the MusicBrainz
 * work, and so its covers, when its read failed or the deadline cut it): the error and the
 * source's note on what is missing. A retry may complete them, so a run with one is not kept
 * as complete.
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

/** One web search result as the search read it, and when. */
export interface WebFinding {
  result: WebResult;
  retrievedAt: string;
}

const isWebPage = (url: string) => {
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
};

/**
 * Web-tier Evidence from the web search's results: the page's title, URL and the text the
 * search returned for it, cut to the contract's excerpt limit. One item per URL; a result
 * without a web URL or text, on a lyric site, or whose URL is a preview or signed link gives none.
 */
export function webSearchEvidence(findings: readonly WebFinding[]): SourcedEvidence[] {
  const items: SourcedEvidence[] = [];
  const seen = new Set<string>();
  for (const { result, retrievedAt } of findings) {
    const url = typeof result?.url === "string" ? result.url.trim() : "";
    const text = typeof result?.content === "string" ? result.content.trim() : "";
    if (!url || !text || !isWebPage(url) || isLyricPage(url) || isPreviewUrl(url)) continue;
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
