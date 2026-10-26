/**
 * How strongly a genealogy link is drawn, by its relation, once the verifier has decided its
 * kind. A link that is not sourced is drawn as an influence, whatever relation was stated.
 */

import type { LinkKind, LinkType } from "@liner-notes/contract";

/** Strength 1-3 by relation: a documented sample is drawn strongest. */
export const LINK_VALUE: Readonly<Record<LinkType, number>> = {
  sample: 3,
  interpolation: 3,
  cover: 2,
  remix: 2,
  producer: 1,
  influence: 1,
};

/** The strength of a link that is not sourced: an influence's. */
export const INFERRED_LINK_VALUE = LINK_VALUE.influence;

/** The strength a link is drawn with, from its stated type and its kind. */
export function linkValue(type: LinkType | undefined, kind: LinkKind): number {
  return kind === "sourced" ? LINK_VALUE[type ?? "influence"] : INFERRED_LINK_VALUE;
}
