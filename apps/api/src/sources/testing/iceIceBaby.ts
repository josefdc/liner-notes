/**
 * Test helper: "Ice Ice Baby" as the primary sources answer for it, from the captured
 * MusicBrainz and SecondHandSongs fixtures (sources/fixtures). `primaryRoute` answers every
 * request the identity chain makes for the track's ISRC, and nothing else.
 */

import iceDetails from "../fixtures/musicbrainz-recording-details-ice-ice-baby.json" with {
  type: "json",
};
import iceIsrc from "../fixtures/musicbrainz-isrc-ice-ice-baby.json" with { type: "json" };
import iceReleases from "../fixtures/musicbrainz-releases-ice-ice-baby.json" with { type: "json" };
import iceWork from "../fixtures/musicbrainz-work-ice-ice-baby.json" with { type: "json" };
import iceWorkRecordings1 from "../fixtures/musicbrainz-work-recordings-ice-ice-baby-1.json" with {
  type: "json",
};
import iceWorkRecordings2 from "../fixtures/musicbrainz-work-recordings-ice-ice-baby-2.json" with {
  type: "json",
};
import shsWork from "../fixtures/shs-work-ice-ice-baby.json" with { type: "json" };
import type { TrackRef } from "../records.js";
import { type FetchRoute, json } from "./fetchStub.js";

const MB = "https://musicbrainz.org/ws/2";
const ICE = "875c24bc-fe9e-4ac6-80d3-beaacb70ee43";
const ICE_WORK = "e0ebb61d-7f69-3667-a2b1-dcd447d80f3d";

/**
 * The recording's releases (fixtures/musicbrainz-releases-ice-ice-baby.json) with whether the
 * Cover Art Archive holds a front image of each (`cover-art-archive.front`), which the capture
 * did not keep: set here for the tests, not captured. Three "To the Extreme" releases dated only
 * "1990" have none, as MusicBrainz reported for them on 2026-10-25; the others are given one.
 */
export const iceReleasesWithArt = {
  ...iceReleases,
  releases: iceReleases.releases.map((release) => ({
    ...release,
    "cover-art-archive": {
      front: ![
        "424c4142-7144-49be-899b-355e11215bdd",
        "b4314c6e-4f28-4a18-8eaa-6e02a90c6d89",
        "d02aeed5-99bb-4cd4-afa5-1cee117a6061",
      ].includes(release.id),
    },
  })),
};

/** "Ice Ice Baby" as Spotify lists it on "To the Extreme". */
export const ICE_TRACK: TrackRef = {
  isrc: "USCA29001716",
  title: "Ice Ice Baby",
  artists: ["Vanilla Ice"],
  durationMs: 271_733,
};

/** MusicBrainz (by ISRC, the recording, its releases and work) and SecondHandSongs. */
export const primaryRoute: FetchRoute = (call) => {
  if (call.url === "https://secondhandsongs.com/work/4196") return json(shsWork);
  if (call.url.startsWith(`${MB}/isrc/USCA29001716?`)) return json(iceIsrc);
  if (call.url.startsWith(`${MB}/recording/${ICE}?`)) return json(iceDetails);
  if (call.url.startsWith(`${MB}/release?`)) return json(iceReleasesWithArt);
  if (call.url.startsWith(`${MB}/work/${ICE_WORK}?`)) return json(iceWork);
  if (call.url.startsWith(`${MB}/recording?work=${ICE_WORK}&`)) {
    const offset = new URL(call.url).searchParams.get("offset");
    return json(offset === "0" ? iceWorkRecordings1 : iceWorkRecordings2);
  }
  return undefined;
};

/** The artist the recording credits (Vanilla Ice), as MusicBrainz identifies it. */
export const ICE_ARTIST = "2d5583be-aafd-41ec-addd-df85913855ef";

/**
 * A whole run's requests about the track with an ISRC: `primaryRoute`, plus what the research
 * asks of the credited artist by its MusicBrainz id (its MusicBrainz collaborators, its
 * ListenBrainz similar artists).
 */
export const runRoute: FetchRoute = (call) => {
  if (call.url.startsWith(`${MB}/artist/${ICE_ARTIST}?`)) {
    return json({
      id: ICE_ARTIST,
      name: "Vanilla Ice",
      relations: [
        {
          type: "supporting musician",
          artist: { id: "5e1e2d3c-0000-4000-8000-0000000000b2", name: "Earthquake" },
        },
      ],
    });
  }
  if (call.url.startsWith("https://labs.api.listenbrainz.org/similar-artists/json?")) {
    return json([
      { artist_mbid: "5e1e2d3c-0000-4000-8000-000000000001", name: "MC Hammer", score: 900 },
    ]);
  }
  return primaryRoute(call);
};
