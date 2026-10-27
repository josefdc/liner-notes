import type { GenealogyNode } from '../../types';

/** A label as the API writes a model node's: "Title - Artist (Year)", one " - " and a year. */
const MODEL_LABEL = /^(.+?) - (.+?)\s*\((\d{4})\)$/;
/** A year at the end of a label: "Title (1984)". */
const TRAILING_YEAR = /\s*\(\d{4}\)$/;

/**
 * A genealogy node's track, as a card names it: its title and artist from the node's own fields
 * (`trackTitle`, `trackArtist`). Without them, the label is read as "Title - Artist (Year)" only
 * when it has exactly that form (one " - " and a year at the end); any other label is the title
 * (without a year at its end), and the artist is null: nothing is shown rather than a guess. A
 * label such as "Song - Live at Wembley" names no artist, and a code node whose record credits
 * none is labelled with its title alone.
 */
export function nodeTrack(
  node: Partial<Pick<GenealogyNode, 'id' | 'label' | 'trackTitle' | 'trackArtist'>>,
): { title: string; artist: string | null } {
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  const label = text(node.label);
  const ownTitle = text(node.trackTitle);
  const ownArtist = text(node.trackArtist);
  const parts = label.split(' - ').length === 2 ? MODEL_LABEL.exec(label) : null;
  const parsed = parts ? { title: parts[1].trim(), artist: parts[2].trim() } : null;
  const title =
    ownTitle || parsed?.title || label.replace(TRAILING_YEAR, '').trim() || label || text(node.id);
  // The label's artist only for the track the label names: never under another title.
  const labelArtist = parsed && (!ownTitle || ownTitle === parsed.title) ? parsed.artist : '';
  return { title, artist: ownArtist || labelArtist || null };
}
