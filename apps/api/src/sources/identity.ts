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
 * matched, rejected or could not find, and how often it could not be asked at all (not
 * configured, failed, timed out: "unavailable") (`accuracy`).
 */

import { tool } from "@langchain/core/tools";
import type { Evidence, SourceError as SourceErrorRecord, SourceId } from "@liner-notes/contract";
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
  NOT_ORIGINAL_RELEASE_TYPES,
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
  readFailure,
  scopedRef,
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
  /** The Discogs source's error when the releases could not be read (short and scrubbed). */
  releasesFailure: SourceErrorRecord | null;
  /** Set when not every release of the recording could be read. */
  releasesNote: string | null;
  /** The Genius page linked from the recording's work; null when none or several. */
  geniusUrl: string | null;
  /** Every Genius page linked from the recording's works. */
  geniusPages: string[];
  shsLinks: ShsLink[];
}

export type IdentityResolution =
  | {
      identity: PrimaryIdentity;
      details: MbRecordingDetails;
      /** The work with its recordings, when the recording performs exactly one. */
      work: MbWork | null;
      workError: string | null;
      /** The work read's failure, for the run's source errors (its covers are missing). */
      workFailure: SourceErrorRecord | null;
      result: SourceResult<never>;
    }
  | {
      identity: null;
      details: null;
      work: null;
      workError: null;
      workFailure: null;
      result: SourceResult<never>;
    };

const creditedArtists = (r: MbRecordingSummary) =>
  (Array.isArray(r["artist-credit"]) ? r["artist-credit"] : []).map((c) => ({
    names: [c.name, c.artist?.name ?? ""].filter(Boolean),
  }));

/** A duration that can be compared: a positive, finite number of milliseconds. */
const knownMs = (ms: unknown): ms is number =>
  typeof ms === "number" && Number.isFinite(ms) && ms > 0;

