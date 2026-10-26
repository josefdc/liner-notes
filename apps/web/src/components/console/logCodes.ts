import {
  Activity,
  AudioLines,
  BookOpen,
  Brain,
  Info,
  ListChecks,
  type LucideIcon,
  Plug,
  Search,
  Waypoints,
} from 'lucide-react';

// How the run log (SystemConsole) and the activity log (ActivityLog) show a log code: a plain
// word and an icon for its family, in a neutral grey. Colour is kept for what it means elsewhere
// in the app: a warning or an error (by the code's suffix), and the inferred violet for a model
// step, the colour of what a model writes. The cyan and amber of measured and sourced data are
// never used here: a log line is neither.

export interface LogStyle {
  /** The family in words, with "warning" or "error" when the code says so. */
  label: string;
  /** The family's icon. */
  Icon: LucideIcon;
  /** The text colour class of the label and the icon. */
  tone: string;
}

export const LOG_TONES = {
  neutral: 'text-text-tertiary',
  warning: 'text-status-warning',
  error: 'text-status-error',
  model: 'text-prov-inferred',
} as const;

const FAMILIES: Record<string, { label: string; Icon: LucideIcon }> = {
  NET: { label: 'Network', Icon: Plug },
  AUDIO: { label: 'Audio', Icon: AudioLines },
  // GEMINI-* codes come from runs recorded before the model provider layer; LLM-* since.
  GEMINI: { label: 'Model', Icon: Brain },
  LLM: { label: 'Model', Icon: Brain },
  SPOTIFY: { label: 'Spotify', Icon: Search },
  RESEARCH: { label: 'Sources', Icon: BookOpen },
  GRAPH: { label: 'Graph', Icon: Waypoints },
  SYS: { label: 'System', Icon: Info },
};

// A code from a newer API that this page does not know yet.
const OTHER = { label: 'Other', Icon: Activity };

const MODEL_FAMILIES = new Set(['GEMINI', 'LLM']);

/**
 * The label, icon and colour of a log line, from its code and the graph node that sent it.
 * A line without a code is the app's own (searching, resuming, connected): a system line.
 */
export function logStyle(code?: string, node?: string): LogStyle {
  const prefix = code ? code.split('-')[0] : 'SYS';
  const suffix = code?.split('-').at(-1);
  const family = FAMILIES[prefix] ?? OTHER;
  const model = MODEL_FAMILIES.has(prefix);

  // The verifier checks the notes against their sources: its lines say so, whatever their code.
  let label = family.label;
  let Icon = family.Icon;
  if (node === 'verifier') {
    label = model ? 'Model check' : 'Check';
    Icon = ListChecks;
  }

  if (suffix === 'ERROR') return { label: `${label} error`, Icon, tone: LOG_TONES.error };
  if (suffix === 'WARN') return { label: `${label} warning`, Icon, tone: LOG_TONES.warning };
  return { label, Icon, tone: model ? LOG_TONES.model : LOG_TONES.neutral };
}
