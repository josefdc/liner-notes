import { colors } from './theme';

// The picture shown for a genealogy track without cover art: the graph's node and the Dashboard's
// connected-track card draw the same gradient and the same note. It is the same for every track,
// whatever its group: how a track relates to this one comes from its link (and the link's
// sources), never from its colour.

/** The placeholder's gradient, from its top-left to its bottom-right corner. */
export const PLACEHOLDER_GRADIENT = { from: colors.gray[600], to: colors.voidLighter } as const;

/**
 * The note on the placeholder: lucide's `music` icon (the Dashboard card draws it with
 * lucide-react's <Music>), in the dimmest text colour. Its shapes are on a 24-unit grid, stroked
 * 2 units wide with round ends, as lucide draws them.
 */
export const PLACEHOLDER_NOTE = {
  color: colors.text.tertiary,
  path: 'M9 18V5l12-2v13',
  circles: [
    { cx: 6, cy: 18, r: 3 },
    { cx: 18, cy: 16, r: 3 },
  ],
} as const;

/** The placeholder as a CSS background. */
export const placeholderBackground = `linear-gradient(135deg, ${PLACEHOLDER_GRADIENT.from}, ${PLACEHOLDER_GRADIENT.to})`;

/** The placeholder as an SVG data URL for a node of radius `size`: a disc with the note across half of it. */
export function placeholderImage(size: number): string {
  const { color, path, circles } = PLACEHOLDER_NOTE;
  const shapes = [
    `<path d="${path}"/>`,
    ...circles.map(({ cx, cy, r }) => `<circle cx="${cx}" cy="${cy}" r="${r}"/>`),
  ].join('');
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${size * 2}" height="${size * 2}" viewBox="0 0 100 100">
      <defs>
        <linearGradient id="placeholder" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${PLACEHOLDER_GRADIENT.from}"/>
          <stop offset="100%" stop-color="${PLACEHOLDER_GRADIENT.to}"/>
        </linearGradient>
      </defs>
      <circle cx="50" cy="50" r="50" fill="url(#placeholder)"/>
      <g transform="translate(26 26) scale(2)" fill="none" stroke="${color}" stroke-width="2"
         stroke-linecap="round" stroke-linejoin="round">${shapes}</g>
    </svg>
  `.trim();
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
