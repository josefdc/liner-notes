/**
 * The one image a replay record keeps: the Cover Art Archive's front image of the release the
 * recorded result's MusicBrainz evidence names (sources/identity.ts, pickCoverRelease, picks only
 * a release the archive holds a front image of). The recorder writes it as the result's cover;
 * the replay loader serves no other cover.
 */

import type { Evidence } from "@liner-notes/contract";

const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** A MusicBrainz release as sources/identity.ts names it in an Evidence item's recordRef. */
const RELEASE_REF = new RegExp(`^release/(${UUID_PATTERN})$`);
/** The link `archiveCover` derives: the archive's 250 px front image of a release. */
export const ARCHIVE_FRONT = new RegExp(
  `^https://coverartarchive\\.org/release/${UUID_PATTERN}/front-250$`,
);

/**
 * The Cover Art Archive link a record keeps as the result's cover, or "" with the reason: the
 * front image (250 px) of the release named by the result's one MusicBrainz release item (a
 * primary record whose recordRef is `release/<mbid>`, with that release's id and page).
 */
export function archiveCover(analysis: { evidence?: readonly Evidence[] | null }): {
  url: string;
  reason: string;
} {
  const releases = (Array.isArray(analysis.evidence) ? analysis.evidence : []).filter(
    (item) =>
      item?.source === "musicbrainz" &&
      item.sourceTier === "primary-record" &&
      RELEASE_REF.test(item.recordRef ?? ""),
  );
  if (releases.length === 0) {
    return {
      url: "",
      reason:
        "the evidence names no MusicBrainz release (its releases could not be read, none has a front image at the Cover Art Archive, or the research was cached before releases were read)",
    };
  }
  if (releases.length > 1) {
    return {
      url: "",
      reason: `the evidence names ${releases.length} MusicBrainz releases, not one`,
    };
  }
  const [item] = releases;
  const mbid = RELEASE_REF.exec(item.recordRef ?? "")?.[1] ?? "";
  if (item.id !== `musicbrainz:release/${mbid}`) {
    return { url: "", reason: "the MusicBrainz release item's id does not name its release" };
  }
  if (item.url !== `https://musicbrainz.org/release/${mbid}`) {
    return { url: "", reason: "the MusicBrainz release item does not link its release's page" };
  }
  return { url: `https://coverartarchive.org/release/${mbid}/front-250`, reason: "" };
}

/** The Cover Art Archive link a record keeps as the result's cover, or "" (`archiveCover`). */
export const archiveCoverOf = (analysis: { evidence?: readonly Evidence[] | null }): string =>
  archiveCover(analysis).url;
