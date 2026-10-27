import { describe, expect, it } from 'vitest';
// The API's own wording, which the picker's question must repeat word for word.
import { choiceMessage } from '../../../../api/src/agent/trackMatch';
import type { SearchCandidate } from '../../hooks/agent/types';
import { pickerQuestion, pickerRows } from './pickerRows';

/** A release of Cash's "Hurt" (one ISRC), clean and 3:38 long unless changed. */
const hurt = (id: string, change: Partial<SearchCandidate> = {}): SearchCandidate => ({
  id,
  title: 'Hurt',
  artist: 'Johnny Cash',
  album: `Album ${id}`,
  coverUrl: '',
  isrc: 'USUM70207211',
  explicit: false,
  durationMs: 218_000,
  ...change,
});
const ids = (rows: SearchCandidate[]) => pickerRows(rows).map((row) => row.id);

describe('pickerRows', () => {
  it('merges a remaster under the same ISRC, explicit value and length (within 2 s)', () => {
    expect(
      ids([
        hurt('album', { releaseDate: '2002-11-05' }),
        hurt('remaster', { releaseDate: '2014-03-01', durationMs: 219_500 }),
      ]),
    ).toEqual(['album']);
  });

  it('keeps an explicit and a clean version apart, though they share an ISRC', () => {
    expect(ids([hurt('clean'), hurt('explicit', { explicit: true })])).toEqual([
      'clean',
      'explicit',
    ]);
  });

  it('keeps two edits apart (3:30 and 5:10), though they share an ISRC', () => {
    expect(
      ids([hurt('edit', { durationMs: 210_000 }), hurt('full', { durationMs: 310_000 })]),
    ).toEqual(['edit', 'full']);
  });

  it('never merges rows whose length is not known, or that have no ISRC', () => {
    expect(
      ids([hurt('a', { durationMs: undefined }), hurt('b', { durationMs: undefined })]),
    ).toEqual(['a', 'b']);
    expect(ids([hurt('a', { isrc: null }), hurt('b', { isrc: null })])).toEqual(['a', 'b']);
  });

  it('keeps the earliest release, listed first or not, in the place of the first listed', () => {
    const album = hurt('album', { releaseDate: '2002-11-05' });
    const compilation = hurt('compilation', { releaseDate: '2008' });
    const other = hurt('nin', { artist: 'Nine Inch Nails', isrc: 'USIR19400001' });
    expect(ids([album, other, compilation])).toEqual(['album', 'nin']);
    expect(ids([compilation, other, album])).toEqual(['album', 'nin']);
  });

  it('prefers a dated release to one dated "0000" or not at all; of two undated, the first', () => {
    expect(
      ids([hurt('unknown', { releaseDate: '0000' }), hurt('dated', { releaseDate: '2002' })]),
    ).toEqual(['dated']);
    expect(
      ids([hurt('dated', { releaseDate: '2002' }), hurt('none', { releaseDate: null })]),
    ).toEqual(['dated']);
    expect(ids([hurt('first'), hurt('second', { releaseDate: '0000' })])).toEqual(['first']);
  });

  it('compares dates as far as both go: a year is not before a day in it', () => {
    expect(
      ids([hurt('day', { releaseDate: '2002-11-05' }), hurt('year', { releaseDate: '2002' })]),
    ).toEqual(['day']);
  });
});

describe('pickerQuestion', () => {
  it.each([1, 2, 5])('says what the API says for %i rows', (count) => {
    expect(pickerQuestion(count)).toBe(choiceMessage(count));
  });
});
