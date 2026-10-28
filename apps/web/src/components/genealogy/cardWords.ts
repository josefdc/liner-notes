import type { GenealogyNode } from '../../types';
import { LABEL_YEAR, labelYear } from './links';
import { UNTITLED_TRACK } from './nodeTrack';

/**
 * What a track's card says: its title (the node's own, else its label without the year it ends
 * with: the label is shown as the API wrote it, never split into a guessed artist), its artist
 * when the node names one, and its year when it carries one (null otherwise: the card shows none,
 * and its name says "undated").
 */
export function cardWords(
  node: Partial<Pick<GenealogyNode, 'label' | 'trackTitle' | 'trackArtist'>>,
  year: number | null,
): { title: string; artist: string | null; year: number | null; meta: string } {
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  const label = text(node.label);
  const title =
    text(node.trackTitle) ||
    (labelYear(label) === null ? label : label.replace(LABEL_YEAR, '').trim()) ||
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
