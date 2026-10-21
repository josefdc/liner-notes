/**
 * SecondHandSongs: originals and covers of the track's song.
 *
 * The SecondHandSongs page comes from the identity chain (a link on the track's MusicBrainz work,
 * or on the recording), never from a search. Its API answers the site's own URLs with JSON when
 * asked for it (`Accept: application/json`).
 *
 * - A work: its title must be the track's, and the track's artists must have a version of it.
 *   If one of their versions is the original, the other versions are covers of the track's
 *   song; otherwise the track is a cover, of the original versions.
 * - A performance: its title and performer are checked, then its originals, covers, the
 *   recordings it samples and those that sample it are read.
 *
 * The API key is optional: SHS_API_KEY is sent as `X-API-Key` when set, and without it requests
 * are anonymous, with a lower rate limit.
 *
 * The parser follows the payload of the published Python wrapper (arthurtofani/secondhandsongs:
 * `uri`, `title`, `performer`, `isOriginal`, `versions`, `originals`, `covers`, `sampledBy`,
 * `usesSamplesFrom`); the API's own documentation could not be read to confirm it, and the
 * fixtures are synthetic in that shape. Any other shape is reported as an invalid answer.
 *
 * @see https://secondhandsongs.com/page/API
 */

import { credential, fetchJson, type Shape } from "./http.js";
import {
  type Clock,
  checkIdentity,
  creditStringMatches,
  failed,
  found,
  MAX_RECORDS,
  missing,
  primaryEvidence,
  quoted,
  RELATION_PHRASE,
  type SourceResult,
  systemClock,
  type TrackRef,
  titlesMatch,
  unexpectedShape,
} from "./records.js";

const SITE = "https://secondhandsongs.com";
export const SHS_API_KEY = "SHS_API_KEY";

export interface ShsLink {
  kind: "work" | "performance";
  id: number;
}

interface ShsPerformanceSummary {
  uri?: string;
  title?: string;
  performer?: { uri?: string; name?: string };
  isOriginal?: boolean;
  date?: string | null;
}

interface ShsWork {
  uri?: string;
  title?: string;
  versions?: ShsPerformanceSummary[];
}

interface ShsPerformance extends ShsPerformanceSummary {
  originals?: Array<{ uri?: string; title?: string; original?: ShsPerformanceSummary }>;
  covers?: ShsPerformanceSummary[];
  usesSamplesFrom?: ShsPerformanceSummary[];
  sampledBy?: ShsPerformanceSummary[];
}

export interface ShsRelationship {
  kind: "cover-of" | "covered-by" | "samples" | "sampled-by";
  /**
   * "track": claimed for the track. "work": a fact about the song (its covers), not claimed for
   * a recording that is not the song's original recording.
   */
  about: "track" | "work";
  title: string;
  performer: string;
  /** The related performance's page. */
  url: string;
  date: string | null;
}

const PERFORMANCE_SUMMARY_SHAPE: Shape = {
  uri: true,
  title: true,
  performer: { uri: true, name: true },
  isOriginal: true,
  date: true,
};
const WORK_SHAPE: Shape = { uri: true, title: true, versions: [PERFORMANCE_SUMMARY_SHAPE] };
const PERFORMANCE_SHAPE: Shape = {
  ...PERFORMANCE_SUMMARY_SHAPE,
  originals: [{ uri: true, title: true, original: PERFORMANCE_SUMMARY_SHAPE }],
  covers: [PERFORMANCE_SUMMARY_SHAPE],
  usesSamplesFrom: [PERFORMANCE_SUMMARY_SHAPE],
  sampledBy: [PERFORMANCE_SUMMARY_SHAPE],
};

/** A secondhandsongs.com work or performance link, or null. */
export function shsLink(url: string): ShsLink | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/(?:^|\.)secondhandsongs\.com$/i.test(parsed.hostname)) return null;
  const match = parsed.pathname.match(/^\/(work|performance)\/(\d+)\/?$/);
  return match ? { kind: match[1] as ShsLink["kind"], id: Number(match[2]) } : null;
}

