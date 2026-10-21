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

function shsGet<T>(link: ShsLink, scrub: Shape): Promise<T> {
  const key = credential(SHS_API_KEY);
  return fetchJson<T>({
    source: "secondhandsongs",
    url: pageOf(link),
    headers: { Accept: "application/json", ...(key ? { "X-API-Key": key } : {}) },
    scrub,
  });
}

/** A related performance as a record; null when it has no page or title. */
function related(kind: ShsRelationship["kind"], p: ShsPerformanceSummary | undefined) {
  const url = p?.uri ? shsLink(p.uri) : null;
  if (url?.kind !== "performance" || typeof p?.title !== "string") return null;
  return {
    kind,
    title: p.title,
    performer: p.performer?.name?.trim() ?? "",
    url: pageOf(url),
    date: typeof p.date === "string" && p.date ? p.date : null,
  } satisfies ShsRelationship;
}

const isRecord = (r: ShsRelationship | null): r is ShsRelationship => r !== null;

type Read =
  | { ok: true; title: string; performer: string; records: ShsRelationship[] }
  | { ok: false; reason: string };

function readWork(work: ShsWork, track: TrackRef): Read {
  const title = work?.title ?? "";
  if (!titlesMatch(track.title, title)) {
    return { ok: false, reason: `work "${title}" is not "${track.title}"` };
  }
  const versions = Array.isArray(work.versions) ? work.versions : [];
  const own = versions.filter(
    (v) =>
      typeof v?.title === "string" &&
      titlesMatch(track.title, v.title) &&
      creditStringMatches(v.performer?.name ?? "", track.artists),
  );
  if (own.length === 0) {
    return {
      ok: false,
      reason: `no version of "${title}" by ${track.artists.join(", ")} among ${versions.length}`,
    };
  }
  const ownPages = new Set(own.map((v) => v.uri));
  const others = versions.filter((v) => !ownPages.has(v.uri));
  const original = own.some((v) => v.isOriginal === true);
  const records = original
    ? others.filter((v) => v.isOriginal !== true).map((v) => related("covered-by", v))
    : others.filter((v) => v.isOriginal === true).map((v) => related("cover-of", v));
  return {
    ok: true,
    title,
    performer: own[0].performer?.name ?? track.artists.join(", "),
    records: records.filter(isRecord),
  };
}

function readPerformance(p: ShsPerformance, track: TrackRef): Read {
  const check = checkIdentity(track, { title: p?.title ?? "", artists: p?.performer?.name ?? "" });
  if (!check.ok) return { ok: false, reason: check.reason };
  const list = <T>(v: T[] | undefined) => (Array.isArray(v) ? v : []);
  const records = [
    ...list(p.originals).map((o) => related("cover-of", o?.original)),
    ...list(p.covers).map((c) => related("covered-by", c)),
    ...list(p.usesSamplesFrom).map((s) => related("samples", s)),
    ...list(p.sampledBy).map((s) => related("sampled-by", s)),
  ].filter(isRecord);
  return { ok: true, title: p.title ?? "", performer: p.performer?.name ?? "", records };
}

/**
 * Originals and covers of the track's song from the linked SecondHandSongs pages (a performance
 * link first, it is the more specific). Never throws: without a link, when the page fails a
 * check, or on any source error the result is "missing" with the reason.
 */
export async function shsRelationships(
  track: TrackRef,
  links: ShsLink[],
  options: { now?: Clock } = {},
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
        ? readWork(await shsGet<ShsWork>(link, WORK_SHAPE), track)
        : readPerformance(await shsGet<ShsPerformance>(link, PERFORMANCE_SHAPE), track);
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
      return primaryEvidence({
        source: "secondhandsongs",
        recordRef: `${ref}/${r.kind}/${other}`,
        url: pageOf(link),
        title: `${read.title} — SecondHandSongs`,
        excerpt: `SecondHandSongs: ${quoted(read.title, read.performer)} ${RELATION_PHRASE[r.kind]} ${quoted(r.title, r.performer)}${when}.`,
        retrievedAt: at,
      });
    });
    return found("secondhandsongs", kept, evidence, {
      incomplete:
        read.records.length > kept.length
          ? `${read.records.length - kept.length} more not listed`
          : null,
    });
  } catch (error) {
    return failed("secondhandsongs", error);
  }
}