const lengthOf = (r: MbRecordingSummary) => (knownMs(r.length) ? r.length : null);

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
  const wanted = track.durationMs;
  if (!chosen && knownMs(wanted)) {
    const distance = (r: MbRecordingSummary) => {
      const length = lengthOf(r);
      return length === null ? Number.POSITIVE_INFINITY : Math.abs(length - wanted);
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

/** A release date as a sort key; a bare year or month sorts after the dated days in it. */
function dateKey(date: string | undefined): string {
  if (!date) return "9999-99-99";
  const [year, month = "99", day = "99"] = date.split("-");
  return `${year}-${month}-${day}`;
}

/**
 * The Discogs release ids linked from the recording's releases: original releases only (not a
 * compilation, live, DJ-mix or remix release), earliest first.
 */
export function discogsCandidates(releases: MbReleaseSummary[]): number[] {
  const originals = releases
    .filter((r) => {
      const secondary = r["release-group"]?.["secondary-types"] ?? [];
      return !secondary.some((t) => NOT_ORIGINAL_RELEASE_TYPES.has(String(t).toLowerCase()));
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
  const addShs = (url: string, from: ShsLink["from"]) => {
    const link = shsLink(url, from);
    if (link && !shs.some((l) => l.kind === link.kind && l.id === link.id)) shs.push(link);
  };
  const list = <T>(v: T[] | undefined) => (Array.isArray(v) ? v : []);
  for (const rel of list(details.relations)) {
    if (rel?.type === "secondhandsongs" && rel.url) addShs(rel.url.resource, "recording");
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
        addShs(link.url.resource, "work");
      }
    }
  }
  const geniusPages = [...genius];
  return {
    works,
    geniusPages,
    geniusUrl: geniusPages.length === 1 ? geniusPages[0] : null,
    shsLinks: shs,
  };
}

/** Performance attributes that make a recording something other than the song's original. */
const DERIVED_ATTRIBUTES = ["cover", "live", "medley", "partial", "instrumental", "karaoke"];

/** A release date as its parts, at the precision MusicBrainz has it; null when absent. */
function dateParts(date: string | undefined): number[] | null {
  const match = date?.trim().match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/);
  if (!match) return null;
  return match
    .slice(1)
    .filter((p) => p !== undefined)
    .map(Number);
}

/**
 * -1 when `a` is certainly before `b`, 1 when certainly after, 0 when their order cannot be
 * told: equal as far as the less precise of the two goes ("1990" and "1990-09-04").
 */
function compareDates(a: number[], b: number[]): -1 | 0 | 1 {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Why the recording is not the song's original, from the recording alone; null when it may be
 * and only the work's dated recordings can tell.
 */
function ruledOut(
  details: MbRecordingDetails,
  works: PrimaryIdentity["works"],
): PrimaryIdentity["original"] | null {
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
  return null;
}

/**
 * Whether the matched recording is the original recording of the song it performs, so that the
 * song's covers, samples and other work-level relationships can be claimed for it. It is when
 * it performs one work, without a cover, live, medley, partial, instrumental or karaoke
 * attribute, without a disambiguation comment ("radio edit", "live, 1995"), under the work's
 * title (not "(Taylor's Version)"), the work's recordings as read include it, and every other
 * recording of the work was first released certainly later: dates are compared as far as both
 * are precise, so a recording dated only "1990", or an undated one under the work's title,
 * cannot be shown to come after one from 1990-09-04. A cover certainly released earlier also
 * answers no (the song existed before this recording); undated covers and recordings titled
 * otherwise (remixes, edits) are not candidates. Anything unknown answers no: a re-recording,
 * live version or edit never inherits the song's relationships.
 */
export function originalPerformance(
  details: MbRecordingDetails,
  works: PrimaryIdentity["works"],
  workRecordings: { recordings: MbRecordingSummary[]; total: number } | null,
  coverIds: ReadonlySet<string> = new Set(),
): PrimaryIdentity["original"] {
  const out = ruledOut(details, works);
  if (out) return out;
  const [work] = works;
  if (!workRecordings) {
    return { original: false, reason: `the recordings of "${work.title}" could not be dated` };
  }
  const ownDate = details["first-release-date"]?.trim() ?? "";
  const own = dateParts(ownDate);
  if (!own) return { original: false, reason: "the recording has no release date" };
  // An answer that does not list the recording itself is not the work's list (an empty or
  // inconsistent answer): nothing can be compared.
  if (!workRecordings.recordings.some((r) => r?.id === details.id)) {
    return {
      original: false,
      reason: `the recordings read for "${work.title}" do not include this one`,
    };
  }
  let earliest: { r: MbRecordingSummary; parts: number[] } | null = null;
  let earlierCover: { r: MbRecordingSummary; parts: number[] } | null = null;
  let undated = 0;
  let unordered = 0;
  for (const r of workRecordings.recordings) {
    if (!r || r.id === details.id) continue;
    const parts = dateParts(r["first-release-date"]);
    if (coverIds.has(r.id)) {
      // A cover certainly released before this recording means the song existed before it.
      // An undated cover, or one dated like this recording, says nothing.
      if (parts && compareDates(parts, own) < 0) {
        if (!earlierCover || compareDates(parts, earlierCover.parts) < 0) {
          earlierCover = { r, parts };
        }
      }
      continue;
    }
    if (!parts) {
      // An undated recording titled otherwise ("Remix", "Edit") is a version made from the
      // song, not a candidate for its first recording.
      const credited = creditedArtists(r).map((a) => a.names[0]);
      if (titlesMatch(r.title ?? "", work.title, credited)) undated++;
      continue;
    }
    const order = compareDates(parts, own);
    if (order === 0) unordered++;
    if (order < 0 && (!earliest || compareDates(parts, earliest.parts) < 0)) {
      earliest = { r, parts };
    }
  }
  if (earliest) {
    return {
      original: false,
      reason: `${quoted(earliest.r.title, creditString(earliest.r["artist-credit"]))} was released in ${earliest.r["first-release-date"]}, before this recording (${ownDate})`,
    };
  }
  if (earlierCover) {
    return {
      original: false,
      reason: `a cover of "${work.title}" (${quoted(earlierCover.r.title, creditString(earlierCover.r["artist-credit"]))}) was released in ${earlierCover.r["first-release-date"]}, before this recording (${ownDate})`,
    };
  }
  if (undated > 0) {
    return {
      original: false,
      reason: `${undated} recordings of "${work.title}" have no release date: this one cannot be shown to be the earliest`,
    };
  }
  if (unordered > 0) {
    return {
      original: false,
      reason: `${unordered} recordings of "${work.title}" are dated like this one (${ownDate}) as far as the dates go: the earliest cannot be told`,
    };
  }
  if (workRecordings.total > workRecordings.recordings.length) {
    return {
      original: false,
      reason: `only ${workRecordings.recordings.length} of the ${workRecordings.total} recordings of "${work.title}" could be compared`,
    };
  }
  return { original: true, reason: `the earliest release of "${work.title}" (${ownDate})` };
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
    workFailure: null,
    result,
  });
  try {
    const isrc = normalizeIsrc(track?.isrc);
    if (!isrc) return none(missing("musicbrainz", "the track has no valid ISRC"));
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
    let releasesFailure: SourceErrorRecord | null = null;
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
      releasesFailure = readFailure("discogs", error);
    }

    const links = linksOf(details);
    let work: MbWork | null = null;
    let workError: string | null = null;
    let workFailure: SourceErrorRecord | null = null;
    let original =
      ruledOut(details, links.works) ?? originalPerformance(details, links.works, null);
    const needsDates = ruledOut(details, links.works) === null;
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
        // Dating the work's recordings costs requests; only when nothing else rules it out.
        if (needsDates) {
          original = originalPerformance(
            details,
            links.works,
            await browseWorkRecordings(only.mbid, 2, signal),
            coverIds,
          );
        }
      } catch (error) {
        workError = `the work "${only.title}" could not be read: ${describeError(error)}`;
        workFailure = readFailure("musicbrainz", error);
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
      releasesFailure,
      releasesNote,
      original,
      ...links,
    };
    return {
      identity,
      details,
      work,
      workError,
      workFailure,
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
      recordRef: scopedRef("track", `recording/${recording.mbid}`),
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
      // A cover of the work: stated about the work, on the work's page, and scoped to the track
      // only when the track is the work's original recording.
      const ref =
        r.about === "track"
          ? `recording/${recording.mbid}/covered-by/recording/${r.recording?.mbid}`
          : `${r.work.mbid}/covered-by/recording/${r.recording?.mbid}`;
      evidence.push(
        primaryEvidence({
          source: "musicbrainz",
          recordRef: scopedRef(r.about, ref),
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
        recordRef: scopedRef("track", `recording/${recording.mbid}/${r.kind}/${otherRef}`),
        url: page,
        title: `${recording.title} — MusicBrainz relationships`,
        excerpt: `MusicBrainz: ${own} ${RELATION_PHRASE[r.kind]} ${other}.`,
        retrievedAt: at,
      }),
    );
  }
  // evidence[0] is the recording itself; each record's item follows in order.
  kept.forEach((r, i) => {
    r.evidenceId = evidence[i + 1].id;
  });
  if (records.length > kept.length) notes.push(`${records.length - kept.length} more not listed`);
  return found("musicbrainz", kept, evidence, {
    omitted: result.omitted,
    incomplete: notes.length > 0 ? notes.join("; ") : null,
    error: resolution.workFailure,
  });
}