const pageOf = (link: ShsLink) => `${SITE}/${link.kind}/${link.id}`;

async function shsGet<T>(link: ShsLink, scrub: Shape, signal?: AbortSignal): Promise<T> {
  const key = credential(SHS_API_KEY);
  const answer = await fetchJson<T>({
    source: "secondhandsongs",
    url: pageOf(link),
    headers: { Accept: "application/json", ...(key ? { "X-API-Key": key } : {}) },
    scrub,
    signal,
  });
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) {
    throw unexpectedShape("secondhandsongs", `${link.kind} ${link.id} is not an object`);
  }
  return answer;
}

/** A related performance as a record; null when it has no page or title. */
function related(
  kind: ShsRelationship["kind"],
  about: ShsRelationship["about"],
  p: ShsPerformanceSummary | undefined,
): ShsRelationship | null {
  const url = p?.uri ? shsLink(p.uri) : null;
  if (url?.kind !== "performance" || typeof p?.title !== "string") return null;
  return {
    kind,
    about,
    title: p.title,
    performer: p.performer?.name?.trim() ?? "",
    url: pageOf(url),
    date: typeof p.date === "string" && p.date ? p.date : null,
  };
}

/** Records once per kind and related performance, in order. */
function unique(records: Array<ShsRelationship | null>): ShsRelationship[] {
  const seen = new Set<string>();
  return records.filter((r): r is ShsRelationship => {
    if (!r || seen.has(`${r.kind} ${r.url}`)) return false;
    seen.add(`${r.kind} ${r.url}`);
    return true;
  });
}

const list = <T>(v: T[] | undefined) => (Array.isArray(v) ? v : []);

type Read =
  | { ok: true; title: string; performer: string; records: ShsRelationship[] }
  | { ok: false; reason: string };

/**
 * A work: the track's performer must have a version titled as the track. A version by the same
 * performer is never a cover, whatever its title ("(Taylor's Version)", "(Live)"). When the
 * performer has the original version, the other performers' versions are covers of the song
 * (about the track only when it is the song's original recording); otherwise the track is a
 * cover of the original versions.
 */
function readWork(work: ShsWork, track: TrackRef, trackIsOriginal: boolean): Read {
  const title = typeof work?.title === "string" ? work.title : "";
  if (!titlesMatch(track.title, title, track.artists)) {
    return { ok: false, reason: `work "${title}" is not "${track.title}"` };
  }
  const versions = list(work.versions).filter((v) => typeof v?.title === "string");
  const byPerformer = (v: ShsPerformanceSummary) =>
    creditStringMatches(v.performer?.name ?? "", track.artists);
  const own = versions.filter(byPerformer);
  const titled = own.filter((v) => titlesMatch(track.title, v.title ?? "", track.artists));
  if (titled.length === 0) {
    return {
      ok: false,
      reason: `no version of "${title}" by ${track.artists.join(", ")} among ${versions.length}`,
    };
  }
  const others = versions.filter((v) => !byPerformer(v));
  const original = own.some((v) => v.isOriginal === true);
  const records = original
    ? others
        .filter((v) => v.isOriginal !== true)
        .map((v) => related("covered-by", trackIsOriginal ? "track" : "work", v))
    : others.filter((v) => v.isOriginal === true).map((v) => related("cover-of", "track", v));
  return {
    ok: true,
    title,
    performer: titled[0].performer?.name ?? track.artists.join(", "),
    records: unique(records),
  };
}

/**
 * A performance: its title and performer are checked. An original performance is a cover of
 * nothing, and neither the performance itself nor a performance by the same performer is
 * listed as its original or its cover.
 */
