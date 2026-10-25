// Generated from tokens.css by apps/web/config/theme.mjs. Do not edit: change tokens.css
// and run `npm run theme -w apps/web` (every web build runs it too).
//
// The design tokens as values, for code that cannot use a CSS variable (D3, Recharts).

/** Every --color-* token, aliases resolved (--color-void-light is colors.voidLight). */
export const colors = {
  void: '#050505',
  voidLight: '#0a0a0a',
  voidLighter: '#121212',
  surface: 'rgba(255, 255, 255, 0.05)',
  surfaceHover: 'rgba(255, 255, 255, 0.08)',
  surfaceActive: 'rgba(255, 255, 255, 0.12)',
  surfaceSubtle: 'rgba(255, 255, 255, 0.03)',
  surfaceOverlay: 'rgba(0, 0, 0, 0.95)',
  white: '#ffffff',
  black: '#000000',
  border: 'rgba(255, 255, 255, 0.1)',
  borderHover: 'rgba(255, 255, 255, 0.2)',
  text: {
    primary: 'rgba(255, 255, 255, 0.95)',
    secondary: 'rgba(255, 255, 255, 0.7)',
    tertiary: 'rgba(255, 255, 255, 0.5)',
    muted: 'rgba(255, 255, 255, 0.5)',
    chip: 'rgba(255, 255, 255, 0.5)',
  },
  cyber: '#00f0ff',
  cyberDim: 'rgba(0, 240, 255, 0.1)',
  cyberMuted: 'rgba(0, 240, 255, 0.5)',
  analog: '#ffb000',
  analogDim: 'rgba(255, 176, 0, 0.1)',
  analogMuted: 'rgba(255, 176, 0, 0.5)',
  prov: {
    measured: '#00f0ff',
    sourced: '#ffb000',
    inferred: '#c084fc',
    missing: 'rgba(255, 255, 255, 0.5)',
  },
  viz: {
    cyan: '#00f0ff',
    amber: '#ffb000',
    purple: '#a855f7',
    pink: '#ec4899',
    blue: '#3b82f6',
    indigo: '#6366f1',
    green: '#22c55e',
    neutral: '#9ca3af',
  },
  success: '#22c55e',
  warning: '#ffb000',
  error: '#f87171',
  info: '#60a5fa',
  purple: '#a855f7',
  pink: '#ec4899',
  green: '#22c55e',
  indigo: '#6366f1',
  amber: '#ffb000',
  blue: '#3b82f6',
  spotify: '#1db954',
  gray: {
    300: '#d1d5db',
    400: '#9ca3af',
    500: '#6b7280',
    600: '#4b5563',
    700: '#374151',
    800: '#1f2937',
    900: '#111827',
  },
} as const;

/** Genealogy graph: node colours by group. */
export const genealogyColors = {
  current: colors.cyber,
  origin: colors.analog,
  sampler: colors.purple,
  influence: colors.green,
  default: colors.gray[500],
} as const;

/** Genealogy graph: link colours by type (the graph itself uses genealogy/linkStyle.ts). */
export const linkColors = {
  sample: colors.analog,
  cover: colors.purple,
  remix: colors.pink,
  influence: colors.gray[600],
  default: colors.gray[600],
} as const;

/** SmartTimeline: key moment marker colours. */
export const keyMomentColors = {
  energy_peak: colors.cyber,
  energy_drop: colors.pink,
  onset: colors.indigo,
  harmonic_change: colors.analog,
  silence: colors.gray[500],
} as const;
