/**
 * Discogs release credits for one track.
 *
 * The release comes from the identity chain (a Discogs link on a MusicBrainz release of the
 * matched recording), never from a search. On the release the track is found by title, credited
 * artists and printed duration; a release without exactly one such track is omitted. Credits are
 * kept when they name the track: the track's own credits, and release credits whose `tracks`
 * field covers its position. Credits for the whole release (an empty `tracks` field) are kept
 * with `scope: "release"`, so a reader can tell them apart.
 *
 * Needs DISCOGS_TOKEN, a personal access token sent as `Authorization: Discogs token=…`.
 * Without it the source is "missing" and nothing is requested.
 *
 * Requests are paced on the client (`DISCOGS_PACE`): Discogs allows 60 authenticated requests
 * per minute per IP address, counted over a moving 60-second window, and answers 429 past it. A
 * run reads at most three releases, one after the other. A request our pacing does not send is
 * "not asked" (`failed` marks it paced), never a source error.
 *
 * @see https://www.discogs.com/developers (Rate Limiting)
 */

import { SOURCE_CREDENTIALS } from "../config/settings.js";
import { credential, isSourceError, pacedFetchJson, type Shape } from "./http.js";
import { type Pace, RequestPacer } from "./pacing.js";
import {
  type Clock,
  checkIdentity,
  failed,
  found,
  MAX_RECORDS,
  missing,
  notConfigured,
  unexpectedShape,
  type Omission,
  PRINTED_DURATION_TOLERANCE_MS,
  parseClockDuration,
  primaryEvidence,
  scopedRef,
  type SourceResult,
  systemClock,
  type TrackRef,
} from "./records.js";

const API = "https://api.discogs.com";
const SITE = "https://www.discogs.com";
export const DISCOGS_TOKEN = SOURCE_CREDENTIALS.discogs;

interface DiscogsArtist {
  id?: number;
  name: string;
  anv?: string;
  join?: string;
  role?: string;
  tracks?: string;
}

interface DiscogsTrack {
  position?: string;
  type_?: string;
  title: string;
  duration?: string;
  artists?: DiscogsArtist[];
  extraartists?: DiscogsArtist[];
}

export interface DiscogsRelease {
  id: number;
  title: string;
  year?: number;
  artists?: DiscogsArtist[];
  extraartists?: DiscogsArtist[];
  tracklist?: DiscogsTrack[];
}

export interface DiscogsCredit {
  releaseId: number;
  position: string;
  trackTitle: string;
  name: string;
  artistId: number | null;
  roles: string[];
  /** "track": credited on this track; "release": credited on the whole release. */
  scope: "track" | "release";
  /** The Evidence item that states this credit. */
  evidenceId: string;
}

const ARTIST_SHAPE: Shape = [{ id: true, name: true, anv: true, join: true }];
const CREDIT_SHAPE: Shape = [{ id: true, name: true, anv: true, role: true, tracks: true }];
const RELEASE_SHAPE: Shape = {
  id: true,
  title: true,
  year: true,
  artists: ARTIST_SHAPE,
  extraartists: CREDIT_SHAPE,
  tracklist: [
    {
      position: true,
      type_: true,
      title: true,
      duration: true,
      artists: ARTIST_SHAPE,
      extraartists: CREDIT_SHAPE,
    },
  ],
};

/**
 * At most 55 requests a minute, at least 200 ms apart: under the 60 a minute Discogs allows over
 * its moving window, also when its window and our clock disagree. A request is not sent when
 * its slot comes after the run's deadline (the source is then "not asked").
 */
export const DISCOGS_PACE: Pace = {
  intervalMs: 200,
  budgets: [{ max: 55, windowMs: 60 * 1000 }],
  maxWaitMs: 60_000,
};

const pacer = new RequestPacer("Discogs", () => DISCOGS_PACE);

export function discogsConfigured(): boolean {
  return Boolean(credential(DISCOGS_TOKEN));
}

/** The release id in a Discogs release URL ("https://www.discogs.com/release/599648"). */
export function discogsReleaseId(url: string): number | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/(?:^|\.)discogs\.com$/i.test(parsed.hostname)) return null;
  const match = parsed.pathname.match(/\/release\/(\d+)(?:[-/]|$)/);
  const id = match ? Number(match[1]) : Number.NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export async function getDiscogsRelease(
  id: number,
  signal?: AbortSignal,
  notAfter?: number,
): Promise<DiscogsRelease> {
  const release = await pacedFetchJson<DiscogsRelease>(
    pacer,
    {
      source: "discogs",
      url: `${API}/releases/${id}`,
      headers: {
        Accept: "application/vnd.discogs.v2.discogs+json",
        Authorization: `Discogs token=${credential(DISCOGS_TOKEN) ?? ""}`,
      },
      scrub: RELEASE_SHAPE,
      signal,
    },
    { notAfter },
  );
  if (!release || typeof release !== "object" || typeof release.id !== "number") {
    throw unexpectedShape("discogs", `release ${id} is not a release`, release);
  }
  return release;
}

