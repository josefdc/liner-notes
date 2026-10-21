/**
 * Genius song relationships (samples, interpolations, covers, remixes) from the Genius API.
 *
 * Only the API is used, and only for relationships: no lyrics, song bodies, annotations or page
 * HTML are requested, and every field that can carry lyric text (description, embed content,
 * annotations) is left unread and is not recorded.
 *
 * The song is the one MusicBrainz links from the track's work (a genius.com page). The API has no
 * lookup by page URL, so its id comes from a search whose result must be that exact page, and
 * the song must then pass the title and artist checks; the first search result is never taken.
 *
 * Needs GENIUS_ACCESS_TOKEN (a client access token), sent as `Authorization: Bearer …`. Without
 * it the source is "missing" and nothing is requested.
 *
 * @see https://docs.genius.com/
 */

import { SOURCE_CREDENTIALS } from "../config/settings.js";
import { credential, fetchJson, type Shape } from "./http.js";
import {
  bareTitle,
  type Clock,
  checkIdentity,
  failed,
  found,
  MAX_RECORDS,
  missing,
  notConfigured,
  primaryEvidence,
  quoted,
  RELATION_PHRASE,
  scopedRef,
  type RelationKind,
  type SourceResult,
  systemClock,
  type TrackRef,
} from "./records.js";

const API = "https://api.genius.com";
export const GENIUS_ACCESS_TOKEN = SOURCE_CREDENTIALS.genius;

interface GeniusArtist {
  id?: number;
  name: string;
}

interface GeniusSongSummary {
  id: number;
  title: string;
  url?: string;
  artist_names?: string;
  primary_artist?: GeniusArtist;
}

interface GeniusSong extends GeniusSongSummary {
  song_relationships?: Array<{ relationship_type?: string; songs?: GeniusSongSummary[] }>;
}

interface GeniusEnvelope<T> {
  meta?: { status?: number };
  response?: T;
}

export interface GeniusRelationship {
  kind: RelationKind;
  /**
   * "track": claimed for the track. "work": a fact about the song (what its studio recording
   * samples, who covered it), not claimed for a live version, edit or re-recording.
   */
  about: "track" | "work";
  /** The Evidence item that states this relationship; its recordRef carries the scope. */
  evidenceId: string;
  songId: number;
  title: string;
  artist: string;
  url: string | null;
}

/** Genius relationship types read, from the song's side; others (live, translation) are not. */
const KINDS: Record<string, RelationKind> = {
  samples: "samples",
  sampled_in: "sampled-by",
  interpolates: "interpolates",
  interpolated_by: "interpolated-by",
  cover_of: "cover-of",
  covered_by: "covered-by",
  remix_of: "remix-of",
  remixed_by: "remixed-by",
};

const SUMMARY_SHAPE: Shape = {
  id: true,
  title: true,
  url: true,
  artist_names: true,
  primary_artist: { id: true, name: true },
};
const SEARCH_SHAPE: Shape = {
  meta: { status: true },
  response: { hits: [{ type: true, result: SUMMARY_SHAPE }] },
};
const SONG_SHAPE: Shape = {
  meta: { status: true },
  response: {
    song: {
      ...SUMMARY_SHAPE,
      song_relationships: [{ relationship_type: true, songs: [SUMMARY_SHAPE] }],
    },
  },
};

export function geniusConfigured(): boolean {
  return Boolean(credential(GENIUS_ACCESS_TOKEN));
}

/** A genius.com page URL in one form (https, no "www.", query or trailing slash). */
export function geniusPage(url: string | null | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== "genius.com") return null;
  const path = parsed.pathname.replace(/\/+$/, "");
  return path ? `https://genius.com${path}` : null;
}

/** The song id in a "https://genius.com/songs/123" URL; null for a page path. */
export function geniusSongIdFromUrl(url: string): number | null {
  const match = geniusPage(url)?.match(/^https:\/\/genius\.com\/songs\/(\d+)$/);
  return match ? Number(match[1]) : null;
}

/** Relationships that hold for every performance of the song's performer, not just one. */
const PERFORMANCE_KINDS: ReadonlySet<RelationKind> = new Set(["cover-of", "remix-of"]);

function geniusGet<T>(
  path: string,
  params: Record<string, string>,
  scrub: Shape,
  signal?: AbortSignal,
) {
  const url = new URL(`${API}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return fetchJson<GeniusEnvelope<T>>({
    source: "genius",
    url,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${credential(GENIUS_ACCESS_TOKEN) ?? ""}`,
    },
    scrub,
    signal,
  });
}

const artistOf = (song: GeniusSongSummary) =>
  song.artist_names?.trim() || song.primary_artist?.name?.trim() || "";

