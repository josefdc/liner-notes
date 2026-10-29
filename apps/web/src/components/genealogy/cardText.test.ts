import { describe, expect, it } from 'vitest';
import { fitCardText, SHORTENED_TEXT } from './cardText';
import { textUnits } from './lineageLayout';

// A 137-character title, as long as a real MusicBrainz remix's (#240).
const LONG =
  'Bright Lines (Candyland OG Version) (Tarraxa Remixed By DJ Somebody Famous Feat Cristian ' +
  'Kizomba and the Very Long Collective) [Extended]';
const options = {
  width: 208,
  widest: 352,
  step: 16,
  charPx: 7.44,
  minChars: 12,
  titleLines: 4,
  metaLines: 3,
};
/** The lines joined back into the words they were cut from. */
const joined = (lines: string[]) => lines.join(' ');

describe('a card’s words (#240)', () => {
  it('keeps the width every card takes when the words fit it', () => {
    const fit = fitCardText('Sweet Fruit', 'Early Band · 1983', options);
    expect(fit.width).toBe(208);
    expect(fit.shortened).toBeNull();
    expect(fit.title.lines).toEqual(['Sweet Fruit']);
  });

  it('grows a card wider, in steps, for a title too long for four lines, and keeps it whole', () => {
    expect(LONG.length).toBeGreaterThanOrEqual(120);
    const fit = fitCardText(LONG, 'DJ Somebody Famous · 2006', options);
    expect(fit.width).toBeGreaterThan(208);
    expect(fit.width).toBeLessThanOrEqual(352);
    expect((fit.width - 208) % 16).toBe(0);
    expect(fit.title.truncated).toBe(false);
    expect(fit.title.lines.length).toBeLessThanOrEqual(4);
    expect(joined(fit.title.lines)).toBe(LONG);
    expect(fit.shortened).toBeNull();
    // The least such width: a step narrower needs a fifth line.
    expect(
      fitCardText(LONG, '', { ...options, width: fit.width - 16, widest: fit.width - 16 }).title
        .truncated,
    ).toBe(true);
  });

  it('cuts words too long for the widest card, and says what it cut', () => {
    const fit = fitCardText(`${LONG} ${LONG}`, 'DJ Somebody Famous · 2006', options);
    expect(fit.width).toBe(352);
    expect(fit.title.truncated).toBe(true);
    expect(fit.title.lines.at(-1)?.endsWith('…')).toBe(true);
    expect(fit.shortened).toBe('title');
    expect(SHORTENED_TEXT[fit.shortened ?? 'title']).toBe('Title shortened');
    // Where no card may grow (a phone's column), the same title is cut at the column's width.
    const column = fitCardText(LONG, 'DJ Somebody Famous · 2006', { ...options, widest: 208 });
    expect(column.width).toBe(208);
    expect(column.shortened).toBe('title');
    const both = fitCardText(LONG, `${'Artist '.repeat(20)}· 2006`, { ...options, widest: 208 });
    expect(both.shortened).toBe('title and artist');
    const artist = fitCardText('Short', `${'Artist '.repeat(20)}· 2006`, {
      ...options,
      widest: 208,
    });
    expect(artist.shortened).toBe('artist');
  });

  it('says the year is shortened too where the cut artist line ended with it', () => {
    const credit =
      'Berliner Philharmoniker, Herbert von Karajan, Anne-Sophie Mutter, Yo-Yo Ma, Mark Zeltser, Wiener Singverein';
    const column = { ...options, width: 240, widest: 240 };
    const dated = fitCardText('Triple Concerto', `${credit} · 1980`, { ...column, metaYear: true });
    // The line's last word, the year, is gone with the cut: the card says so.
    expect(dated.meta.truncated).toBe(true);
    expect(dated.meta.lines.join(' ')).not.toContain('1980');
    expect(dated.shortened).toBe('artist and year');
    expect(SHORTENED_TEXT[dated.shortened ?? 'artist']).toBe('Artist and year shortened');
    // Undated: the artist alone is cut.
    expect(fitCardText('Triple Concerto', credit, column).shortened).toBe('artist');
    // And with the title cut too.
    const both = fitCardText(LONG, `${credit} · 1980`, { ...column, metaYear: true });
    expect(both.shortened).toBe('title, artist and year');
    expect(SHORTENED_TEXT['title, artist and year']).toBe('Title, artist and year shortened');
    // Whole: nothing said.
    expect(fitCardText('Song', 'Band · 1980', { ...column, metaYear: true }).shortened).toBeNull();
  });

  it('fits a Japanese title by the cells its characters take: whole on a wider card, else cut', () => {
    const title =
      '夜明けの街角で踊る二人の物語（シティポップ・リミックス・エクステンデッド・バージョン）〜真夜中のサウンドトラック・スペシャル・エディション〜';
    const artist = '山田花子とミッドナイト・オーケストラ · 2013';
    // Across the page (from 1280 px): a wider card holds it whole, no line wider than the card.
    const wide = fitCardText(title, artist, options);
    expect(wide.shortened).toBeNull();
    expect(wide.title.lines.map((line) => line.replace(/-$/, '')).join('')).toBe(title);
    const cells = Math.floor(wide.width / options.charPx);
    for (const line of [...wide.title.lines, ...wide.meta.lines]) {
      expect(textUnits(line) * options.charPx, line).toBeLessThanOrEqual(wide.width);
      expect(textUnits(line)).toBeLessThanOrEqual(cells);
    }
    // Down a phone's column (no wider card): cut, and said so.
    const column = fitCardText(title, artist, { ...options, widest: 208 });
    expect(column.shortened).toBe('title');
    for (const line of column.title.lines) {
      expect(textUnits(line) * options.charPx, line).toBeLessThanOrEqual(208);
    }
  });

  it('ends its search for a width whatever the step (none, or backwards)', () => {
    for (const step of [0, -16]) {
      const fit = fitCardText(LONG, 'DJ Somebody Famous · 2006', { ...options, step });
      expect(fit.width).toBeGreaterThanOrEqual(208);
      expect(fit.width).toBeLessThanOrEqual(352);
    }
  });

  it('never rewrites the words: a line break moves, the text stays the record’s', () => {
    const fit = fitCardText(LONG, 'DJ Somebody Famous · 2006', { ...options, width: 272 });
    expect(joined(fit.title.lines)).toBe(LONG);
    expect(joined(fit.meta.lines)).toBe('DJ Somebody Famous · 2006');
  });
});
