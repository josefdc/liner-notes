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