/** "Producer, Written-By" → ["Producer", "Written-By"]; commas inside brackets stay. */
export function splitRoles(role: string | undefined): string[] {
  const roles: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of role ?? "") {
    if (char === "[" || char === "(") depth++;
    if (char === "]" || char === ")") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      roles.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  roles.push(current);
  return roles.map((r) => r.trim()).filter(Boolean);
}

const samePosition = (a: string, b: string) => a.trim().toUpperCase() === b.trim().toUpperCase();

export type Coverage = boolean | "all" | "ambiguous";

/**
 * Whether a release credit's `tracks` field covers a position: "all" when it is empty (the
 * credit is for the whole release), otherwise a list of positions and ranges ("A1, B2",
 * "A1 to A3") read against the tracklist's order. A position that occurs more than once (each
 * disc numbered from 1 under its own heading) cannot be told apart in a `tracks` field, so a
 * credit naming one, or a range bounded by one, that could cover the track is "ambiguous".
 */
export function creditCovers(
  tracks: string | undefined,
  position: string,
  order: string[],
): Coverage {
  if (!tracks?.trim()) return "all";
  const indexes = (p: string) => order.flatMap((q, i) => (samePosition(q, p) ? [i] : []));
  const own = indexes(position);
  let ambiguous = false;
  for (const part of tracks.split(",")) {
    const range = part.match(/^\s*(.+?)\s+to\s+(.+?)\s*$/i);
    if (range) {
      const from = indexes(range[1]);
      const to = indexes(range[2]);
      if (from.length === 0 || to.length === 0) continue;
      const spans = from.flatMap((f) => to.filter((t) => t >= f).map((t) => [f, t] as const));
      const hits = spans.filter(([f, t]) => own.some((i) => i >= f && i <= t));
      if (hits.length === 0) continue;
      if (own.length === 1 && from.length === 1 && to.length === 1) return true;
      ambiguous = true;
    } else if (samePosition(part, position)) {
      if (own.length === 1) return true;
      ambiguous = true;
    }
  }
  return ambiguous ? "ambiguous" : false;
}

const creditedArtists = (artists: DiscogsArtist[] | undefined) =>
  (Array.isArray(artists) ? artists : [])
    .filter((a) => typeof a?.name === "string")
    .map((a) => ({ names: [a.name, a.anv ?? ""].filter(Boolean) }));

type TrackMatch = { ok: true; track: DiscogsTrack } | { ok: false; reason: string };

/**
 * The release's one track that is the given track: same title, same credited artists (the
 * track's own, else the release's), printed duration within the tolerance when printed. Several
 * tracks passing is ambiguous and omitted, unless exactly one has a matching printed duration.
 */
export function findTrack(release: DiscogsRelease, track: TrackRef): TrackMatch {
  // Headings and index tracks ("type_": "heading" / "index") are not tracks.
  const tracks = (Array.isArray(release?.tracklist) ? release.tracklist : []).filter(
    (t) => typeof t?.title === "string" && (t.type_ === undefined || t.type_ === "track"),
  );
  const reasons: Array<{ failed: string; reason: string }> = [];
  const passing: Array<{ track: DiscogsTrack; durationKnown: boolean }> = [];
  for (const candidate of tracks) {
    const artists =
      Array.isArray(candidate.artists) && candidate.artists.length
        ? candidate.artists
        : release.artists;
    const check = checkIdentity(
      track,
      {
        title: candidate.title,
        artists: creditedArtists(artists),
        durationMs: parseClockDuration(candidate.duration),
      },
      PRINTED_DURATION_TOLERANCE_MS,
    );
    if (check.ok) passing.push({ track: candidate, durationKnown: check.duration === "match" });
    else reasons.push(check);
  }
  if (passing.length === 1) return { ok: true, track: passing[0].track };
  if (passing.length > 1) {
    const timed = passing.filter((p) => p.durationKnown);
    if (timed.length === 1) return { ok: true, track: timed[0].track };
    return { ok: false, reason: `${passing.length} tracks on the release match the track` };
  }
  // A track with the title that failed another check says more than "no such title".
  const titled = reasons.find((r) => r.failed !== "title");
  return {
    ok: false,
    reason: titled?.reason ?? `no track titled "${track.title}" among ${tracks.length} tracks`,
  };
}

/**
 * The credits that name the track, in the release's order, and how many release credits were
 * left out because the position they name repeats on the release.
 */
