import type { LinkType } from '@liner-notes/contract';
import {
  linkProvenanceKind,
  provenanceText,
  relationLabel,
  relationSentence,
  type ShownLink,
} from '../genealogy/links';
import { isRelationSubject } from '../genealogy/relationWords';
import type { ShownClaim } from './claims';

// The liner notes of a result, below its fact cards: the claims no card shows, in sections, in
// this order: the credits; the samples and covers (every claim about a relation between two
// records: a sample, a cover, and the remixes and interpolations links state, which the contract
// files under "sample"); the history; and every other claim ("More claims"). A claim a card shows
// is not listed again: its section counts it instead.
//
// A remix or interpolation claim that no shown link states is named by its subject, "Sample" (or
// "Possible sample"): the contract files those relations under "sample", and only a link says
// which one it is. Its own text still names the relation.
//
// The samples and covers section also lists the relations the graph draws that no claim about a
// sample or cover states (results stored before claims, a link without a `claimId`): named as the
// graph names them, hedged unless the link is sourced, so the notes never say that none were
// found while the graph shows one.

/** One section's claims, and how many of its claims a card shows instead. */
export interface NotesSection {
  claims: ShownClaim[];
  onCards: number;
}

export interface LinerNotes {
  credits: NotesSection;
  /** Samples, covers, remixes and interpolations. */
  relations: NotesSection;
  history: NotesSection;
  /** Every other claim no card shows. */
  more: ShownClaim[];
}

type Section = 'credits' | 'relations' | 'history' | 'more';

/** The section a claim is listed in, by what it is about. */
export function notesSectionOf(about: string): Section {
  if (about === 'credit') return 'credits';
  if (isRelationSubject(about)) return 'relations';
  if (about === 'history') return 'history';
  return 'more';
}

/**
 * The result's shown claims (`ResultClaims.shown`) in the liner notes' sections, each in the
 * result's order; `onCards` holds the claim ids the fact cards show.
 */
export function linerNotes(
  shown: readonly ShownClaim[],
  onCards: ReadonlySet<string | undefined>,
): LinerNotes {
  const notes: LinerNotes = {
    credits: { claims: [], onCards: 0 },
    relations: { claims: [], onCards: 0 },
    history: { claims: [], onCards: 0 },
    more: [],
  };
  for (const item of shown) {
    const section = notesSectionOf(item.claim.about);
    const carded = onCards.has(item.claim.id);
    if (section === 'more') {
      if (!carded) notes.more.push(item);
    } else if (carded) {
      notes[section].onCards += 1;
    } else {
      notes[section].claims.push(item);
    }
  }
  return notes;
}

/** The relations between two records a link may state. */
const RELATION_LINK_TYPES: ReadonlySet<LinkType> = new Set<LinkType>([
  'sample',
  'interpolation',
  'cover',
  'remix',
]);

/** A drawn relation link listed in the notes, in words. */
export interface RelationLinkNote {
  key: string;
  /** The relation, as the graph names it ("Possible sample", "Cover"). */
  label: string;
  /** The relation as a sentence naming both tracks. */
  text: string;
  /** Where it comes from: its kind, what it cites, why it is not sourced. */
  detail: string;
  kind: 'sourced' | 'inferred' | 'unconfirmed';
}

/**
 * The drawn links that state a sample, interpolation, cover or remix and that no claim about a
 * sample or cover states (none, or one about something else), each in the graph's words.
 */
export function relationLinkNotes(
  links: readonly ShownLink[],
  nameOf: (id: string) => string,
): RelationLinkNote[] {
  return links.flatMap((link, index) => {
    if (link.statedType === null || !RELATION_LINK_TYPES.has(link.statedType)) return [];
    if (link.claim && isRelationSubject(link.claim.about)) return [];
    const label = relationLabel(link);
    const sentence = relationSentence(link, nameOf);
    // An unsourced relation's sentence starts with its label ("Possible sample: …"): said once.
    const text = sentence.startsWith(`${label}: `) ? sentence.slice(label.length + 2) : sentence;
    return [
      {
        key: `link-${index}`,
        label,
        text: `${text}.`,
        detail: `Drawn in Connections · ${provenanceText(link)}`,
        kind: linkProvenanceKind(link),
      },
    ];
  });
}