export interface PrimarySources {
  identity: PrimaryIdentity | null;
  musicbrainz: SourceResult<MbRelationship>;
  discogs: SourceResult<DiscogsCredit>;
  genius: SourceResult<GeniusRelationship>;
  secondhandsongs: SourceResult<ShsRelationship>;
  /**
   * Every Evidence item the sources produced. Ids are unique: each starts with its source and
   * each source names every item once. The recordRef's first segment is its scope
   * (`evidenceScope`): "work" items state facts about the song, never about this recording.
   */
  evidence: Evidence[];
  /** Per source: records matched, rejected by a check, not found, or the source unavailable. */
  accuracy: Partial<Record<SourceId, IdentityCounts>>;
}

/** The longest a whole run may take, all sources together, and the longest it may be set to. */
export const PRIMARY_SOURCES_DEADLINE_MS = 20_000;
const MAX_DEADLINE_MS = 120_000;

/** A deadline in ms: the default when not a positive number, and at most two minutes. */
function deadlineOf(ms: number | undefined): number {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) {
    return PRIMARY_SOURCES_DEADLINE_MS;
  }
  return Math.min(Math.ceil(ms), MAX_DEADLINE_MS);
}

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
 * `deadlineMs` (default 20 s, at most 2 min) or until `signal` aborts; whatever has not
 * answered by the deadline is "missing" (timeout), and what the caller cancelled is "missing"
 * (unavailable). Never throws; each source answers on its own, "missing" with the reason when it
 * has nothing.
 */
