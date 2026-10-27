import { isRelationSubject } from '../genealogy/relationWords';
import type { ShownClaim } from './claims';

// The liner notes of a result, below its fact cards: the claims no card shows, in sections, in
// this order: the credits; the samples and covers (every claim about a relation between two
// records: a sample, a cover, and the remixes and interpolations links state, which the contract
// files under "sample"); the history; and every other claim ("More claims"). A claim a card shows
// is not listed again: its section counts it instead.

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
