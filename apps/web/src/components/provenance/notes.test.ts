import { describe, expect, it } from 'vitest';
import type { ShownClaim } from './claims';
import { linerNotes, notesSectionOf } from './notes';
import { claim } from './testing';

const shown = (id: string, about: string): ShownClaim => ({
  claim: claim({ id, about: about as ShownClaim['claim']['about'] }),
  key: id,
  kind: 'inferred',
  cited: [],
  missingCitations: 0,
  rejected: false,
});

describe('the liner notes', () => {
  it('files each claim by its subject: credits, samples and covers, history, the rest', () => {
    expect(notesSectionOf('credit')).toBe('credits');
    expect(notesSectionOf('sample')).toBe('relations');
    expect(notesSectionOf('cover')).toBe('relations');
    expect(notesSectionOf('history')).toBe('history');
    for (const about of ['track', 'sound', 'production', 'connection', 'trivia', 'lyrics']) {
      expect(notesSectionOf(about)).toBe('more');
    }
  });

  it('keeps the result’s order in each section, and counts the claims a card shows instead', () => {
    const notes = linerNotes(
      [
        shown('h1', 'history'),
        shown('s1', 'sample'),
        shown('t1', 'trivia'),
        shown('c1', 'cover'),
        shown('h2', 'history'),
        shown('k1', 'credit'),
        shown('s2', 'sample'),
        shown('t2', 'trivia'),
      ],
      new Set(['s2', 'h1', 't2']),
    );
    const ids = (list: ShownClaim[]) => list.map((item) => item.claim.id);
    expect(ids(notes.credits.claims)).toEqual(['k1']);
    expect(ids(notes.relations.claims)).toEqual(['s1', 'c1']);
    expect(notes.relations.onCards).toBe(1);
    expect(ids(notes.history.claims)).toEqual(['h2']);
    expect(notes.history.onCards).toBe(1);
    expect(ids(notes.more)).toEqual(['t1']);
  });
});
