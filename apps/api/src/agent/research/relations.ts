/**
 * The relations the primary records state, in structured form: what the run's code-built claims
 * and genealogy links are made from (agent/codeClaims.ts), never what the model reads (its prompt
 * shows the evidence pack only).
 *
 * Each relation names the Evidence item that states it (`evidenceId`) and that item's recordRef
 * scope, so a claim built from it cites exactly that item, with the scope the item supports:
 * - "relation": a MusicBrainz relationship of the recording (a sample, remix or cover), with the
 *   other end's title, artist and MusicBrainz id, from the record the source module read;
 * - "credit": a Discogs credit of the track ("track") or of the whole release ("release");
 * - "release": the official release MusicBrainz names for the recording (the #113 item);
 * - "hop": a MusicBrainz relationship between two other recordings, read for the relations map
 *   (the second hop: what a recording this one samples samples, and the other recordings that
 *   sample it). Its item has no scope: it supports no claim, only a code-built link.
 * A related recording carries the first release date MusicBrainz files for it, when the run read
 * one (never a model's), for its node's year.
 *
 * Relations travel with the evidence: the research cache keeps them beside its items, and a
 * cached relation is used only when the item it names states it (`relationsIssue`).
 */

import type { Evidence } from "@liner-notes/contract";
import { z } from "zod";
import { hopRecordRef, type PrimarySources } from "../../sources/identity.js";
import { type MbRelatedRecording, RELEASE_DATE } from "../../sources/musicbrainz.js";
import { evidenceScope, quoted, quotedDated, RELATION_PHRASE } from "../../sources/records.js";

const RelationKind = z.enum([
  "samples",
  "sampled-by",
  "interpolates",
  "interpolated-by",
  "remix-of",
  "remixed-by",
  "cover-of",
  "covered-by",
]);

/**
 * A recording's first release date as MusicBrainz files it; null or absent when the run read
 * none (a relation cached before dates were kept has none).
 */
const FirstReleaseDate = z.string().regex(RELEASE_DATE).nullable().optional();

/** A relationship of the recording to another recording or work, as MusicBrainz files it. */
export const RecordingRelation = z.object({
  type: z.literal("relation"),
  source: z.literal("musicbrainz"),
  evidenceId: z.string().min(1),
  /** "track": a fact about this recording; "work": about the song it performs. */
  scope: z.enum(["track", "work"]),
  /** Read from this recording's side: "samples" means this recording samples the other. */
  kind: RelationKind,
  /**
   * MusicBrainz's attributes of the relationship, as filed: "partial" (part of the other work),
   * "medley", "live", "instrumental" and so on. A partial or medley cover is not a whole cover.
   */
  attributes: z.array(z.string()),
  other: z.object({
    entity: z.enum(["recording", "work"]),
    mbid: z.string().min(1),
    title: z.string().min(1),
    /** The other recording's artist credit; null for a work. */
    artist: z.string().nullable(),
    /** The other recording's first release date; never set for a work. */
    firstReleaseDate: FirstReleaseDate,
  }),
});
export type RecordingRelation = z.infer<typeof RecordingRelation>;

/** One end of a second-hop relationship: a recording other than this one. */
const HopEnd = z.object({
  mbid: z.string().min(1),
  title: z.string().min(1),
  /** The recording's artist credit; null when MusicBrainz credits none. */
  artist: z.string().nullable(),
  firstReleaseDate: FirstReleaseDate,
});

/**
 * A relationship between two other recordings, as MusicBrainz files it (the second hop): `via`
 * is a recording this one samples, and `kind` reads from its side ("samples": `via` samples
 * `other`; "sampled-by": `other` samples `via`, a sibling of this recording).
 */
export const HopRelation = z.object({
  type: z.literal("hop"),
  source: z.literal("musicbrainz"),
  evidenceId: z.string().min(1),
  /** None: its item is about neither this recording, its song nor a release. */
  scope: z.null(),
  kind: z.enum(["samples", "sampled-by"]),
  attributes: z.array(z.string()),
  via: HopEnd,
  other: HopEnd,
});
export type HopRelation = z.infer<typeof HopRelation>;

