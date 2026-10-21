/**
 * The identity chain: from a track's ISRC to the records that describe it at each primary
 * source, by ids and links rather than by searching names.
 *
 *   ISRC → MusicBrainz recording (lookup by ISRC; title, artists and duration checked)
 *        → its relationships (samples, remixes, covers)
 *        → URL relationships of its releases and works
 *        → Discogs release · Genius song · SecondHandSongs work or performance
 *
 * Every step checks the record it reaches; a record that fails is omitted with the reason, never
 * replaced by the next best one. Each source returns typed records with Evidence items
 * (`sourceTier: "primary-record"`) or "missing" with the reason, and counts how many records it
 * matched, rejected or could not find (`accuracy`).
 */

import { tool } from "@langchain/core/tools";
import type { Evidence, SourceId } from "@liner-notes/contract";
import { z } from "zod";
import {
  DISCOGS_TOKEN,
  type DiscogsCredit,
  discogsConfigured,
  discogsReleaseId,
  discogsTrackCredits,
} from "./discogs.js";
import {
  type GeniusRelationship,
  geniusConfigured,
  geniusPage,
  geniusRelationships,
  GENIUS_ACCESS_TOKEN,
} from "./genius.js";
import { describeError } from "./http.js";
import {
  browseRecordingReleases,
  browseWorkRecordings,
  creditString,
  getRecordingDetails,
  getWorkRecordings,
  isMbid,
  lookupIsrc,
  type MbRecordingDetails,
  type MbRecordingSummary,
  type MbRelationship,
  type MbReleaseSummary,
  type MbWork,
  normalizeIsrc,
  recordingRelationships,
  workCovers,
} from "./musicbrainz.js";
import {
  type Clock,
  checkIdentity,
  failed,
  found,
  type IdentityCounts,
  identityAccuracy,
  MAX_RECORDS,
  missing,
  notConfigured,
  type Omission,
  primaryEvidence,
  quoted,
  RELATION_PHRASE,
  type SourceResult,
  systemClock,
  type TrackRef,
  titlesMatch,
  unexpectedShape,
} from "./records.js";
import { type ShsLink, type ShsRelationship, shsLink, shsRelationships } from "./shs.js";

const MB_SITE = "https://musicbrainz.org";

/** The matched MusicBrainz recording and the links the other sources start from. */
export interface PrimaryIdentity {
  isrc: string;
  recording: { mbid: string; title: string; artist: string; lengthMs: number | null };
  /** The works the recording performs, each once, with its performance attributes. */
  works: Array<{ mbid: string; title: string; cover: boolean; attributes: string[] }>;
  /**
   * Whether the recording is its work's original recording, and why: only then are the work's
   * covers and the song's relationships at Genius and SecondHandSongs claimed for the track.
   */
  original: { original: boolean; reason: string };
  /** Discogs releases of the recording, original releases first, earliest first. */
  discogsReleaseIds: number[];
  /** Why no Discogs release could be listed, when the releases could not be read. */
  releasesError: string | null;
  /** Set when not every release of the recording could be read. */
  releasesNote: string | null;
  /** The Genius page linked from the recording's work; null when none or several. */
  geniusUrl: string | null;
  shsLinks: ShsLink[];
}

export type IdentityResolution =
  | {
      identity: PrimaryIdentity;
      details: MbRecordingDetails;
      /** The work with its recordings, when the recording performs exactly one. */
      work: MbWork | null;
      workError: string | null;
      result: SourceResult<never>;
    }
  | {
      identity: null;
      details: null;
      work: null;
      workError: null;
      result: SourceResult<never>;
    };

const creditedArtists = (r: MbRecordingSummary) =>
  (Array.isArray(r["artist-credit"]) ? r["artist-credit"] : []).map((c) => ({
    names: [c.name, c.artist?.name ?? ""].filter(Boolean),
  }));

const lengthOf = (r: MbRecordingSummary) => (typeof r.length === "number" ? r.length : null);

