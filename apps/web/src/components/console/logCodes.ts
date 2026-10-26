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
  VERIFY: { label: 'Check', Icon: ListChecks },
  SYS: { label: 'System', Icon: Info },
};

// A code from a newer API that this page does not know yet.
const OTHER = { label: 'Other', Icon: Activity };

const MODEL_FAMILIES = new Set(['GEMINI', 'LLM']);

// The family of a line without a code, by the graph node that sent it. The research subgraph
// sends its planning and tool lines without one.
const NODE_FAMILIES: Record<string, string> = {
  scout: 'SPOTIFY',
  engineer: 'AUDIO',
  historian: 'RESEARCH',
  research_manager: 'RESEARCH',
  research_tool: 'RESEARCH',
  composer: 'LLM',
};

// Runs recorded before the codes carried a warning in the text instead: "⚠️ MusicBrainz could
// not be read".
const LEGACY_WARNING = /^\s*⚠/u;

/**
 * The label, icon and colour of a log line, from its code, the graph node that sent it and,
 * for a line without a code, its text. A line without a code is labelled by its node; one
 * without either is the app's own (searching, resuming, connected): a system line.
 */
export function logStyle(code?: string, node?: string, message?: string): LogStyle {
  const prefix = code ? code.split('-')[0] : ((node && NODE_FAMILIES[node]) ?? 'SYS');
  const suffix = code?.split('-').at(-1);
  const family = FAMILIES[prefix] ?? OTHER;
  const model = MODEL_FAMILIES.has(prefix);

  // The verifier's model lines are its checks of the notes against their sources; its other
  // lines (a cover-art lookup) keep their own family.
  let label = family.label;
  let Icon = family.Icon;
  if (node === 'verifier' && model) {
    label = 'Model check';
    Icon = ListChecks;
  }

  // A failed request (NET-400, NET-500) is an error too.
  const failed = suffix === 'ERROR' || (prefix === 'NET' && Number(suffix) >= 400);
  const warned = suffix === 'WARN' || (!code && LEGACY_WARNING.test(message ?? ''));
  if (failed) return { label: `${label} error`, Icon, tone: LOG_TONES.error };
  if (warned) return { label: `${label} warning`, Icon, tone: LOG_TONES.warning };
  return { label, Icon, tone: model ? LOG_TONES.model : LOG_TONES.neutral };
}
