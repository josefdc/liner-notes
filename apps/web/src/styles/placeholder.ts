import { colors } from './theme';

// The picture shown for a genealogy track without cover art: the graph's node and the Dashboard's
// connected-track card draw the same gradient. It is the same for every track, whatever its group:
// how a track relates to this one comes from its link (and the link's sources), never from its
// colour.

/** The placeholder's gradient, from its top-left to its bottom-right corner. */
export const PLACEHOLDER_GRADIENT = { from: colors.gray[800], to: colors.voidLighter } as const;

/** The music note drawn on the graph's placeholder, and its opacity. */
const NOTE = { color: colors.white, opacity: 0.3 };

/** The placeholder as a CSS background. */
export const placeholderBackground = `linear-gradient(135deg, ${PLACEHOLDER_GRADIENT.from}, ${PLACEHOLDER_GRADIENT.to})`;

/** The placeholder as an SVG data URL for a node of radius `size`: a disc with a music note. */
export function placeholderImage(size: number): string {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${size * 2}" height="${size * 2}" viewBox="0 0 100 100">
      <defs>
        <linearGradient id="placeholder" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${PLACEHOLDER_GRADIENT.from}"/>
          <stop offset="100%" stop-color="${PLACEHOLDER_GRADIENT.to}"/>
        </linearGradient>
      </defs>
      <circle cx="50" cy="50" r="50" fill="url(#placeholder)"/>
      <path d="M40 30v30c-2.5-2-6-3-10-3-5.5 0-10 3.5-10 8s4.5 8 10 8 10-3.5 10-8V38l20-5v22c-2.5-2-6-3-10-3-5.5 0-10 3.5-10 8s4.5 8 10 8 10-3.5 10-8V25L40 30z"
            fill="${NOTE.color}" fill-opacity="${NOTE.opacity}"/>
    </svg>
  `.trim();
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