/**
 * The one recording under the ISRC that is the track. Candidates that fail a check are omitted.
 * When several pass, the one whose duration is closest wins if it is strictly closest;
 * otherwise the one without a disambiguation comment if it is the only one; otherwise none.
 */
export function pickRecording(
  track: TrackRef,
  candidates: MbRecordingSummary[],
): { recording: MbRecordingSummary | null; omitted: Omission[]; reason: string } {
  const omitted: Omission[] = [];
  const passing: MbRecordingSummary[] = [];
  for (const candidate of candidates) {
    const check = checkIdentity(track, {
      title: candidate.title,
      artists: creditedArtists(candidate),
      durationMs: lengthOf(candidate),
    });
    if (check.ok) passing.push(candidate);
    else omitted.push({ ref: `recording/${candidate.id}`, reason: check.reason });
  }
  if (passing.length === 0) {
    return { recording: null, omitted, reason: "no recording under the ISRC is the track" };
  }
  let chosen: MbRecordingSummary | null = passing.length === 1 ? passing[0] : null;
  if (!chosen && track.durationMs !== null) {
    const distance = (r: MbRecordingSummary) => {
      const length = lengthOf(r);
      return length === null
        ? Number.POSITIVE_INFINITY
        : Math.abs(length - (track.durationMs ?? 0));
    };
    const sorted = [...passing].sort((a, b) => distance(a) - distance(b));
    if (Number.isFinite(distance(sorted[0])) && distance(sorted[0]) < distance(sorted[1])) {
      chosen = sorted[0];
    }
  }
  if (!chosen) {
    const plain = passing.filter((r) => !r.disambiguation?.trim());
    if (plain.length === 1) chosen = plain[0];
  }
  if (!chosen) {
    return {
      recording: null,
      omitted,
      reason: `${passing.length} recordings under the ISRC pass the checks and cannot be told apart`,
    };
  }
  for (const other of passing) {
    if (other !== chosen) {
      omitted.push({
        ref: `recording/${other.id}`,
        reason: `recording/${chosen.id} is the closer match`,
      });
    }
  }
  return { recording: chosen, omitted, reason: "" };
}

/** Release-group types whose credits are not the original release's. */
const NOT_ORIGINAL = new Set([
  "compilation",
  "dj-mix",
  "live",
  "remix",
  "mixtape/street",
  "soundtrack",
]);

/** A release date as a sort key; a bare year or month sorts after the dated days in it. */
function dateKey(date: string | undefined): string {
  if (!date) return "9999-99-99";
  const [year, month = "99", day = "99"] = date.split("-");
  return `${year}-${month}-${day}`;
}

/**
 * The Discogs release ids linked from the recording's releases: original releases only (not a
 * compilation, soundtrack, live, DJ-mix or remix release), earliest first.
 */
