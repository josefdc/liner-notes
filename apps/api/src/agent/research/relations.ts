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
 * - "release": the official release MusicBrainz names for the recording (the #113 item).
 *
 * Relations travel with the evidence: the research cache keeps them beside its items, and a
 * cached relation is used only when the item it names states it (`relationsIssue`).
 */

import type { Evidence } from "@liner-notes/contract";
import { z } from "zod";
import type { PrimarySources } from "../../sources/identity.js";
import { evidenceScope } from "../../sources/records.js";

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

/** A relationship of the recording to another recording or work, as MusicBrainz files it. */
export const RecordingRelation = z.object({
  type: z.literal("relation"),
  source: z.literal("musicbrainz"),
  evidenceId: z.string().min(1),
  /** "track": a fact about this recording; "work": about the song it performs. */
  scope: z.enum(["track", "work"]),
  /** Read from this recording's side: "samples" means this recording samples the other. */
  kind: RelationKind,
  other: z.object({
    entity: z.enum(["recording", "work"]),
    mbid: z.string().min(1),
    title: z.string().min(1),
    /** The other recording's artist credit; null for a work. */
    artist: z.string().nullable(),
  }),
});
export type RecordingRelation = z.infer<typeof RecordingRelation>;

/** A Discogs credit that names the track, or the whole release it is on. */
export const CreditRelation = z.object({
  type: z.literal("credit"),
  source: z.literal("discogs"),
  evidenceId: z.string().min(1),
  scope: z.enum(["track", "release"]),
  name: z.string().min(1),
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
]);
export type PrimaryRelation = z.infer<typeof PrimaryRelation>;

/**
 * The relations the primary sources' records state, in source order, each with the item that
 * states it (one the source module built from the same record). A record without such an item
 * gives none.
 */
export function primaryRelations(sources: PrimarySources): PrimaryRelation[] {
  const relations: PrimaryRelation[] = [];
  const { musicbrainz, discogs } = sources;
  if (musicbrainz.status === "found") {
    const items = new Map(musicbrainz.evidence.map((item) => [item.id, item]));
    for (const record of musicbrainz.records) {
      const item = items.get(record.evidenceId);
      const scope = item ? evidenceScope(item) : null;
      if (!item || (scope !== "track" && scope !== "work")) continue;
      const other = record.recording
        ? {
            entity: "recording" as const,
            mbid: record.recording.mbid,
            title: record.recording.title,
            artist: record.recording.artist || null,
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
      relations.push({
        type: "relation",
        source: "musicbrainz",
        evidenceId: item.id,
        scope,
        kind: record.kind,
        other,
      });
    }
    const release = sources.identity?.coverRelease;
    const releaseItem = release ? items.get(`musicbrainz:release/${release.mbid}`) : undefined;
    if (release && releaseItem) {
      relations.push({
        type: "release",
        source: "musicbrainz",
        evidenceId: releaseItem.id,
        scope: "release",
        release: { mbid: release.mbid, title: release.title },
      });
    }
  }
  if (discogs.status === "found") {
    const ids = new Set(discogs.evidence.map((item) => item.id));
    for (const credit of discogs.records) {
      if (!ids.has(credit.evidenceId) || !credit.name.trim()) continue;
      relations.push({
        type: "credit",
        source: "discogs",
        evidenceId: credit.evidenceId,
        scope: credit.scope,
        name: credit.name,
        roles: [...credit.roles],
      });
    }
  }
  return relations;
}

/** The recordRef of the item that states a relation, as its source module writes it. */
function statedBy(relation: PrimaryRelation, item: Evidence): boolean {
  if (item.source !== relation.source || evidenceScope(item) !== relation.scope) return false;
  const ref = item.recordRef ?? "";
  switch (relation.type) {
    case "relation":
      return ref.endsWith(`/${relation.kind}/${relation.other.entity}/${relation.other.mbid}`);
    case "release":
      return ref === `release/${relation.release.mbid}`;
    case "credit":
      return /^(?:track\/release\/\d+|release\/\d+)\/credit\/\d+$/.test(ref);
  }
}

/**
 * Why cached relations are not ones this module would have read with `items`, or null: each
 * names an item among them, of its source and scope, whose recordRef states the same kind of
 * relation to the same other end, and no two name one item.
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
