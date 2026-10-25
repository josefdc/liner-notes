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
  if (call.url.startsWith(`${MB}/release?`)) return json(iceReleases);
  if (call.url.startsWith(`${MB}/work/${ICE_WORK}?`)) return json(iceWork);
  if (call.url.startsWith(`${MB}/recording?work=${ICE_WORK}&`)) {
    const offset = new URL(call.url).searchParams.get("offset");
    return json(offset === "0" ? iceWorkRecordings1 : iceWorkRecordings2);
  }
  return undefined;
};