/** A Discogs credit that names the track, or the whole release it is on. */
export const CreditRelation = z.object({
  type: z.literal("credit"),
  source: z.literal("discogs"),
  evidenceId: z.string().min(1),
  scope: z.enum(["track", "release"]),
  /** The name as Discogs credits it, with its disambiguation number ("Nirvana (2)"). */
  name: z.string().min(1),
  /** Discogs' id of the credited artist: two artists of one name are two credits. */
  artistId: z.number().int().nullable(),
  roles: z.array(z.string()),
});
export type CreditRelation = z.infer<typeof CreditRelation>;

/** The official release MusicBrainz names for the recording. */
export const ReleaseRelation = z.object({
  type: z.literal("release"),
  source: z.literal("musicbrainz"),
  evidenceId: z.string().min(1),
  scope: z.literal("release"),
  release: z.object({ mbid: z.string().min(1), title: z.string() }),
});
export type ReleaseRelation = z.infer<typeof ReleaseRelation>;

export const PrimaryRelation = z.discriminatedUnion("type", [
  RecordingRelation,
  CreditRelation,
  ReleaseRelation,
  HopRelation,
]);
export type PrimaryRelation = z.infer<typeof PrimaryRelation>;

/**
 * The relations the primary sources' records state, in source order, each with the item that
 * states it (one the source module built from the same record). A record without such an item,
 * or whose item does not state it in full (`statedBy`: an excerpt cut at the contract's length),
 * gives none: what is written is what a cache hit restores.
 */
export function primaryRelations(sources: PrimarySources): PrimaryRelation[] {
  const relations: PrimaryRelation[] = [];
  const all = new Map(sources.evidence.map((item) => [item.id, item]));
  const push = (relation: PrimaryRelation) => {
    const item = all.get(relation.evidenceId);
    if (item && statedBy(relation, item)) relations.push(relation);
  };
  const { musicbrainz, discogs } = sources;
  if (musicbrainz.status === "found") {
    const items = new Map(musicbrainz.evidence.map((item) => [item.id, item]));
    for (const item of musicbrainz.evidence) all.set(item.id, item);
    for (const record of musicbrainz.records) {
      const item = items.get(record.evidenceId);
      if (
        item &&
        record.about === "hop" &&
        record.via &&
        record.recording &&
        (record.kind === "samples" || record.kind === "sampled-by")
      ) {
        if (!record.via.title || !record.recording.title) continue;
        push({
          type: "hop",
          source: "musicbrainz",
          evidenceId: item.id,
          scope: null,
          kind: record.kind,
          attributes: [...record.attributes],
          via: hopEnd(record.via),
          other: hopEnd(record.recording),
        });
        continue;
      }
      const scope = item ? evidenceScope(item) : null;
      if (!item || (scope !== "track" && scope !== "work")) continue;
      const other = record.recording
        ? {
            entity: "recording" as const,
            mbid: record.recording.mbid,
            title: record.recording.title,
            artist: record.recording.artist || null,
            ...(record.recording.firstReleaseDate
              ? { firstReleaseDate: record.recording.firstReleaseDate }
              : {}),
          }
        : record.work
          ? {
              entity: "work" as const,
              mbid: record.work.mbid,
              title: record.work.title,
              artist: null,
            }
          : null;
      if (!other?.title) continue;
      push({
        type: "relation",
        source: "musicbrainz",
        evidenceId: item.id,
        scope,
        kind: record.kind,
        attributes: [...record.attributes],
        other,
      });
    }
    const release = sources.identity?.coverRelease;
    const releaseItem = release ? items.get(`musicbrainz:release/${release.mbid}`) : undefined;
    if (release && releaseItem) {
      push({
        type: "release",
        source: "musicbrainz",
        evidenceId: releaseItem.id,
        scope: "release",
        release: { mbid: release.mbid, title: release.title },
      });
    }
  }
  if (discogs.status === "found") {
    for (const item of discogs.evidence) all.set(item.id, item);
    for (const credit of discogs.records) {
      if (!credit.name.trim()) continue;
      push({
        type: "credit",
        source: "discogs",
        evidenceId: credit.evidenceId,
        scope: credit.scope,
        name: credit.name,
        artistId: credit.artistId,
        roles: [...credit.roles],
      });
    }
  }
  return relations;
}

