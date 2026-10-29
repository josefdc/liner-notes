/**
 * Code-built claims and links on the evidence of the recorded One More Time run (the copy pinned
 * at 98e88946b9b5 in fixtures/pinned, replay/testing/recordings.ts, so a re-record of the
 * showcase leaves this evidence as it is): what the curation keeps, and that the nodes
 * made from its records never take this track's own numbers away from the numeric check.
 */

import type { Claim, Evidence } from "@liner-notes/contract";
import { describe, expect, it } from "vitest";
import { buildCodeClaims, withCodeClaims } from "./codeClaims.js";
import { type PrimaryRelation, relationsIssue } from "./research/relations.js";
import { pinnedRecord } from "../replay/testing/recordings.js";
import { audioV2 } from "./testing/measuredAudio.js";
import { checkClaims } from "./verifier/index.js";
import { draftOf, modelClaim } from "./verifier/testing.js";

const PHRASE: Record<string, string> = {
  samples: "samples",
  "sampled-by": "is sampled in",
  "remix-of": "is a remix of",
  "remixed-by": "is remixed in",
  "cover-of": "is a cover of",
  "covered-by": "is covered by",
};
const REF =
  /^(?:track\/recording\/[^/]+|work\/[^/]+)\/(samples|sampled-by|remix-of|remixed-by|cover-of|covered-by)\/(recording|work)\/([^/]+)$/;

/**
 * The run's evidence and the MusicBrainz relations its items state, as the source module read
 * them (the fixture keeps the items; each relation is read back from its item, and checked
 * against it as a cache hit checks it).
 */
function oneMoreTime(): { evidence: Evidence[]; relations: PrimaryRelation[] } {
  const evidence: Evidence[] = pinnedRecord().analysis.evidence ?? [];
  const relations: PrimaryRelation[] = [];
  for (const item of evidence) {
    const match = item.source === "musicbrainz" ? REF.exec(item.recordRef ?? "") : null;
    if (!match) continue;
    const [, kind, entity, mbid] = match;
    const phrase = ` ${PHRASE[kind]} `;
    const other = item.excerpt.slice(item.excerpt.lastIndexOf(phrase) + phrase.length, -1);
    const names = /^"(.*)" by (.*)$/su.exec(other) ?? /^"(.*)"$/su.exec(other);
    if (!names) throw new Error(`unread excerpt: ${item.excerpt}`);
    relations.push({
      type: "relation",
      source: "musicbrainz",
      evidenceId: item.id,
      scope: item.recordRef?.startsWith("work/") ? "work" : "track",
      kind: kind as Extract<PrimaryRelation, { type: "relation" }>["kind"],
      attributes: kind === "covered-by" ? ["cover"] : [],
      other: {
        entity: entity as "recording" | "work",
        mbid,
        title: names[1],
        artist: names[2] ?? null,
      },
    });
  }
  expect(relationsIssue(relations, evidence)).toBeNull();
  return { evidence, relations };
}

function built() {
  const { evidence, relations } = oneMoreTime();
  let next = 0;
  const code = buildCodeClaims(relations, evidence, () => `code-${++next}`);
  return { evidence, code };
}

const nodeLabelled = (code: ReturnType<typeof built>["code"], title: string) =>
  code.nodes.find((node) => node.trackTitle === title);

describe("the curation, on One More Time's records", () => {
  it("links the sample it draws on first, and leaves out the parody and the decorative credit", () => {
    const { code } = built();
    const spell = nodeLabelled(code, "More Spell on You");
    expect(spell?.label).toBe("More Spell on You - Eddie Johns");
    // What this recording draws on comes first: the first node and the first link.
    expect(code.nodes[0]).toBe(spell);
    expect(code.links[0]).toMatchObject({
      source: spell?.id,
      target: "current",
      type: "sample",
      kind: "sourced",
      origin: "code",
    });
    for (const title of ["One Whore Time", "Give u kawaii!"]) {
      expect(nodeLabelled(code, title)).toBeUndefined();
      expect(code.claims.some((claim) => claim.text.includes(`"${title}"`))).toBe(false);
    }
    // What draws on it: at most 4 of each kind.
    const outgoing = code.links.filter((link) => link.source === "current");
    expect(outgoing.filter((link) => link.type === "sample")).toHaveLength(4);
    expect(outgoing.filter((link) => link.type === "remix")).toHaveLength(4);
  });

  it("looks up the cover art of the first 2 nodes of each kind only", () => {
    const { code } = built();
    const searched = code.nodes.filter((node) => !code.noArtwork.includes(node.id));
    expect(searched.map((node) => node.trackTitle)).toEqual([
      "More Spell on You",
      "1 more dime (fvlcrvm rwrk)",
      "one more karkat",
      "Circo Loco",
      "DAFT",
    ]);
  });
});

describe("the numeric check, with One More Time's record nodes in the result", () => {
  /** The claims, checked against a measured 115.8 BPM in D minor, with the code nodes present. */
  function checked(claims: Claim[]) {
    const { evidence, code } = built();
    const draft = draftOf(claims);
    draft.genealogy.nodes = draft.genealogy.nodes.map((node) =>
      node.id === "current"
        ? { ...node, label: "One More Time", trackTitle: "One More Time", trackArtist: "Daft Punk" }
        : node,
    );
    // The record node "DAFT" (by TAPS) is among them.
    expect(code.nodes.some((node) => node.label === "DAFT - TAPS")).toBe(true);
    const merged = withCodeClaims(draft, code);
    const result = checkClaims(merged, evidence, audioV2(), "One More Time", "Daft Punk");
    return (id: string) => result.claims.find((claim) => claim.id === id);
  }

  it("still compares what is said of this track, named by its artist", () => {
    const of = checked([
      modelClaim("field-tempo", {
        text: "Daft Punk's One More Time runs at 90 BPM.",
        field: "tempo",
        about: "sound",
      }),
      modelClaim("double", { text: "Daft Punk's anthem pulses at 232 BPM.", about: "sound" }),
      modelClaim("restated", {
        text: "Daft Punk's track was measured at 116 BPM.",
        about: "sound",
      }),
      modelClaim("key", {
        text: "Daft Punk wrote the hook in F# major.",
        field: "key",
        about: "sound",
      }),
      modelClaim("plain", { text: "The track runs at 90 BPM.", field: "tempo", about: "sound" }),
    ]);
    expect(of("field-tempo")?.numericCheck).toBe("contradicted");
    expect(of("double")?.numericCheck).toBe("conflict");
    expect(of("restated")?.numericCheck).toBe("consistent");
    expect(of("key")?.numericCheck).toBe("contradicted");
    expect(of("plain")?.numericCheck).toBe("contradicted");
  });

  it("does not compare what is said of another record named by its artist or in quotes", () => {
    const of = checked([
      modelClaim("taps", { text: "The TAPS track DAFT runs at 140 BPM.", about: "sound" }),
      modelClaim("quoted", { text: 'Their "DAFT" runs at 140 BPM.', about: "sound" }),
      modelClaim("by", { text: "DAFT by TAPS runs at 140 BPM.", about: "sound" }),
    ]);
    expect(of("taps")?.numericCheck).toBe("n/a");
    expect(of("quoted")?.numericCheck).toBe("n/a");
    expect(of("by")?.numericCheck).toBe("n/a");
  });
});
