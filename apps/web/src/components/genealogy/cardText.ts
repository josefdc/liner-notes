import { wrapText } from './lineageLayout';

type Wrapped = ReturnType<typeof wrapText>;

/** What a card's words lost to its size: none, its title, its artist and year, or both. */
export type Shortened = 'title' | 'artist' | 'title and artist' | null;

/** The words a card shows when its title or its artist and year is shortened. */
export const SHORTENED_TEXT: Record<Exclude<Shortened, null>, string> = {
  title: 'Title shortened',
  artist: 'Artist shortened',
  'title and artist': 'Title and artist shortened',
};

export interface CardTextOptions {
  /** The text width every card takes (px). */
  width: number;
  /** The widest a card's text may grow to show its words whole (px); at most `width` keeps it. */
  widest: number;
  /** The steps the width grows in (px). */
  step: number;
  /**
   * A monospace cell's width (px), and the fewest cells a line holds. A wide character (CJK, an
   * emoji) takes two cells (`graphemeUnits`).
   */
  charPx: number;
  minChars: number;
  titleLines: number;
  metaLines: number;
}

export interface CardText {
  /** The card's text width (px): `width`, or wider where its words need it. */
  width: number;
  title: Wrapped;
  meta: Wrapped;
  /** What is shortened on the card (null: nothing; its words are whole). */
  shortened: Shortened;
}

/**
 * A card's words in lines: at the width every card takes, else at the least wider width, in
 * steps of `step` up to `widest`, at which its title fits `titleLines` lines and its artist and
 * year `metaLines`. Words too long for the widest card are cut, and the card says which
 * (`shortened`): their whole text is in its name and its details. The words are the record's
 * own, never rewritten; only where a line breaks changes.
 */
export function fitCardText(title: string, meta: string, options: CardTextOptions): CardText {
  const { width, charPx, minChars, titleLines, metaLines } = options;
  // A step of a pixel at least: the search ends.
  const step = Math.max(1, options.step);
  const widest = Math.max(width, options.widest);
  const at = (textWidth: number) => {
    const chars = Math.max(minChars, Math.floor(textWidth / charPx));
    return {
      width: textWidth,
      title: wrapText(title, chars, titleLines),
      meta: meta
        ? wrapText(meta, chars, metaLines)
        : { lines: [], hyphenated: [], truncated: false },
    };
  };
  const whole = (fit: ReturnType<typeof at>) => !fit.title.truncated && !fit.meta.truncated;
  let fit = at(width);
  for (let next = width + step; !whole(fit) && next <= widest; next += step) fit = at(next);
  if (!whole(fit) && fit.width < widest) fit = at(widest);
  const shortened: Shortened = fit.title.truncated
    ? fit.meta.truncated
      ? 'title and artist'
      : 'title'
    : fit.meta.truncated
      ? 'artist'
      : null;
  return { ...fit, shortened };
}
