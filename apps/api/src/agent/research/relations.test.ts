/**
 * The relations a run's pack carries: only those whose item the pack keeps, so a cached row is
 * always one its reader restores (a row whose relation names a cut item would be refused on
 * every read, and the research made again on every visit).
 */

import { describe, expect, it } from "vitest";
import type { IdentifiedRecording, PrimarySources } from "../../sources/identity.js";
import type { MbRelationship } from "../../sources/musicbrainz.js";
import { found, primaryEvidence, scopedRef } from "../../sources/records.js";
import { stubLlm, testRuntime } from "../testing/stubLlm.js";
import { EVIDENCE_PACK_MAX_ITEMS } from "./evidencePack.js";
import { primaryRelations } from "./relations.js";
import { cachedEvidenceOf, restoredItems, runEvidence } from "./runEvidence.js";

const AT = "2026-10-20T12:00:00.000Z";
const OWN = "00000000-0000-4000-8000-000000000000";
const WORK = "00000000-0000-4000-8000-0000000000ff";
const mbid = (n: number) => `00000000-0000-4000-8000-${String(n + 1).padStart(12, "0")}`;

/**
 * MusicBrainz for a busy recording: `samples` recordings it is sampled in (each its own item
 * about the track), then one cover of its song (an item about the work, ranked after them).
 */
function busySources(samples: number): PrimarySources {
  const records: MbRelationship[] = [];
  const evidence = [
    primaryEvidence({
      source: "musicbrainz",
      recordRef: scopedRef("track", `recording/${OWN}`),
      url: `https://musicbrainz.org/recording/${OWN}`,
      title: "Busy Song — MusicBrainz recording",
      excerpt: 'MusicBrainz recording "Busy Song" by Busy Artist, ISRC USXX00000001.',
      retrievedAt: AT,
    }),
  ];
  for (let n = 0; n < samples; n++) {
    const item = primaryEvidence({
      source: "musicbrainz",
      recordRef: scopedRef("track", `recording/${OWN}/sampled-by/recording/${mbid(n)}`),
      url: `https://musicbrainz.org/recording/${OWN}`,
      title: "Busy Song — MusicBrainz relationships",
      excerpt: `MusicBrainz: "Busy Song" by Busy Artist is sampled in "Song ${n}" by Band ${n}.`,
      retrievedAt: AT,
    });
    evidence.push(item);
    records.push({
      kind: "sampled-by",
      about: "track",
      evidenceId: item.id,
      recording: { mbid: mbid(n), title: `Song ${n}`, artist: `Band ${n}`, lengthMs: null },
      work: null,
      attributes: [],
    });
  }
  const cover = primaryEvidence({
    source: "musicbrainz",
    recordRef: scopedRef("work", `${WORK}/covered-by/recording/${mbid(999)}`),
    url: `https://musicbrainz.org/work/${WORK}`,
    title: "Busy Song — MusicBrainz work",
    excerpt: 'MusicBrainz: the work "Busy Song" is covered by "Busy Song" by Cover Band.',
    retrievedAt: AT,
  });
  evidence.push(cover);
  records.push({
    kind: "covered-by",
    about: "work",
    evidenceId: cover.id,
    recording: { mbid: mbid(999), title: "Busy Song", artist: "Cover Band", lengthMs: null },
    work: { mbid: WORK, title: "Busy Song" },
    attributes: ["cover"],
  });
  const missing = { status: "missing", reason: "not asked here", error: null } as const;
  return {
    identity: null,
    musicbrainz: found("musicbrainz", records, evidence),
    discogs: {
      ...missing,
      source: "discogs",
      identity: found("discogs", [], []).identity,
      omitted: [],
    },
    genius: {
      ...missing,
      source: "genius",
      identity: found("genius", [], []).identity,
      omitted: [],
    },
    secondhandsongs: {
      ...missing,
      source: "secondhandsongs",
      identity: found("secondhandsongs", [], []).identity,
      omitted: [],
    },
    evidence,
    accuracy: {},
  } as PrimarySources;
}

describe("a pack cut at its item cap", () => {
  it("carries no relation whose item it left out, and caches a row its reader restores", async () => {
    const sources = busySources(EVIDENCE_PACK_MAX_ITEMS + 5);
    const relations = primaryRelations(sources);
    expect(relations).toHaveLength(EVIDENCE_PACK_MAX_ITEMS + 6);

    const pack = await runEvidence(
      Promise.resolve({ status: "read", sources }),
      [],
      { writer: () => {} } as never,
      testRuntime(
        stubLlm(() => ({})),
        AT,
      ),
    );
    expect(pack.omitted).toBeGreaterThan(0);
    const kept = new Set(pack.evidence.map((item) => item.id));
    expect(pack.relations.length).toBeGreaterThan(0);
    expect(pack.relations.every((relation) => kept.has(relation.evidenceId))).toBe(true);
    // The cover, about the song, ranks last: cut, and its relation with it.
    expect(pack.relations.some((relation) => relation.scope === "work")).toBe(false);

    const recording = { mbid: OWN } as IdentifiedRecording;
    const row = JSON.parse(JSON.stringify(cachedEvidenceOf(pack, "USXX00000001", recording, AT)));
    expect(restoredItems(row)).not.toBeNull();
  });
});
