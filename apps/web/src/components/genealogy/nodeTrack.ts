import type { GenealogyNode } from '../../types';

/**
 * A genealogy node's track, as a card names it: its title and artist from the node's own fields,
 * else from its label, which the API writes as "Title - Artist (Year)" (the year optional). The
 * artist is null when neither names one: nothing is shown rather than an empty or a guessed one.
 */
export function nodeTrack(node: Pick<GenealogyNode, 'label' | 'trackTitle' | 'trackArtist'>): {
  title: string;
  artist: string | null;
} {
  const label = node.label.trim();
  const [labelTitle = '', ...rest] = label.split(' - ');
  const labelArtist = rest
    .join(' - ')
    .replace(/\s*\(\d{4}\)$/, '')
    .trim();
  const title =
    node.trackTitle?.trim() ||
    // A label without an artist may still end with the year: the title is what comes before it.
    (rest.length > 0 ? labelTitle.trim() : label.replace(/\s*\(\d{4}\)$/, '').trim()) ||
    label;
  const artist = node.trackArtist?.trim() || labelArtist || null;
  return { title, artist };
}