export function discogsCandidates(releases: MbReleaseSummary[]): number[] {
  const originals = releases
    .filter((r) => {
      const secondary = r["release-group"]?.["secondary-types"] ?? [];
      return !secondary.some((t) => NOT_ORIGINAL.has(String(t).toLowerCase()));
    })
    .sort((a, b) => dateKey(a.date).localeCompare(dateKey(b.date)) || a.id.localeCompare(b.id));
  const ids: number[] = [];
  for (const release of originals) {
    for (const rel of release.relations ?? []) {
      const id = rel.type === "discogs" && rel.url ? discogsReleaseId(rel.url.resource) : null;
      if (id !== null && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

/** The works the recording performs (each once), with their Genius and SecondHandSongs links. */
function linksOf(details: MbRecordingDetails) {
  const works: PrimaryIdentity["works"] = [];
  const genius = new Set<string>();
  const shs: ShsLink[] = [];
  const addShs = (url: string) => {
    const link = shsLink(url);
    if (link && !shs.some((l) => l.kind === link.kind && l.id === link.id)) shs.push(link);
  };
  const list = <T>(v: T[] | undefined) => (Array.isArray(v) ? v : []);
  for (const rel of list(details.relations)) {
    if (rel?.type === "secondhandsongs" && rel.url) addShs(rel.url.resource);
    if (rel?.type !== "performance" || !rel.work || !isMbid(rel.work.id)) continue;
    const attributes = list(rel.attributes).map(String);
    // One work can be performed twice in MusicBrainz's data (two dated performance
    // relationships); it is one work, with the attributes of both.
    const known = works.find((w) => w.mbid === rel.work?.id);
    if (known) {
      known.attributes = [...new Set([...known.attributes, ...attributes])];
      known.cover = known.attributes.includes("cover");
    } else {
      works.push({
        mbid: rel.work.id,
        title: rel.work.title,
        cover: attributes.includes("cover"),
        attributes,
      });
    }
    for (const link of list(rel.work.relations)) {
      if (!link?.url) continue;
      if (link.type === "lyrics") {
        const page = geniusPage(link.url.resource);
        if (page) genius.add(page);
      } else if (link.type === "secondhandsongs") {
        addShs(link.url.resource);
      }
    }
  }
  return { works, geniusUrl: genius.size === 1 ? [...genius][0] : null, shsLinks: shs };
}

/** Performance attributes that make a recording something other than the song's original. */
const DERIVED_ATTRIBUTES = ["cover", "live", "medley", "partial", "instrumental", "karaoke"];

const yearOf = (date: string | undefined) => {
  const year = Number(date?.slice(0, 4));
  return Number.isInteger(year) && year > 0 ? year : null;
};

/**
 * Whether the matched recording is the original recording of the song it performs, so that the
 * song's covers, samples and other work-level relationships can be claimed for it. It is when
 * it performs one work, without a cover, live, medley, partial, instrumental or karaoke
 * attribute, without a disambiguation comment ("radio edit", "live, 1995"), under the work's
 * title (not "(Taylor's Version)"), and no recording of the work that is not a cover was first
 * released in an earlier year. Anything unknown answers no: a re-recording, live version or
 * edit never inherits the song's relationships.
 */
export function originalPerformance(
  details: MbRecordingDetails,
  works: PrimaryIdentity["works"],
  workRecordings: { recordings: MbRecordingSummary[]; total: number } | null,
  coverIds: ReadonlySet<string> = new Set(),
): PrimaryIdentity["original"] {
  if (works.length !== 1) {
    return {
      original: false,
      reason:
        works.length === 0
          ? "MusicBrainz links no work to the recording"
          : `the recording performs ${works.length} works`,
    };
  }
  const [work] = works;
  const derived = work.attributes.filter((a) => DERIVED_ATTRIBUTES.includes(a));
  if (derived.length > 0) {
    return { original: false, reason: `a ${derived.join(", ")} performance of "${work.title}"` };
  }
  if (details.disambiguation?.trim()) {
    return { original: false, reason: `filed as "${details.disambiguation.trim()}"` };
  }
  const artists = creditedArtists(details).map((a) => a.names[0]);
  if (!titlesMatch(details.title ?? "", work.title, artists)) {
    return { original: false, reason: `titled "${details.title}", a version of "${work.title}"` };
  }
  if (!workRecordings) {
    return { original: false, reason: `the recordings of "${work.title}" could not be dated` };
  }
  const own = yearOf(details["first-release-date"]);
  if (own === null) return { original: false, reason: "the recording has no release date" };
  const earlier = workRecordings.recordings
    .filter((r) => r.id !== details.id && !coverIds.has(r.id))
    .map((r) => ({ r, year: yearOf(r["first-release-date"]) }))
    .filter((x): x is { r: MbRecordingSummary; year: number } => x.year !== null && x.year < own)
    .sort((a, b) => a.year - b.year);
  if (earlier.length > 0) {
    const first = earlier[0];
    return {
      original: false,
      reason: `${quoted(first.r.title, creditString(first.r["artist-credit"]))} was released in ${first.year}, before this recording (${own})`,
    };
  }
  if (workRecordings.total > workRecordings.recordings.length) {
    return {
      original: false,
      reason: `only ${workRecordings.recordings.length} of the ${workRecordings.total} recordings of "${work.title}" could be compared`,
    };
  }
  return { original: true, reason: `the earliest release of "${work.title}" (${own})` };
}

/**
 * ISRC → the MusicBrainz recording that is the track, with the links the other sources start
 * from and whether it is the song's original recording. Never throws.
 */
export async function resolveIdentity(
  track: TrackRef,
  options: { signal?: AbortSignal } = {},
): Promise<IdentityResolution> {
  const { signal } = options;
  const none = (result: SourceResult<never>): IdentityResolution => ({
    identity: null,
    details: null,
    work: null,
    workError: null,
    result,
  });
  const isrc = normalizeIsrc(track.isrc);
  if (!isrc) return none(missing("musicbrainz", "the track has no valid ISRC"));
  try {
    const candidates = await lookupIsrc(isrc, signal);
    if (candidates.length === 0) {
      return none(missing("musicbrainz", `MusicBrainz has no recording with ISRC ${isrc}`));
    }
    const pick = pickRecording(track, candidates);
    if (!pick.recording) {
      return none(missing("musicbrainz", pick.reason, { omitted: pick.omitted }));
    }
    const details = await getRecordingDetails(pick.recording.id, signal);
    if (!details || typeof details !== "object" || !isMbid(details.id)) {
      throw unexpectedShape("musicbrainz", "the recording lookup is not a recording");
    }
    // The lookup answers for the recording itself: checked again, in case it was merged.
    const check = checkIdentity(track, {
      title: details.title ?? "",
      artists: creditedArtists(details),
      durationMs: lengthOf(details),
    });
    if (!check.ok) {
      const omitted = [
        ...pick.omitted,
        { ref: `recording/${pick.recording.id}`, reason: check.reason },
      ];
      return none(missing("musicbrainz", check.reason, { omitted }));
    }

    let discogsReleaseIds: number[] = [];
    let releasesError: string | null = null;
    let releasesNote: string | null = null;
    try {
      const { releases, total } = await browseRecordingReleases(details.id, 2, signal);
      // Sorted before the Discogs source takes the first few.
      discogsReleaseIds = discogsCandidates(releases);
      if (total > releases.length) {
        releasesNote = `only ${releases.length} of the recording's ${total} releases were read for Discogs links`;
      }
    } catch (error) {
      releasesError = `MusicBrainz releases could not be read: ${describeError(error)}`;
    }

    const links = linksOf(details);
    let work: MbWork | null = null;
    let workError: string | null = null;
    let original: PrimaryIdentity["original"] = originalPerformance(details, links.works, null);
    // The covers of the work are read only for a recording that is not itself a cover.
    if (links.works.length === 1 && !links.works[0].cover) {
      const [only] = links.works;
      try {
        work = await getWorkRecordings(only.mbid, signal);
        const coverIds = new Set(
          (Array.isArray(work?.relations) ? work.relations : [])
            .filter((r) => (r?.attributes ?? []).includes("cover") && r.recording)
            .map((r) => r.recording?.id as string),
        );
        // Dating the work's recordings costs requests; only worth it when nothing else ruled
        // the recording out.
        if (original.reason.endsWith("could not be dated")) {
          original = originalPerformance(
            details,
            links.works,
            await browseWorkRecordings(only.mbid, 2, signal),
            coverIds,
          );
        }
      } catch (error) {
        workError = `the work "${only.title}" could not be read: ${describeError(error)}`;
      }
    }

    const identity: PrimaryIdentity = {
      isrc,
      recording: {
        mbid: details.id,
        title: details.title,
        artist: creditString(details["artist-credit"]),
        lengthMs: lengthOf(details),
      },
      discogsReleaseIds,
      releasesError,
      releasesNote,
      original,
      ...links,
    };
    return {
      identity,
      details,
      work,
      workError,
      result: found("musicbrainz", [], [], { omitted: pick.omitted }),
    };
  } catch (error) {
    return none(failed("musicbrainz", error));
  }
}

const minutes = (ms: number | null) => {
  if (ms === null) return "";
  const s = Math.round(ms / 1000);
  return ` (${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")})`;
};

/**
 * The matched recording's samples and remixes, and the covers of the song it performs, from
 * MusicBrainz, with an Evidence item for the recording itself (its ISRC, title, credit and
 * length) and one per relationship. Covers of the work are phrased as covers of the work and
 * link the work's page; they are claimed for the track (`about: "track"`) only when it is the
 * work's original recording.
 */
export async function musicBrainzRelationships(
  resolution: IdentityResolution,
  options: { now?: Clock } = {},
): Promise<SourceResult<MbRelationship>> {
  const { identity, details, result } = resolution;
  if (!identity || !details || result.status !== "found") {
    return result.status === "missing"
      ? result
      : missing("musicbrainz", "no MusicBrainz recording identified");
  }
  const now = options.now ?? systemClock;
  const at = now().toISOString();
  const { recording } = identity;
  const records = recordingRelationships(details);

  const notes: string[] = [];
  if (resolution.workError) notes.push(resolution.workError);
  const [work] = identity.works;
  if (resolution.work && work && !work.cover) {
    const about = identity.original.original ? "track" : "work";
    for (const cover of workCovers(resolution.work, recording.mbid)) {
      records.push({ ...cover, about });
    }
    if (!identity.original.original) {
      notes.push(
        `covers are of the work "${work.title}", not this recording: ${identity.original.reason}`,
      );
    }
  }

  const page = `${MB_SITE}/recording/${recording.mbid}`;
  const own = quoted(recording.title, recording.artist);
  const evidence: Evidence[] = [
    primaryEvidence({
      source: "musicbrainz",
      recordRef: `recording/${recording.mbid}`,
      url: page,
      title: `${recording.title} — MusicBrainz recording`,
      excerpt: `MusicBrainz recording ${own}${minutes(recording.lengthMs)}, ISRC ${identity.isrc}.`,
      retrievedAt: at,
    }),
  ];
  const kept = records.slice(0, MAX_RECORDS);
  for (const r of kept) {
    const other = r.recording
      ? quoted(r.recording.title, r.recording.artist)
      : quoted(r.work?.title ?? "");
    if (r.kind === "covered-by" && r.work) {
      // A cover of the work: stated about the work, on the work's page.
      evidence.push(
        primaryEvidence({
          source: "musicbrainz",
          recordRef: `work/${r.work.mbid}/covered-by/recording/${r.recording?.mbid}`,
          url: `${MB_SITE}/work/${r.work.mbid}`,
          title: `${r.work.title} — MusicBrainz work`,
          excerpt: `MusicBrainz: the work ${quoted(r.work.title)} is covered by ${other}.`,
          retrievedAt: at,
        }),
      );
      continue;
    }
    const otherRef = r.recording ? `recording/${r.recording.mbid}` : `work/${r.work?.mbid}`;
    evidence.push(
      primaryEvidence({
        source: "musicbrainz",
        recordRef: `recording/${recording.mbid}/${r.kind}/${otherRef}`,
        url: page,
        title: `${recording.title} — MusicBrainz relationships`,
        excerpt: `MusicBrainz: ${own} ${RELATION_PHRASE[r.kind]} ${other}.`,
        retrievedAt: at,
      }),
    );
  }
  if (records.length > kept.length) notes.push(`${records.length - kept.length} more not listed`);
  return found("musicbrainz", kept, evidence, {
    omitted: result.omitted,
    incomplete: notes.length > 0 ? notes.join("; ") : null,
  });
}

export interface PrimarySources {
  identity: PrimaryIdentity | null;
  musicbrainz: SourceResult<MbRelationship>;
  discogs: SourceResult<DiscogsCredit>;
  genius: SourceResult<GeniusRelationship>;
  secondhandsongs: SourceResult<ShsRelationship>;
  /** Every Evidence item the sources produced, each id once. */
  evidence: Evidence[];
  /** Per source: records matched, rejected by a check, or not found. */
  accuracy: Partial<Record<SourceId, IdentityCounts>>;
}

/** The longest a whole run may take, all sources together. */
export const PRIMARY_SOURCES_DEADLINE_MS = 20_000;

/** A source's answer, or its failure as "missing": one source never takes the others down. */
async function settle<T>(source: SourceId, run: () => Promise<SourceResult<T>>) {
  try {
    return await run();
  } catch (error) {
    return failed<T>(source, error);
  }
}

/**
 * Runs the identity chain for a track and reads every primary source from it, within
 * `deadlineMs` (default 20 s) or until `signal` aborts; whatever has not answered by then is
 * "missing" (timeout). Never throws; each source answers on its own, "missing" with the reason
 * when it has nothing.
 */
export async function collectPrimarySources(
  track: TrackRef,
  options: { now?: Clock; signal?: AbortSignal; deadlineMs?: number } = {},
): Promise<PrimarySources> {
  const deadline = AbortSignal.timeout(options.deadlineMs ?? PRIMARY_SOURCES_DEADLINE_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const run = { now: options.now, signal };

  let resolved: IdentityResolution | undefined;
  const resolution = await settle<never>("musicbrainz", async () => {
    resolved = await resolveIdentity(track, run);
    return resolved.result;
  });
  const base: IdentityResolution = resolved ?? {
    identity: null,
    details: null,
    work: null,
    workError: null,
    result: resolution,
  };
  const { identity } = base;
  const unidentified = <T>(source: SourceId, configured: boolean, variable: string | null) =>
    !configured && variable
      ? notConfigured<T>(source, variable)
      : missing<T>(source, "no MusicBrainz recording identified for the track");
  const trackIsOriginal = identity?.original.original ?? false;

  const [musicbrainz, discogs, genius, secondhandsongs] = await Promise.all([
    settle("musicbrainz", () => musicBrainzRelationships(base, run)),
    settle("discogs", async () =>
      !identity
        ? unidentified<DiscogsCredit>("discogs", discogsConfigured(), DISCOGS_TOKEN)
        : identity.releasesError && discogsConfigured()
          ? missing<DiscogsCredit>("discogs", identity.releasesError)
          : discogsTrackCredits(track, identity.discogsReleaseIds, {
              ...run,
              note: identity.releasesNote,
            }),
    ),
    settle("genius", async () =>
      !identity
        ? unidentified<GeniusRelationship>("genius", geniusConfigured(), GENIUS_ACCESS_TOKEN)
        : geniusRelationships(track, identity.geniusUrl, { ...run, trackIsOriginal }),
    ),
    settle("secondhandsongs", async () =>
      !identity
        ? unidentified<ShsRelationship>("secondhandsongs", true, null)
        : shsRelationships(track, identity.shsLinks, { ...run, trackIsOriginal }),
    ),
  ]);
  const results = [musicbrainz, discogs, genius, secondhandsongs];
  const seen = new Set<string>();
  const evidence = results
    .flatMap((r) => (r.status === "found" ? r.evidence : []))
    .filter((e) => !seen.has(e.id) && Boolean(seen.add(e.id)));
  return {
    identity,
    musicbrainz,
    discogs,
    genius,
    secondhandsongs,
    evidence,
    accuracy: identityAccuracy(results),
  };
}

/** The identity chain and primary sources as an agent tool; the result is JSON. */
export const primarySourcesTool = tool(
  async ({ isrc, title, artists, durationMs }): Promise<string> =>
    JSON.stringify(
      await collectPrimarySources({ isrc, title, artists, durationMs: durationMs ?? null }),
    ),
  {
    name: "primary_sources",
    description:
      "Structured records for a track from MusicBrainz, Discogs, SecondHandSongs and Genius, " +
      "reached from its ISRC: samples, covers, remixes and credits, each with evidence. A " +
      "record marked about the work is a fact about the song, not about this recording. A " +
      "source without a verified record is reported as missing, with the reason.",
    schema: z.object({
      isrc: z.string().describe("The track's ISRC"),
      title: z.string().describe("The track title"),
      artists: z.array(z.string()).min(1).describe("The track's credited artists, one by one"),
      durationMs: z.number().nullable().optional().describe("The track's duration in ms"),
    }),
  },
);
