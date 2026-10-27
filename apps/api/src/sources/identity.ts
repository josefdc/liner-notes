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

import type { Evidence, SourceError as SourceErrorRecord, SourceId } from "@liner-notes/contract";
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
import { pacingClock } from "./pacing.js";
import {
  browseRecordingReleases,
  browseWorkRecordings,
  creditString,
  getRecordingDetails,
  getWorkRecordings,
  isMbid,
  knownReleaseDate,
  lookupIsrc,
  type MbRecordingDetails,
  type MbRecordingSummary,
  type MbRelatedRecording,
  type MbRelationship,
  type MbReleaseSummary,
  type MbSampleHop,
  type MbWork,
  NOT_ORIGINAL_RELEASE_TYPES,
  normalizeIsrc,
  normalizeName,
  RECORDING_DATES_MAX,
  RELEASE_DATE,
  recordingRelationships,
  recordingReleaseDates,
  sampleHopOf,
  secondHopRelationships,
  withMusicBrainzPriority,
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
  errorRecord,
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
  /**
   * The release whose cover a recorded run may link to (`pickCoverRelease`); null when the
   * releases could not be read or none qualifies.
   */
  coverRelease: CoverRelease | null;
  /** Why the recording's releases could not be read (then no release is named); else null. */
  coverReleaseError: string | null;
  /** The Genius page linked from the recording's work; null when none or several. */
  geniusUrl: string | null;
  /** Every Genius page linked from the recording's works. */
  geniusPages: string[];
  shsLinks: ShsLink[];
}

/**
 * The recording the track's ISRC identified, once the lookup of the recording itself passed the
 * identity checks: what the rest of the run reads from MusicBrainz about it (the composer's
 * recording, the researcher's artist), so no other step looks the ISRC up again.
 */
export interface IdentifiedRecording {
  mbid: string;
  title: string;
  /** The artist credit as MusicBrainz writes it ("Coolio feat. L.V."). */
  artist: string;
  lengthMs: number | null;
  firstReleaseDate: string | null;
  /** The credited artists one by one: their MusicBrainz id and name, and the name as credited. */
  artists: Array<{ mbid: string; name: string; credited: string }>;
}

/** The identified recording as the rest of the run reads it. */
export function identifiedRecording(details: MbRecordingDetails): IdentifiedRecording {
  const credits = Array.isArray(details["artist-credit"]) ? details["artist-credit"] : [];
  return {
    mbid: details.id,
    title: details.title,
    artist: creditString(details["artist-credit"]),
    lengthMs: lengthOf(details),
    firstReleaseDate: details["first-release-date"]?.trim() || null,
    artists: credits.flatMap((c) =>
      c?.artist && isMbid(c.artist.id) && typeof c.artist.name === "string"
        ? [
            {
              mbid: c.artist.id,
              name: c.artist.name,
              credited: typeof c.name === "string" ? c.name : c.artist.name,
            },
          ]
        : [],
    ),
  };
}