function readPerformance(p: ShsPerformance, track: TrackRef): Read {
  const check = checkIdentity(track, { title: p?.title ?? "", artists: p?.performer?.name ?? "" });
  if (!check.ok) return { ok: false, reason: check.reason };
  const self = p.uri ? shsLink(p.uri) : null;
  const other = (q: ShsPerformanceSummary | undefined) => {
    const link = q?.uri ? shsLink(q.uri) : null;
    const same = self && link && link.kind === self.kind && link.id === self.id;
    return !same && !creditStringMatches(q?.performer?.name ?? "", track.artists);
  };
  const originals =
    p.isOriginal === true
      ? []
      : list(p.originals)
          .map((o) => o?.original)
          .filter(other);
  const records = [
    ...originals.map((o) => related("cover-of", "track", o)),
    ...list(p.covers)
      .filter(other)
      .map((c) => related("covered-by", "track", c)),
    ...list(p.usesSamplesFrom).map((s) => related("samples", "track", s)),
    ...list(p.sampledBy).map((s) => related("sampled-by", "track", s)),
  ];
  return {
    ok: true,
    title: p.title ?? "",
    performer: p.performer?.name ?? "",
    records: unique(records),
  };
}

/**
 * Originals and covers of the track's song from the linked SecondHandSongs pages (a performance
 * link first, it is the more specific). Never throws: without a link, when the page fails a
 * check, or on any source error the result is "missing" with the reason.
 */
export async function shsRelationships(
  track: TrackRef,
  links: ShsLink[],
  options: { now?: Clock; signal?: AbortSignal; trackIsOriginal?: boolean } = {},
): Promise<SourceResult<ShsRelationship>> {
  const ordered = [...links].sort((a, b) =>
    a.kind === b.kind ? a.id - b.id : a.kind === "performance" ? -1 : 1,
  );
  const link = ordered[0];
  if (!link) {
    return missing("secondhandsongs", "MusicBrainz links no SecondHandSongs page to this track");
  }
  const now = options.now ?? systemClock;
  const ref = `${link.kind}/${link.id}`;
  try {
    const read =
      link.kind === "work"
        ? readWork(
            await shsGet<ShsWork>(link, WORK_SHAPE, options.signal),
            track,
            options.trackIsOriginal ?? false,
          )
        : readPerformance(
            await shsGet<ShsPerformance>(link, PERFORMANCE_SHAPE, options.signal),
            track,
          );
    if (!read.ok) {
      return missing("secondhandsongs", read.reason, { omitted: [{ ref, reason: read.reason }] });
    }
    if (read.records.length === 0) {
      return missing("secondhandsongs", "SecondHandSongs lists no originals, covers or samples", {
        matched: 1,
      });
    }
    const at = now().toISOString();
    const kept = read.records.slice(0, MAX_RECORDS);
    const evidence = kept.map((r) => {
      const other = r.url.slice(r.url.lastIndexOf("/") + 1);
      const when = r.date ? ` (${r.date})` : "";
      // A cover of the song is stated about the song, on its work page.
      const subject =
        r.about === "work"
          ? `the song ${quoted(read.title)} (as performed by ${read.performer})`
          : quoted(read.title, read.performer);
      return primaryEvidence({
        source: "secondhandsongs",
        recordRef: `${ref}/${r.kind}/${other}`,
        url: pageOf(link),
        title: `${read.title} — SecondHandSongs`,
        excerpt: `SecondHandSongs: ${subject} ${RELATION_PHRASE[r.kind]} ${quoted(r.title, r.performer)}${when}.`,
        retrievedAt: at,
      });
    });
    const notes = [
      read.records.length > kept.length
        ? `${read.records.length - kept.length} more not listed`
        : null,
      kept.some((r) => r.about === "work")
        ? "covers of the song, not claimed for this recording: it is not the song's original recording"
        : null,
    ].filter((n): n is string => n !== null);
    return found("secondhandsongs", kept, evidence, {
      incomplete: notes.length > 0 ? notes.join("; ") : null,
    });
  } catch (error) {
    return failed("secondhandsongs", error);
  }
}