/** A second hop's end as a relation keeps it. */
const hopEnd = (recording: MbRelatedRecording): HopRelation["via"] => ({
  mbid: recording.mbid,
  title: recording.title,
  artist: recording.artist || null,
  ...(recording.firstReleaseDate ? { firstReleaseDate: recording.firstReleaseDate } : {}),
});

/**
 * True when `item` states `relation` as its source module writes it: of its source and scope,
 * a recordRef naming the same kind of relation to the same record (or the same release, or a
 * Discogs credit), and an excerpt naming the same other record (title, artist credit and the
 * first release date the relation carries, or none), the same credited name and roles, or the
 * same release title.
 */
function statedBy(relation: PrimaryRelation, item: Evidence): boolean {
  if (relation.type === "hop") {
    // An item about two other recordings: no scope, the exact recordRef and sentence written.
    const { via, other, kind } = relation;
    return (
      item.source === "musicbrainz" &&
      evidenceScope(item) === null &&
      item.recordRef === hopRecordRef(via.mbid, kind, other.mbid) &&
      item.excerpt ===
        `MusicBrainz: ${quotedDated(via.title, via.artist, via.firstReleaseDate)} ${RELATION_PHRASE[kind]} ${quotedDated(other.title, other.artist, other.firstReleaseDate)}.`
    );
  }
  if (item.source !== relation.source || evidenceScope(item) !== relation.scope) return false;
  const ref = item.recordRef ?? "";
  const { excerpt } = item;
  switch (relation.type) {
    case "relation": {
      // With the first release date the relation carries, stated as it is: a date the item
      // does not state (or states otherwise) is not the record's.
      const { entity, mbid, title, artist, firstReleaseDate } = relation.other;
      return (
        ref.endsWith(`/${relation.kind}/${entity}/${mbid}`) &&
        excerpt.endsWith(` ${quotedDated(title, artist, firstReleaseDate)}.`)
      );
    }
    case "release":
      return (
        ref === `release/${relation.release.mbid}` &&
        excerpt.includes(` ${quoted(relation.release.title)}`)
      );
    case "credit":
      return (
        /^(?:track\/release\/\d+|release\/\d+)\/credit\/\d+$/.test(ref) &&
        excerpt.includes(` credits ${relation.name} as ${relation.roles.join(", ")} on `)
      );
  }
}

/**
 * Why cached relations are not ones this module would have read with `items`, or null: each
 * names an item among them that states it (`statedBy`: the same kind of relation to the same
 * record, with the same names), and no two name one item.
 */
export function relationsIssue(
  relations: readonly PrimaryRelation[],
  items: readonly Evidence[],
): string | null {
  const byId = new Map(items.map((item) => [item.id, item]));
  const seen = new Set<string>();
  for (const relation of relations) {
    const item = byId.get(relation.evidenceId);
    if (!item) return "a relation whose item is not in the evidence";
    if (!statedBy(relation, item)) return "a relation its item does not state";
    if (seen.has(relation.evidenceId)) return "two relations stated by one item";
    seen.add(relation.evidenceId);
  }
  return null;
}

/** The relations whose item is among `items` (the pack's size cap may leave some out). */
export function relationsIn(
  relations: readonly PrimaryRelation[],
  items: readonly Pick<Evidence, "id">[],
): PrimaryRelation[] {
  const ids = new Set(items.map((item) => item.id));
  return relations.filter((relation) => ids.has(relation.evidenceId));
}
