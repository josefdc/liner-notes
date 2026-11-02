import type { GenealogyNode } from '../../types';
import { LABEL_YEAR, labelYear } from './links';
import { UNTITLED_TRACK } from './nodeTrack';

/**
 * What a track's card says: its title (the node's own, else its label as the API wrote it, never
 * split into a guessed artist; the year a label ends with is left out only when it is the year a
 * record gives the track, so a year the model wrote stays in its own words, never as the card's
 * year), its artist when the node names one, and its year as a record dates it (`recordYear`;
 * null otherwise: the card shows none, and its name says "undated").
 */
export function cardWords(
  node: Partial<Pick<GenealogyNode, 'label' | 'trackTitle' | 'trackArtist'>>,
  year: number | null,
): { title: string; artist: string | null; year: number | null; meta: string } {
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  const label = text(node.label);
  const title =
    text(node.trackTitle) ||
    (year !== null && labelYear(label) === year ? label.replace(LABEL_YEAR, '').trim() : label) ||
    UNTITLED_TRACK;
  const artist = text(node.trackArtist) || null;
  const meta = [artist ?? '', year === null ? '' : String(year)].filter(Boolean).join(' · ');
  return { title, artist, year, meta };
}

/**
 * A track's name as its card says it, in words: "Title by Artist (1984)", "(undated)" when it
 * carries no year. Its card, the detail box and screen readers name the track so, whole.
 */
export function cardName(
  node: Partial<Pick<GenealogyNode, 'label' | 'trackTitle' | 'trackArtist'>>,
  year: number | null,
): string {
  const { title, artist } = cardWords(node, year);
  return `${title}${artist ? ` by ${artist}` : ''} (${year ?? 'undated'})`;
}

/**
 * Lines of a card's words as drawn: which of them end inside a word (in a hyphen), and whether
 * the words were cut to fit (`wrapText`).
 */
export interface DrawnLines {
  lines: readonly string[];
  hyphenated?: readonly boolean[];
  truncated?: boolean;
}

/** A card's words as drawn, line by line: what its name says first (`cardSaid`). */
export interface CardDrawn {
  title: DrawnLines;
  meta: DrawnLines;
  tag: string | null;
  note?: DrawnLines;
}

/** The lines as one run of words: a space between lines, none after one ending in a hyphen. */
const joined = ({ lines, hyphenated = [] }: DrawnLines) =>
  lines.reduce(
    (text, line, i) => (i === 0 ? line : `${text}${hyphenated[i - 1] ? '' : ' '}${line}`),
    '',
  );

/**
 * A card's name as it reads on screen: the words it draws, in the order drawn (its title, its
 * artist and year, its tag, a note that words are cut), so a speech-input user can say what the
 * card shows and a screen reader reads those words first ("More Spell on You, Eddie Johns, 1979,
 * Origin"). Then, where the drawn words cut or break the title, the artist or the year, the
 * track's whole name in parentheses; where the card shows no year, "undated".
 */
export function cardSaid(
  node: Partial<Pick<GenealogyNode, 'label' | 'trackTitle' | 'trackArtist'>>,
  year: number | null,
  drawn: CardDrawn,
): string {
  const { title, artist, meta } = cardWords(node, year);
  const drawnMeta = joined(drawn.meta);
  // The artist and the year apart, said as a pause: "·" is a drawn mark, not a word. A line that
  // breaks at it draws no "·" (the year starts the next line), and reads the same.
  const metaSaid =
    artist !== null && year !== null && drawnMeta === `${artist} ${year}`
      ? `${artist}, ${year}`
      : drawnMeta.replace(/\s*·\s*/g, ', ');
  const words = [
    joined(drawn.title),
    metaSaid,
    drawn.tag ?? '',
    drawn.note ? joined(drawn.note) : '',
  ]
    .filter(Boolean)
    .join(', ');
  // The whole name follows where the card does not draw it whole: words cut to fit (and the
  // note that says so), a word broken at a line's end (with a hyphen, or with none: a long word
  // at a "/" or a wide script anywhere). Spaces between words and the "·" count for nothing.
  const wordsIn = (text: string) =>
    text
      .split(/[\s·]+/)
      .filter(Boolean)
      .join(' ');
  const broken = (lines: DrawnLines, whole: string) =>
    lines.truncated === true ||
    (lines.hyphenated ?? []).some(Boolean) ||
    wordsIn(lines.lines.join(' ')) !== wordsIn(whole);
  const cut =
    (drawn.note?.lines.length ?? 0) > 0 || broken(drawn.title, title) || broken(drawn.meta, meta);
  if (cut) return `${words} (${cardName(node, year)})`;
  return year === null ? `${words}, undated` : words;
}
