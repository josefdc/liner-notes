import type { GenealogyNode } from '../../types';
import { UNTITLED_TRACK } from './nodeTrack';

/** A year at the end of a label: "Title (1984)". */
const TRAILING_YEAR = /\s*\((?:19|20)\d{2}\)$/;

/**
 * What a track's card says: its title (the node's own, else its label without the year at its
 * end: the label is shown as the API wrote it, never split into a guessed artist), its artist
 * when the node names one, and its year when it carries one (null otherwise: the card shows none).
 */
export function cardWords(
  node: Partial<Pick<GenealogyNode, 'label' | 'trackTitle' | 'trackArtist'>>,
  year: number | null,
): { title: string; meta: string } {
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  const title =
    text(node.trackTitle) || text(node.label).replace(TRAILING_YEAR, '').trim() || UNTITLED_TRACK;
  const meta = [text(node.trackArtist), year === null ? '' : String(year)]
    .filter(Boolean)
    .join(' · ');
  return { title, meta };
}