/**
 * The relationships of the Genius song MusicBrainz links (`linkedUrl`) to the track. A Genius
 * song is the song, not one recording of it: its samples, interpolations, covers and remixes
 * are claimed for the track (`about: "track"`) only when `trackIsOriginal` (the identity chain
 * found the track to be the song's original recording); otherwise they are about the work.
 * Never throws: without the token, without a link, when the linked song fails a check or on
 * any source error the result is "missing" with the reason.
 */
export async function geniusRelationships(
  track: TrackRef,
  linkedUrl: string | null,
  options: { now?: Clock; signal?: AbortSignal; trackIsOriginal?: boolean } = {},
): Promise<SourceResult<GeniusRelationship>> {
  if (!geniusConfigured()) return notConfigured("genius", GENIUS_ACCESS_TOKEN);
  const page = geniusPage(linkedUrl);
  if (!page) return missing("genius", "MusicBrainz links no Genius page to this recording's work");
  const now = options.now ?? systemClock;

  try {
    let songId = geniusSongIdFromUrl(page);
    if (songId === null) {
      const query = `${bareTitle(track.title, track.artists)} ${track.artists.join(" ")}`.trim();
      const search = await geniusGet<{
        hits?: Array<{ type?: string; result?: GeniusSongSummary }>;
      }>("/search", { q: query }, SEARCH_SHAPE, options.signal);
      const hits = Array.isArray(search?.response?.hits) ? search.response.hits : [];
      const linked = hits
        .map((h) => h?.result)
        .filter(
          (r): r is GeniusSongSummary =>
            Number.isSafeInteger(r?.id) &&
            typeof r?.title === "string" &&
            geniusPage(r.url)?.toLowerCase() === page.toLowerCase(),
        );
      if (linked.length === 0) {
        return missing("genius", `no Genius search result is the linked page ${page}`);
      }
      songId = linked[0].id;
    }

    const answer = await geniusGet<{ song?: GeniusSong }>(
      `/songs/${songId}`,
      {},
      SONG_SHAPE,
      options.signal,
    );
    const song = answer?.response?.song;
    if (!song || !Number.isSafeInteger(song.id) || typeof song.title !== "string") {
      return missing("genius", `Genius returned no song ${songId}`);
    }
    const ref = `song/${song.id}`;
    const check = checkIdentity(track, { title: song.title, artists: artistOf(song) });
    if (!check.ok)
      return missing("genius", check.reason, { omitted: [{ ref, reason: check.reason }] });

    const at = now().toISOString();
    const records: GeniusRelationship[] = [];
    const seen = new Set<string>();
    for (const group of Array.isArray(song.song_relationships) ? song.song_relationships : []) {
      const kind = KINDS[group?.relationship_type ?? ""];
      if (!kind) continue;
      for (const other of Array.isArray(group.songs) ? group.songs : []) {
        if (!Number.isSafeInteger(other?.id) || typeof other.title !== "string") continue;
        if (seen.has(`${kind} ${other.id}`)) continue;
        seen.add(`${kind} ${other.id}`);
        records.push({
          kind,
          about: PERFORMANCE_KINDS.has(kind) || options.trackIsOriginal ? "track" : "work",
          evidenceId: "",
          songId: other.id,
          title: other.title,
          artist: artistOf(other),
          url: geniusPage(other.url),
        });
      }
    }
    if (records.length === 0) {
      return missing("genius", "Genius lists no samples, interpolations, covers or remixes", {
        matched: 1,
      });
    }
    const kept = records.slice(0, MAX_RECORDS);
    const songUrl = geniusPage(song.url) ?? page;
    const evidence = kept.map((r) =>
      primaryEvidence({
        source: "genius",
        recordRef: scopedRef(r.about, `${ref}/${r.kind}/${r.songId}`),
        url: songUrl,
        title: `${song.title} — Genius song relationships`,
        excerpt: `Genius: the song ${quoted(song.title, artistOf(song))} ${RELATION_PHRASE[r.kind]} ${quoted(r.title, r.artist)}.`,
        retrievedAt: at,
      }),
    );
    kept.forEach((r, i) => {
      r.evidenceId = evidence[i].id;
    });
    const notes = [
      records.length > kept.length ? `${records.length - kept.length} more not listed` : null,
      kept.some((r) => r.about === "work")
        ? "relationships of the song, not claimed for this recording: it is not the song's original recording"
        : null,
    ].filter((n): n is string => n !== null);
    return found("genius", kept, evidence, {
      incomplete: notes.length > 0 ? notes.join("; ") : null,
    });
  } catch (error) {
    return failed("genius", error);
  }
}
