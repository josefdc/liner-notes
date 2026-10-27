import type { GenealogyNode } from '../../types';

/**
 * A label as the API writes a model node's, "Title - Artist (Year)": one " - " and a year from
 * 1900 to 2099 at the end.
 */
const MODEL_LABEL = /^(.+?) - (.+?)\s*\((?:19|20)\d{2}\)$/;
/** A year at the end of a label: "Title (1984)". */
const TRAILING_YEAR = /\s*\((?:19|20)\d{2}\)$/;

/** What a card calls a track whose node names no title at all. */
export const UNTITLED_TRACK = 'Untitled track';

/**
 * A genealogy node's track, as a card names it.
 *
 * The artist comes from the node's own `trackArtist` only, never from its label: a label's part
 * after " - " is not always an artist ("Song - Live at Wembley (1986)" reads exactly like "Song -
 * Artist (1986)"), and a code node whose record credits no artist is labelled with its title
 * alone. Without it the artist is null, and nothing is shown rather than a guess.
 *
 * The title is the node's `trackTitle`; without it, the title part of a label of the form
 * "Title - Artist (Year)" (one " - " and a year at the end), else the whole label without a year
 * at its end. A node with no title and an empty label is an "Untitled track", never its id.
 */
export function nodeTrack(
  node: Partial<Pick<GenealogyNode, 'id' | 'label' | 'trackTitle' | 'trackArtist'>>,
): { title: string; artist: string | null } {
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  const label = text(node.label);
  const parts = label.split(' - ').length === 2 ? MODEL_LABEL.exec(label) : null;
  const title =
    text(node.trackTitle) ||
    parts?.[1].trim() ||
    label.replace(TRAILING_YEAR, '').trim() ||
    label ||
    UNTITLED_TRACK;
  return { title, artist: text(node.trackArtist) || null };
}

/**
 * The text a related track is searched by when it is analysed: the node's own title, else its
 * label whole (the part of a label after " - " is never split off as an artist), else the title
 * `nodeTrack` reads; then the node's own artist when it names one. Empty when the node names
 * nothing to search by.
 */
export function nodeQuery(
  node: Partial<Pick<GenealogyNode, 'id' | 'label' | 'trackTitle' | 'trackArtist'>>,
): string {
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  const { title, artist } = nodeTrack(node);
  const named =
    text(node.trackTitle) || text(node.label) || (title === UNTITLED_TRACK ? '' : title);
  return named ? [named, artist].filter(Boolean).join(' ') : '';
}