export function trackCredits(
  release: DiscogsRelease,
  matched: DiscogsTrack,
): { credits: DiscogsCredit[]; ambiguous: number } {
  const position = matched.position?.trim() ?? "";
  const order = (Array.isArray(release.tracklist) ? release.tracklist : [])
    .filter((t) => t && (t.type_ === undefined || t.type_ === "track"))
    .map((t) => t.position?.trim() ?? "");
  const credit = (a: DiscogsArtist, scope: DiscogsCredit["scope"]): DiscogsCredit => ({
    evidenceId: "",
    releaseId: release.id,
    position,
    trackTitle: matched.title,
    name: a.name,
    artistId: typeof a.id === "number" ? a.id : null,
    roles: splitRoles(a.role),
    scope,
  });
  const list = <T>(v: T[] | undefined) => (Array.isArray(v) ? v : []);
  const credits: DiscogsCredit[] = [];
  let ambiguous = 0;
  for (const a of list(matched.extraartists)) {
    if (typeof a?.name === "string") credits.push(credit(a, "track"));
  }
  for (const a of list(release.extraartists)) {
    if (typeof a?.name !== "string") continue;
    const covers: Coverage = position
      ? creditCovers(a.tracks, position, order)
      : a.tracks?.trim()
        ? false
        : "all";
    if (covers === true) credits.push(credit(a, "track"));
    else if (covers === "all") credits.push(credit(a, "release"));
    else if (covers === "ambiguous") ambiguous++;
  }
  return { credits: credits.filter((c) => c.roles.length > 0), ambiguous };
}

function creditEvidence(release: DiscogsRelease, credit: DiscogsCredit, index: number, at: string) {
  const where =
    credit.scope === "track"
      ? `track ${credit.position ? `${credit.position} ` : ""}"${credit.trackTitle}"`
      : `the whole release (which includes "${credit.trackTitle}")`;
  const year = release.year ? `, ${release.year}` : "";
  return primaryEvidence({
    source: "discogs",
    recordRef:
      credit.scope === "track"
        ? scopedRef("track", `release/${release.id}/credit/${index}`)
        : scopedRef("release", `${release.id}/credit/${index}`),
    url: `${SITE}/release/${release.id}`,
    title: `${release.title} — Discogs release ${release.id}`,
    excerpt: `Discogs release ${release.id} ("${release.title}"${year}) credits ${credit.name} as ${credit.roles.join(", ")} on ${where}.`,
    retrievedAt: at,
  });
}

/**
 * Credits for the track from the first of `releaseIds` (in the identity chain's order, at most
 * `maxReleases`) on which the track is found with credits. Each release is checked on its own;
 * one that does not hold the track is omitted with the reason, one Discogs does not have (404)
 * or that lists no credits for the track is passed over. `note` is added to the result (e.g. not
 * every release of the recording was read). Never throws.
 */
export async function discogsTrackCredits(
  track: TrackRef,
  releaseIds: number[],
  options: {
    maxReleases?: number;
    now?: Clock;
    signal?: AbortSignal;
    /** On `pacingClock`: the latest a request may start (sources/pacing.ts). */
    notAfter?: number;
    note?: string | null;
  } = {},
): Promise<SourceResult<DiscogsCredit>> {
  if (!discogsConfigured()) return notConfigured("discogs", DISCOGS_TOKEN);
  const note = options.note ?? null;
  const withNote = (reason: string) => (note ? `${reason}; ${note}` : reason);
  const ids = [...new Set(releaseIds)].slice(0, options.maxReleases ?? 3);
  if (ids.length === 0) {
    return missing(
      "discogs",
      withNote("MusicBrainz links no Discogs release to an original release of the recording"),
    );
  }
  const now = options.now ?? systemClock;
  const omitted: Omission[] = [];
  const passed: string[] = [];
  let matched = 0;
  try {
    for (const id of ids) {
      let release: DiscogsRelease;
      try {
        release = await getDiscogsRelease(id, options.signal, options.notAfter);
      } catch (error) {
        if (isSourceError(error, "http") && error.status === 404) {
          passed.push(`Discogs has no release ${id}`);
          continue;
        }
        throw error;
      }
      const at = now().toISOString();
      const match = findTrack(release, track);
      if (!match.ok) {
        omitted.push({ ref: `release/${id}`, reason: match.reason });
        continue;
      }
      matched++;
      const { credits: all, ambiguous } = trackCredits(release, match.track);
      const notes = [
        all.length > MAX_RECORDS ? `${all.length - MAX_RECORDS} more credits not listed` : null,
        ambiguous > 0
          ? `${ambiguous} credits name position ${match.track.position}, which repeats on the release; left out`
          : null,
        note,
      ].filter((n): n is string => n !== null);
      if (all.length === 0) {
        passed.push(
          ambiguous > 0
            ? `Discogs release ${id}: ${notes[0]}`
            : `Discogs release ${id} lists no credits for the track`,
        );
        continue;
      }
      const credits = all.slice(0, MAX_RECORDS);
      const evidence = credits.map((c, i) => creditEvidence(release, c, i, at));
      credits.forEach((c, i) => {
        c.evidenceId = evidence[i].id;
      });
      return found("discogs", credits, evidence, {
        omitted,
        matched,
        incomplete: notes.length > 0 ? notes.join("; ") : null,
      });
    }
  } catch (error) {
    return failed("discogs", error, omitted, matched);
  }
  const reason =
    passed.length > 0
      ? passed.join("; ")
      : `none of the ${ids.length} linked Discogs releases holds the track`;
  return missing("discogs", withNote(reason), { omitted, matched });
}
