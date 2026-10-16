/**
 * Cyber-Noir Design System Theme Constants
 *
 * Single source of truth for all colors used in D3, Recharts, and JS logic.
 * Tailwind classes are generated from CSS variables in index.css.
 */

// Base color palette
const palette = {
  // Core Cyber-Noir
  void: '#050505',
  voidLight: '#0a0a0a',
  voidLighter: '#121212',

  cyber: '#00F0FF',
  analog: '#FFB000',

  // Tailwind-compatible grays
  // NOTE: These values are mirrored as CSS custom properties (--color-gray-*)
  // in src/styles/index.css for use in Tailwind utility classes.
  gray: {
    50: '#F9FAFB',
    100: '#F3F4F6',
    200: '#E5E7EB',
    300: '#D1D5DB',
    400: '#9CA3AF',
    500: '#6B7280',
    600: '#4B5563',
    700: '#374151',
    800: '#1F2937',
    900: '#111827',
  },

  // Accent colors (Tailwind-compatible)
  purple: '#A855F7',
  pink: '#EC4899',
  green: '#22C55E',
  indigo: '#6366F1',
  amber: '#F59E0B',
  blue: '#3B82F6',
  red: '#EF4444',
  cyan: {
    300: '#67E8F9',
    400: '#22D3EE',
  },
  amber300: '#FCD34D',
} as const;

/**
 * Main color export - use this for all color references
 */
export const colors = {
  // Core Palette
  void: palette.void,
  voidLight: palette.voidLight,
  voidLighter: palette.voidLighter,

  cyber: palette.cyber,
  cyberDim: 'rgba(0, 240, 255, 0.1)',
  cyberMuted: 'rgba(0, 240, 255, 0.5)',

  analog: palette.analog,
  analogDim: 'rgba(255, 176, 0, 0.1)',
  analogMuted: 'rgba(255, 176, 0, 0.5)',

  // Accent Colors
  purple: palette.purple,
  pink: palette.pink,
  green: palette.green,
  indigo: palette.indigo,
  amber: palette.amber,
  blue: palette.blue,

  // Neutrals
  gray: palette.gray,

  // Status (semantic)
  success: palette.green,
  warning: palette.amber,
  error: palette.red,
  info: palette.blue,

  // Brand
  spotify: '#1DB954',
  spotifyHover: '#1ed760',

  // Glow
  glowWhite: 'rgba(255, 255, 255, 0.15)',
  glowWhiteHover: 'rgba(255, 255, 255, 0.3)',
} as const;

/**
 * Genealogy Graph - Node group colors
 */
export const genealogyColors = {
  current: colors.cyber,      // Group 1 - Currently playing track
  origin: colors.analog,      // Group 2 - Sampled/source track
  sampler: colors.purple,     // Group 3 - Track that samples this
  influence: colors.green,    // Group 4 - Influenced by
  default: colors.gray[500],
} as const;

/**
 * Genealogy Graph - Link type colors
 */
export const linkColors = {
  sample: colors.analog,
  cover: colors.purple,
  remix: colors.pink,
  influence: colors.gray[600],
  default: colors.gray[600],
} as const;

/**
 * SmartTimeline - Key moment marker colors
 */
export const keyMomentColors = {
  energy_peak: colors.cyber,
  energy_drop: colors.pink,
  onset: colors.indigo,
  harmonic_change: colors.analog,
  silence: colors.gray[500],
} as const;