export type IdentityResolution =
  | {
      identity: PrimaryIdentity;
      details: MbRecordingDetails;
      /** The work with its recordings, when the recording performs exactly one. */
      work: MbWork | null;
      /** A note on the work: it could not be read, or its recordings could not be dated. */
      workError: string | null;
      /** The work read's failure, for the run's source errors (its covers are missing). */
      workFailure: SourceErrorRecord | null;
      /**
       * The first release dates of the work's recordings, by MBID, when they were read to date
       * the recording (only the known ones): a cover's year for the relations map.
       */
      workDates?: ReadonlyMap<string, string>;
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

/**
 * A release date as a sort key; a bare year or month sorts after the dated days in it, and
 * anything that is not a date (missing, padded, "1990-9-4") sorts as undated, last.
 */
function dateKey(date: string | undefined): string {
  if (typeof date !== "string" || !RELEASE_DATE.test(date)) return "9999-99-99";
  const [year, month = "99", day = "99"] = date.split("-");
  return `${year}-${month}-${day}`;
}

/** Plain string order, the same in every locale. */
const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A release the recording is on, as the evidence names it. */
export interface CoverRelease {
  mbid: string;
  title: string;
  /** "album", "ep" or "single". */
  type: CoverReleaseType;
  date: string | null;
}

type CoverReleaseType = "album" | "ep" | "single";

const RELEASE_TYPE_WORD: Record<CoverReleaseType, string> = {
  album: "album",
  ep: "EP",
  single: "single",
};

const COVER_RELEASE_RANK: Record<CoverReleaseType, number> = { album: 0, ep: 1, single: 2 };

const coverReleaseType = (release: MbReleaseSummary): CoverReleaseType | null => {
  const type = String(release["release-group"]?.["primary-type"] ?? "").toLowerCase();
  return type === "album" || type === "ep" || type === "single" ? type : null;
};

/**
 * The one release of the recording that stands for it, for its cover: an official release
 * (not a compilation, live, DJ-mix or remix release) of type album, EP or single for which the
 * Cover Art Archive holds a front image (`cover-art-archive.front` in MusicBrainz's answer).
 * Among those: one titled as the album the track is shown with (`album`, compared as names
 * are), then an album before an EP before a single, then the earliest dated (undated last),
 * then the lowest MBID. Null when none qualifies: a release without a front image is never
 * named for a cover. The same list always gives the same release, whatever its order.
 */
export function pickCoverRelease(
  releases: readonly MbReleaseSummary[],
  album?: string | null,
): CoverRelease | null {
  const shown = typeof album === "string" ? normalizeName(album) : "";
  const sameAlbum = (release: MbReleaseSummary) =>
    shown !== "" && normalizeName(release.title) === shown;
  const order = (a: Candidate, b: Candidate) =>
    Number(b.sameAlbum) - Number(a.sameAlbum) ||
    COVER_RELEASE_RANK[a.type] - COVER_RELEASE_RANK[b.type] ||
    byCodePoint(dateKey(a.release.date), dateKey(b.release.date)) ||
    byCodePoint(a.release.id.toLowerCase(), b.release.id.toLowerCase());
  type Candidate = { release: MbReleaseSummary; type: CoverReleaseType; sameAlbum: boolean };
  let best: Candidate | null = null;
  const list: readonly MbReleaseSummary[] = Array.isArray(releases) ? releases : [];
  for (const release of list) {
    if (!release || !isMbid(release.id) || typeof release.title !== "string") continue;
    if (!release.title.trim()) continue;
    if (String(release.status ?? "").toLowerCase() !== "official") continue;
    if (release["cover-art-archive"]?.front !== true) continue;
    const secondary = release["release-group"]?.["secondary-types"] ?? [];
    if (secondary.some((t) => NOT_ORIGINAL_RELEASE_TYPES.has(String(t).toLowerCase()))) continue;
    const type = coverReleaseType(release);
    if (!type) continue;
    const candidate = { release, type, sameAlbum: sameAlbum(release) };
    if (!best || order(candidate, best) < 0) best = candidate;
  }
  if (!best) return null;
  return {
    mbid: best.release.id.toLowerCase(),
    title: best.release.title.trim(),
    type: best.type,
    date: RELEASE_DATE.test(best.release.date ?? "") ? (best.release.date as string) : null,
  };
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
    .sort((a, b) => byCodePoint(dateKey(a.date), dateKey(b.date)) || byCodePoint(a.id, b.id));
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
 * from and whether it is the song's original recording. Never throws. `onRecording` is told the
 * recording as soon as its lookup passed the checks, before the releases and the work are read.
 * With Discogs configured, the recording's releases are read here, once, for their Discogs links
 * and the release that stands for the recording; without it, `readCoverRelease` reads them.
 */
export async function resolveIdentity(
  track: TrackRef,
  options: {
    signal?: AbortSignal;
    /**
     * Stops the dating of the work's recordings (default `signal`): the chain's last reads,
     * and the only ones whose loss loses no record, cut early enough for the other sources.
     */
    datingSignal?: AbortSignal;
    onRecording?: (recording: IdentifiedRecording) => void;
  } = {},
): Promise<IdentityResolution> {
  const { signal } = options;
  const datingSignal = options.datingSignal ?? signal;
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
      throw unexpectedShape("musicbrainz", "the recording lookup is not a recording", details);
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
    options.onRecording?.(identifiedRecording(details));

    let discogsReleaseIds: number[] = [];
    let releasesError: string | null = null;
    let releasesFailure: SourceErrorRecord | null = null;
    let releasesNote: string | null = null;
    let coverRelease: CoverRelease | null = null;
    let coverReleaseError: string | null = null;
    // With Discogs configured, the recording's releases are read here, once, before the work:
    // for their Discogs links (Discogs is asked from them) and for the release that stands for
    // the recording (its cover in a recorded run). Without Discogs, `readCoverRelease` reads them
    // after the chain, alongside the other sources.
    const readReleases = async (pages: number, readSignal: AbortSignal | undefined) => {
      try {
        const read = await browseRecordingReleases(details.id, pages, readSignal);
        coverRelease = pickCoverRelease(read.releases, track.album);
        return read;
      } catch (error) {
        coverReleaseError = describeError(error);
        throw error;
      }
    };
    if (discogsConfigured()) {
      try {
        const { releases, total } = await readReleases(2, signal);
        // Sorted before the Discogs source takes the first few.
        discogsReleaseIds = discogsCandidates(releases);
        if (total > releases.length) {
          releasesNote = `only ${releases.length} of the recording's ${total} releases were read for Discogs links`;
        }
      } catch (error) {
        releasesError = `MusicBrainz releases could not be read: ${describeError(error)}`;
        releasesFailure = errorRecord("discogs", error);
      }
    }

    const links = linksOf(details);
    let work: MbWork | null = null;
    let workError: string | null = null;
    let workFailure: SourceErrorRecord | null = null;
    let original =
      ruledOut(details, links.works) ?? originalPerformance(details, links.works, null);
    const needsDates = ruledOut(details, links.works) === null;
    const workDates = new Map<string, string>();
    // The covers of the work are read only for a recording that is not itself a cover.
    if (links.works.length === 1 && !links.works[0].cover) {
      const [only] = links.works;
      try {
        work = await getWorkRecordings(only.mbid, signal);
      } catch (error) {
        // The work's covers are lost: the run's error, so it is not kept as complete.
        workError = `the work "${only.title}" could not be read: ${describeError(error)}`;
        workFailure = errorRecord("musicbrainz", error);
      }
      // Dating the work's recordings costs requests; only when nothing else rules it out. When
      // they cannot be dated, nothing is lost: the recording is not shown to be the original, so
      // the work's covers stay about the work, and a note says so.
      if (work && needsDates) {
        const coverIds = new Set(
          (Array.isArray(work.relations) ? work.relations : [])
            .filter((r) => (r?.attributes ?? []).includes("cover") && r.recording)
            .map((r) => r.recording?.id as string),
        );
        try {
          const dated = await browseWorkRecordings(only.mbid, 2, datingSignal);
          original = originalPerformance(details, links.works, dated, coverIds);
          for (const r of dated.recordings) {
            const date = knownReleaseDate(r?.["first-release-date"]);
            if (date && isMbid(r.id)) workDates.set(r.id, date);
          }
        } catch (error) {
          workError = `${DATES_INCOMPLETE}the recordings of the work "${only.title}" could not be dated (${describeError(error)}), so its covers are not claimed for this recording`;
        }
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
      coverRelease,
      coverReleaseError,
      original,
      ...links,
    };
    return {
      identity,
      details,
      work,
      workError,
      workFailure,
      workDates,
      result: found("musicbrainz", [], [], { omitted: pick.omitted }),
    };
  } catch (error) {
    return none(failed("musicbrainz", error));
  }
}

/**
 * Without Discogs: reads one page of the recording's official releases for the release that
 * stands for it (`pickCoverRelease`) and sets `identity.coverRelease`, or `coverReleaseError`
 * when the read fails (the MusicBrainz result then notes it: no record, no source error).
 * `collectPrimarySources` runs it alongside Genius and SecondHandSongs, on the dating signal,
 * so it never delays them, the work or its dating. Never throws.
 */
export async function readCoverRelease(
  identity: PrimaryIdentity,
  album: string | null | undefined,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const { releases } = await browseRecordingReleases(identity.recording.mbid, 1, signal);
    identity.coverRelease = pickCoverRelease(releases, album);
  } catch (error) {
    identity.coverReleaseError = describeError(error);
  }
}

const minutes = (ms: number | null) => {
  if (ms === null) return "";
  const s = Math.round(ms / 1000);
  return ` (${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")})`;
};

/**
 * The matched recording's relationships as MusicBrainz files them: its own samples, remixes and
 * covers, then the covers of the song it performs (about the track only when it is the song's
 * original recording). Empty without an identified recording.
 */
function relationshipRecords(resolution: IdentityResolution): MbRelationship[] {
  const { identity, details } = resolution;
  if (!identity || !details) return [];
  const records = recordingRelationships(details);
  const [work] = identity.works;
  if (resolution.work && work && !work.cover) {
    const about = identity.original.original ? "track" : "work";
    for (const cover of workCovers(resolution.work, identity.recording.mbid)) {
      records.push({ ...cover, about });
    }
  }
  return records;
}

/**
 * What the relations map adds to the matched recording's relationships (`readRelationsMap`):
 * the second hop's records, and the first release dates MusicBrainz files for the recordings
 * at either end, by MBID (only the known ones).
 */
export interface RelationsMap {
  hops: MbRelationship[];
  dates: ReadonlyMap<string, string>;
}

/**
 * The per-recording MusicBrainz cache the relations map reads through (store/cache.ts
 * `SonicCache`): a recording's sample relationships and its first release date. A hit makes no
 * request.
 */
export interface RecordingCache {
  getMbHop(mbid: string): MbSampleHop | null;
  putMbHop(mbid: string, hop: MbSampleHop): void;
  getMbDate(mbid: string): { date: string | null } | null;
  putMbDate(mbid: string, date: string | null): void;
}

/** The most recordings the map reads a second hop from: one recording lookup each, at most. */
export const MAP_HOP_SOURCES = 2;
/** The most second-hop records the map keeps from each of them. */
export const MAP_HOP_RECORDS = 6;

/** A cache call that cannot fail the map: a broken cache is a miss, and a lost write is lost. */
function quietly<T>(call: () => T): T | null {
  try {
    return call();
  } catch {
    return null;
  }
}

/**
 * Reads what the relations map adds to the matched recording's relationships, within the
 * chain's time, through `cache` when given (a hit makes no request; what is read is stored):
 * - the second hop: the first MAP_HOP_SOURCES recordings it samples are looked up (one request
 *   each), for what each of them samples and the other recordings that sample it (its
 *   siblings), at most MAP_HOP_RECORDS of each source;
 * - the first release dates of the recordings at either end, for the nodes' years: a hop
 *   source's own, the work's dated recordings (`workDates`), the cache's, and then one search
 *   by recording id for the rest (`recordingReleaseDates`). A recording MusicBrainz does not
 *   date stays undated.
 * A request starts only while `signal` has not aborted and the pacing clock is at most
 * `notAfter`; one that fails, or that the signal stops, is dropped quietly: no record, no error,
 * and a later run asks again. Never throws.
 */
export async function readRelationsMap(
  resolution: IdentityResolution,
  options: { signal?: AbortSignal; notAfter: number; cache?: RecordingCache | null },
): Promise<RelationsMap> {
  const dates = new Map<string, string>();
  const { identity } = resolution;
  if (!identity) return { hops: [], dates };
  const { signal, notAfter, cache } = options;
  const timeLeft = () => !signal?.aborted && pacingClock() <= notAfter;
  const own = identity.recording.mbid;
  const records = relationshipRecords(resolution).slice(0, MAX_RECORDS);

  const hops: MbRelationship[] = [];
  const sources = [
    ...new Set(
      records.flatMap((r) =>
        r.about === "track" && r.kind === "samples" && r.recording ? [r.recording.mbid] : [],
      ),
    ),
  ].slice(0, MAP_HOP_SOURCES);
  for (const source of sources) {
    let hop = cache ? quietly(() => cache.getMbHop(source)) : null;
    if (!hop && timeLeft()) {
      try {
        hop = sampleHopOf(await getRecordingDetails(source, signal));
        const read = hop;
        if (read && cache) quietly(() => cache.putMbHop(source, read));
      } catch {
        hop = null;
      }
    }
    if (!hop) continue;
    if (hop.recording.firstReleaseDate) dates.set(source, hop.recording.firstReleaseDate);
    hops.push(...secondHopRelationships(hop, own).slice(0, MAP_HOP_RECORDS));
  }

  // The recordings a node can stand for: this one's own relations (a cover of the song alone
  // is never drawn) and the second hop's.
  const ends = [...records.filter((r) => r.about === "track"), ...hops].flatMap((r) => [
    ...(r.recording ? [r.recording] : []),
    ...(r.via ? [r.via] : []),
  ]);
  const undated = new Set<string>();
  for (const end of ends) {
    const date =
      knownReleaseDate(end.firstReleaseDate) ?? resolution.workDates?.get(end.mbid) ?? null;
    if (date && !dates.has(end.mbid)) dates.set(end.mbid, date);
  }
  const unknown = [...new Set(ends.map((end) => end.mbid))].filter((mbid) => !dates.has(mbid));
  for (const mbid of unknown) {
    const cached = cache ? quietly(() => cache.getMbDate(mbid)) : null;
    if (!cached) continue;
    if (cached.date) dates.set(mbid, cached.date);
    else undated.add(mbid);
  }
  const ask = unknown
    .filter((mbid) => !dates.has(mbid) && !undated.has(mbid))
    .slice(0, RECORDING_DATES_MAX);
  if (ask.length > 0 && timeLeft()) {
    try {
      const read = await recordingReleaseDates(ask, signal);
      for (const mbid of ask) {
        const date = read.get(mbid.toLowerCase()) ?? null;
        if (date) dates.set(mbid, date);
        if (cache) quietly(() => cache.putMbDate(mbid, date));
      }
    } catch {
      // Dropped quietly: the nodes stay undated, and a later run asks again.
    }
  }
  return { hops, dates };
}

/** A related recording with its first release date from the map, when the map dates it. */
function dated(
  recording: MbRelatedRecording,
  dates: ReadonlyMap<string, string> | undefined,
): MbRelatedRecording {
  const { firstReleaseDate, ...rest } = recording;
  const date = knownReleaseDate(firstReleaseDate) ?? dates?.get(recording.mbid) ?? null;
  return date ? { ...rest, firstReleaseDate: date } : rest;
}

/**
 * The matched recording's samples and remixes, and the covers of the song it performs, from
 * MusicBrainz, with an Evidence item for the recording itself (its ISRC, title, credit and
 * length) and one per relationship. Covers of the work are phrased as covers of the work and
 * link the work's page; they are claimed for the track (`about: "track"`) only when it is the
 * work's original recording. With a relations map (`map`), each related recording carries the
 * first release date MusicBrainz files for it, and the second hop's records follow, each with
 * an item about two other recordings: `recording/<a>/<kind>/recording/<b>`, with no scope, on
 * the page of <a> (the recording the matched one samples).
 */
export async function musicBrainzRelationships(
  resolution: IdentityResolution,
  options: { now?: Clock; map?: RelationsMap } = {},
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
  const records = relationshipRecords(resolution);

  const notes: string[] = [];
  if (resolution.workError) notes.push(resolution.workError);
  if (identity.coverReleaseError) {
    notes.push(
      `${RELEASES_INCOMPLETE}the recording's releases could not be read (${identity.coverReleaseError}), so no release is named for it`,
    );
  }
  const [work] = identity.works;
  if (resolution.work && work && !work.cover && !identity.original.original) {
    notes.push(
      `covers are of the work "${work.title}", not this recording: ${identity.original.reason}`,
    );
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
  const { map } = options;
  const kept = records
    .slice(0, MAX_RECORDS)
    .map((r) => (map && r.recording ? { ...r, recording: dated(r.recording, map.dates) } : r));
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
          recordRef: scopedRef(r.about === "track" ? "track" : "work", ref),
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
  // The release that stands for the recording, after the recording's own items: the one item a
  // recorded run derives its Cover Art Archive link from (replay/recorder.ts).
  const release = identity.coverRelease;
  if (release) {
    const date = release.date ? ` (${release.date})` : "";
    evidence.push(
      primaryEvidence({
        source: "musicbrainz",
        recordRef: scopedRef("release", release.mbid),
        url: `${MB_SITE}/release/${release.mbid}`,
        title: `${release.title} — MusicBrainz release`,
        excerpt: `MusicBrainz: ${own} appears on the official ${RELEASE_TYPE_WORD[release.type]} ${quoted(release.title)}${date}.`,
        retrievedAt: at,
      }),
    );
  }
  // The second hop: relationships between two other recordings, for the relations map only.
  const hops: MbRelationship[] = [];
  const hopRefs = new Set<string>();
  for (const hop of map?.hops ?? []) {
    if (hop.about !== "hop" || !hop.via || !hop.recording) continue;
    const ref = hopRecordRef(hop.via.mbid, hop.kind, hop.recording.mbid);
    if (hopRefs.has(ref)) continue;
    hopRefs.add(ref);
    const via = dated(hop.via, map?.dates);
    const other = dated(hop.recording, map?.dates);
    const item = primaryEvidence({
      source: "musicbrainz",
      recordRef: ref,
      url: `${MB_SITE}/recording/${via.mbid}`,
      title: `${via.title} — MusicBrainz relationships`,
      excerpt: `MusicBrainz: ${quoted(via.title, via.artist)} ${RELATION_PHRASE[hop.kind]} ${quoted(other.title, other.artist)}.`,
      retrievedAt: at,
    });
    evidence.push(item);
    hops.push({ ...hop, evidenceId: item.id, via, recording: other });
  }
  if (records.length > kept.length) notes.push(`${records.length - kept.length} more not listed`);
  return found("musicbrainz", [...kept, ...hops], evidence, {
    omitted: result.omitted,
    incomplete: notes.length > 0 ? notes.join("; ") : null,
    error: resolution.workFailure,
  });
}

/**
 * The recordRef of a second-hop item: a relationship between two recordings other than the
 * matched one (`a` is one it samples), with no scope (it is about neither the track, its song
 * nor a release, and supports no claim).
 */
export function hopRecordRef(a: string, kind: MbRelationship["kind"], b: string): string {
  return `recording/${a}/${kind}/recording/${b}`;
}

/** How the MusicBrainz note starts when the work's recordings could not be dated. */
export const DATES_INCOMPLETE = "dates incomplete: ";

/** How the MusicBrainz note starts when the recording's releases could not be read. */
export const RELEASES_INCOMPLETE = "releases incomplete: ";

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
/**
 * The time the dating of the work's recordings leaves before the deadline (at most a quarter of
 * it) for Discogs, Genius and SecondHandSongs, which are asked after it: a dating cut by the
 * deadline would otherwise take their requests down with it.
 */
export const OTHER_SOURCES_RESERVE_MS = 5000;
/** How long before the deadline a paced request must start (at most a tenth of it). */
export const REQUEST_MARGIN_MS = 1500;

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
 * has nothing. `onRecording` is called once: with the identified recording as soon as it is
 * known, or with null when the chain identified none. Its MusicBrainz requests go ahead of any
 * other in the shared queue (`withMusicBrainzPriority`).
 */
export function collectPrimarySources(
  track: TrackRef,
  options: PrimarySourcesOptions = {},
): Promise<PrimarySources> {
  return withMusicBrainzPriority(() => collectInOrder(track, options));
}

export interface PrimarySourcesOptions {
  now?: Clock;
  signal?: AbortSignal;
  deadlineMs?: number;
  onRecording?: (recording: IdentifiedRecording | null) => void;
  /**
   * Reads the relations map too (`readRelationsMap`: the second hop and the related recordings'
   * first release dates), through `cache` when given, within the time the work's dating has.
   * Absent: the map is not read.
   */
  relationsMap?: { cache?: RecordingCache | null };
}

async function collectInOrder(
  track: TrackRef,
  options: PrimarySourcesOptions,
): Promise<PrimarySources> {
  const deadlineMs = deadlineOf(options.deadlineMs);
  // Timers rather than AbortSignal.timeout: the deadlines follow the process's timers, which a
  // test can drive.
  const deadline = deadlineAfter(deadlineMs);
  const datingCut = deadlineAfter(
    deadlineMs - Math.min(OTHER_SOURCES_RESERVE_MS, Math.floor(deadlineMs / 4)),
  );
  try {
    return await collectWithin(track, options, deadlineMs, deadline.signal, datingCut.signal);
  } finally {
    deadline.clear();
    datingCut.clear();
  }
}

/** A signal that aborts with a TimeoutError after `ms`, and the way to stop its timer. */
function deadlineAfter(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("deadline reached", "TimeoutError")),
    ms,
  );
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

async function collectWithin(
  track: TrackRef,
  options: PrimarySourcesOptions,
  deadlineMs: number,
  deadline: AbortSignal,
  datingCut: AbortSignal,
): Promise<PrimarySources> {
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const datingSignal = AbortSignal.any([signal, datingCut]);
  // A paced request (Discogs, SecondHandSongs) must start early enough to be answered within the
  // deadline; a later slot is not taken, and the source is reported as not asked.
  const started = pacingClock();
  const margin = Math.min(REQUEST_MARGIN_MS, Math.floor(deadlineMs / 10));
  const notAfter = started + deadlineMs - margin;
  // The relations map's requests are the chain's last MusicBrainz reads, cut with the work's
  // dating (`datingSignal`): one starts only early enough to be answered before that cut.
  const mapNotAfter =
    started + deadlineMs - Math.min(OTHER_SOURCES_RESERVE_MS, Math.floor(deadlineMs / 4)) - margin;
  const run = { now: options.now, signal, notAfter };
  let told = false;
  const tell = (recording: IdentifiedRecording | null) => {
    if (told) return;
    told = true;
    options.onRecording?.(recording);
  };

  let resolved: IdentityResolution | undefined;
  const resolution = await settle<never>("musicbrainz", async () => {
    resolved = await resolveIdentity(track, { signal, datingSignal, onRecording: tell });
    return resolved.result;
  });
  tell(null);
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
    // Without Discogs, the release that stands for the recording is read alongside the others.
    settle("musicbrainz", async () => {
      if (identity && !discogsConfigured()) {
        await readCoverRelease(identity, track.album, datingSignal);
      }
      const map =
        identity && options.relationsMap
          ? await readRelationsMap(base, {
              signal: datingSignal,
              notAfter: mapNotAfter,
              cache: options.relationsMap.cache,
            })
          : undefined;
      return musicBrainzRelationships(base, { now: options.now, map });
    }),
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