export async function collectPrimarySources(
  track: TrackRef,
  options: { now?: Clock; signal?: AbortSignal; deadlineMs?: number } = {},
): Promise<PrimarySources> {
  const deadline = AbortSignal.timeout(deadlineOf(options.deadlineMs));
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
    workFailure: null,
    result: resolution,
  };
  const { identity } = base;
  // When MusicBrainz itself could not be read, the others could not be asked either: unavailable,
  // not an identity miss.
  const upstream = base.result.status === "missing" ? base.result.error : null;
  const unidentified = <T>(source: SourceId, configured: boolean, variable: string | null) =>
    !configured && variable
      ? notConfigured<T>(source, variable)
      : upstream
        ? missing<T>(source, "MusicBrainz could not be read, so the track has no identity", {
            error: { source, code: "unavailable", message: upstream.message },
          })
        : missing<T>(source, "no MusicBrainz recording identified for the track");
  const trackIsOriginal = identity?.original.original ?? false;

  const discogs = (): Promise<SourceResult<DiscogsCredit>> | SourceResult<DiscogsCredit> => {
    if (!identity) return unidentified("discogs", discogsConfigured(), DISCOGS_TOKEN);
    if (identity.releasesError && discogsConfigured()) {
      // The releases' failure is this source's error too (a deadline reaches the run's errors).
      return missing("discogs", identity.releasesError, {
        error: identity.releasesFailure,
      });
    }
    return discogsTrackCredits(track, identity.discogsReleaseIds, {
      ...run,
      note: identity.releasesNote,
    });
  };
  const genius = ():
    | Promise<SourceResult<GeniusRelationship>>
    | SourceResult<GeniusRelationship> => {
    if (!identity) return unidentified("genius", geniusConfigured(), GENIUS_ACCESS_TOKEN);
    if (identity.geniusPages.length > 1 && geniusConfigured()) {
      return missing(
        "genius",
        `MusicBrainz links ${identity.geniusPages.length} Genius pages to the recording's works; none is taken`,
      );
    }
    return geniusRelationships(track, identity.geniusUrl, { ...run, trackIsOriginal });
  };

  const results = await Promise.all([
    settle("musicbrainz", () => musicBrainzRelationships(base, run)),
    settle("discogs", async () => discogs()),
    settle("genius", async () => genius()),
    settle("secondhandsongs", async () =>
      !identity
        ? unidentified<ShsRelationship>("secondhandsongs", true, null)
        : shsRelationships(track, identity.shsLinks, { ...run, trackIsOriginal }),
    ),
  ]);
  const [musicbrainz, discogsResult, geniusResult, secondhandsongs] = results;
  return {
    identity,
    musicbrainz,
    discogs: discogsResult,
    genius: geniusResult,
    secondhandsongs,
    evidence: results.flatMap((r) => (r.status === "found" ? r.evidence : [])),
    accuracy: identityAccuracy(results),
  };
}

/**
 * The identity chain and primary sources as an agent tool; the result is JSON. The run stops
 * when the agent's call is cancelled (`config.signal`).
 */
export const primarySourcesTool = tool(
  async ({ isrc, title, artists, durationMs }, config): Promise<string> =>
    JSON.stringify(
      await collectPrimarySources(
        { isrc, title, artists, durationMs: durationMs ?? null },
        { signal: config?.signal },
      ),
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
      durationMs: z
        .number()
        .positive()
        .nullable()
        .optional()
        .describe("The track's duration in ms"),
    }),
  },
);
