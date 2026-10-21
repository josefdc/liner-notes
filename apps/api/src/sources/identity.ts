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
  creditString,
  getRecordingDetails,
  getWorkRecordings,
  lookupIsrc,
  type MbRecordingDetails,
  type MbRecordingSummary,
  type MbRelationship,
  type MbReleaseSummary,
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
} from "./records.js";
import { type ShsLink, type ShsRelationship, shsLink, shsRelationships } from "./shs.js";

const MB_SITE = "https://musicbrainz.org";

/** The matched MusicBrainz recording and the links the other sources start from. */
export interface PrimaryIdentity {
  isrc: string;
  recording: { mbid: string; title: string; artist: string; lengthMs: number | null };
  works: Array<{ mbid: string; title: string; cover: boolean }>;
  /** Discogs releases of the recording, original releases first, earliest first. */
  discogsReleaseIds: number[];
  /** Why no Discogs release could be listed, when the releases could not be read. */
  releasesError: string | null;
  /** The Genius page linked from the recording's work; null when none or several. */
  geniusUrl: string | null;
  shsLinks: ShsLink[];
}

export type IdentityResolution =
  | { identity: PrimaryIdentity; details: MbRecordingDetails; result: SourceResult<never> }
  | { identity: null; details: null; result: SourceResult<never> };

const creditedArtists = (r: MbRecordingSummary) =>
  (r["artist-credit"] ?? []).map((c) => ({
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

/** The works the recording performs, with their Genius and SecondHandSongs links. */
function linksOf(details: MbRecordingDetails) {
  const works: PrimaryIdentity["works"] = [];
  const genius = new Set<string>();
  const shs: ShsLink[] = [];
  const addShs = (url: string) => {
    const link = shsLink(url);
    if (link && !shs.some((l) => l.kind === link.kind && l.id === link.id)) shs.push(link);
  };
  for (const rel of details.relations ?? []) {
    if (rel.type === "secondhandsongs" && rel.url) addShs(rel.url.resource);
    if (rel.type !== "performance" || !rel.work) continue;
    works.push({
      mbid: rel.work.id,
      title: rel.work.title,
      cover: (rel.attributes ?? []).includes("cover"),
    });
    for (const link of rel.work.relations ?? []) {
      if (!link.url) continue;
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

/**
 * ISRC → the MusicBrainz recording that is the track, with the links the other sources start
 * from. Never throws.
 */
export async function resolveIdentity(track: TrackRef): Promise<IdentityResolution> {
  const isrc = normalizeIsrc(track.isrc);
  if (!isrc) {
    return {
      identity: null,
      details: null,
      result: missing("musicbrainz", "the track has no valid ISRC"),
    };
  }
  try {
    const candidates = await lookupIsrc(isrc);
    if (candidates.length === 0) {
      return {
        identity: null,
        details: null,
        result: missing("musicbrainz", `MusicBrainz has no recording with ISRC ${isrc}`),
      };
    }
    const pick = pickRecording(track, candidates);
    if (!pick.recording) {
      return {
        identity: null,
        details: null,
        result: missing("musicbrainz", pick.reason, { omitted: pick.omitted }),
      };
    }
    const details = await getRecordingDetails(pick.recording.id);
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
      return {
        identity: null,
        details: null,
        result: missing("musicbrainz", check.reason, { omitted }),
      };
    }

    let discogsReleaseIds: number[] = [];
    let releasesError: string | null = null;
    try {
      discogsReleaseIds = discogsCandidates((await browseRecordingReleases(details.id)).releases);
    } catch (error) {
      releasesError = `MusicBrainz releases could not be read: ${describeError(error)}`;
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
      ...linksOf(details),
    };
    return { identity, details, result: found("musicbrainz", [], [], { omitted: pick.omitted }) };
  } catch (error) {
    return { identity: null, details: null, result: failed("musicbrainz", error) };
  }
}

const minutes = (ms: number | null) => {
  if (ms === null) return "";
  const s = Math.round(ms / 1000);
  return ` (${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")})`;
};

/**
 * The matched recording's samples, remixes and covers from MusicBrainz, with an Evidence item
 * for the recording itself (its ISRC, title, credit and length) and one per relationship.
 * Covers of the song are read from its work when the recording is not itself a cover.
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

  let incomplete: string | null = null;
  const work = identity.works.length === 1 ? identity.works[0] : null;
  if (work && !work.cover) {
    try {
      records.push(...workCovers(await getWorkRecordings(work.mbid), recording.mbid));
    } catch (error) {
      incomplete = `covers of the work could not be read: ${describeError(error)}`;
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
  if (records.length > kept.length) {
    incomplete = [incomplete, `${records.length - kept.length} more not listed`]
      .filter(Boolean)
      .join("; ");
  }
  return found("musicbrainz", kept, evidence, { omitted: result.omitted, incomplete });
}

export interface PrimarySources {
  identity: PrimaryIdentity | null;
  musicbrainz: SourceResult<MbRelationship>;
  discogs: SourceResult<DiscogsCredit>;
  genius: SourceResult<GeniusRelationship>;
  secondhandsongs: SourceResult<ShsRelationship>;
  /** Every Evidence item the sources produced. */
  evidence: Evidence[];
  /** Per source: records matched, rejected by a check, or not found. */
  accuracy: Partial<Record<SourceId, IdentityCounts>>;
}

/**
 * Runs the identity chain for a track and reads every primary source from it. Never throws;
 * each source answers on its own, "missing" with the reason when it has nothing.
 */
export async function collectPrimarySources(
  track: TrackRef,
  options: { now?: Clock } = {},
): Promise<PrimarySources> {
  const resolution = await resolveIdentity(track);
  const { identity } = resolution;
  const unidentified = <T>(source: SourceId, configured: boolean, variable: string | null) =>
    !configured && variable
      ? notConfigured<T>(source, variable)
      : missing<T>(source, "no MusicBrainz recording identified for the track");

  const [musicbrainz, discogs, genius, secondhandsongs] = await Promise.all([
    musicBrainzRelationships(resolution, options),
    !identity
      ? unidentified<DiscogsCredit>("discogs", discogsConfigured(), DISCOGS_TOKEN)
      : identity.releasesError && discogsConfigured()
        ? missing<DiscogsCredit>("discogs", identity.releasesError)
        : discogsTrackCredits(track, identity.discogsReleaseIds, options),
    !identity
      ? unidentified<GeniusRelationship>("genius", geniusConfigured(), GENIUS_ACCESS_TOKEN)
      : geniusRelationships(track, identity.geniusUrl, options),
    !identity
      ? unidentified<ShsRelationship>("secondhandsongs", true, null)
      : shsRelationships(track, identity.shsLinks, options),
  ]);
  const results = [musicbrainz, discogs, genius, secondhandsongs];
  return {
    identity,
    musicbrainz,
    discogs,
    genius,
    secondhandsongs,
    evidence: results.flatMap((r) => (r.status === "found" ? r.evidence : [])),
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
      "source without a verified record is reported as missing, with the reason.",
    schema: z.object({
      isrc: z.string().describe("The track's ISRC"),
      title: z.string().describe("The track title"),
      artists: z.array(z.string()).min(1).describe("The track's credited artists, one by one"),
      durationMs: z.number().nullable().optional().describe("The track's duration in ms"),
    }),
  },
);
