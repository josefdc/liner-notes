import { ChevronDown } from 'lucide-react';
import type React from 'react';
import { useId, useState } from 'react';
import { formatSeconds } from '../../constants';
import { type ProvenanceKind, ProvenanceChip } from '../provenance/ProvenanceChip';
import { Badge, type BadgeVariant } from '../ui/Badge';

// One audio value as shown on the result screens, with where it comes from: measured from the
// signal, an audio model's score (an estimate, never called measured), a copy no measurement
// confirms, or a score on the first analyzer's own scale.
//
// - full (the detail views): its confidence and basis on one line, its method and analyzer on
//   the next, as text (not only a tooltip). A result that does not say how a value was measured
//   shows that as unknown.
// - compact (the Dashboard's summary): the value and a chip saying its kind; the chip is a
//   button that opens the same lines below it.
// - summary (the Player's hero): the value and one plain line saying how it is known ("Measured
//   from a 29.8 s preview"); a "How this was measured" button opens the same lines below it.
// - bare (a list whose heading states the provenance): the value alone, the provenance in its
//   tooltip.

export interface MeasuredValueProps {
  label: string;
  value: React.ReactNode;
  /**
   * measured: from the signal; estimate: an audio model's score; unverified: a copy whose
   * measurement could not be read; score: the first analyzer's 0-1 energy, on its own scale.
   */
  kind: 'measured' | 'estimate' | 'unverified' | 'score';
  /** The estimator's confidence, with its nature; null when the result does not say. */
  confidence?: string | null;
  /** What the value rests on (signal or model, and the preview window); null when unknown. */
  basis?: string | null;
  /** The length of the preview it was read from, in seconds; null when the result does not say. */
  previewSeconds?: number | null;
  /** Method, model and analyzer; null when the result does not say. */
  detail?: string | null;
  /** What only the tooltip says otherwise; the summary, which has no tooltip, shows it. */
  note?: string | null;
  /** The full provenance, for the tooltip. */
  title: string;
  icon?: React.ReactNode;
  size?: 'sm' | 'md';
  layout?: 'full' | 'compact' | 'summary' | 'bare';
}

export const KIND_TEXT: Record<MeasuredValueProps['kind'], string> = {
  measured: 'Measured',
  estimate: 'Model estimate',
  unverified: 'Not confirmed as measured',
  score: 'v1 energy score (0–1, saturates on loud masters)',
};

/** The provenance line: kind, confidence and basis, each said to be unknown when it is. */
export function provenanceText(
  kind: MeasuredValueProps['kind'],
  confidence: string | null | undefined,
  basis: string | null | undefined,
): string {
  const parts = [KIND_TEXT[kind]];
  if (!confidence && !basis) parts.push('confidence and basis unknown');
  else parts.push(confidence || 'confidence unknown', basis || 'basis unknown');
  return parts.join(' · ');
}

/** "a" or "an" before a number of seconds, as it is read aloud ("an 8 s", "an 11.5 s"). */
function article(seconds: string): string {
  const whole = seconds.split('.')[0];
  return whole.startsWith('8') || whole === '11' || whole === '18' ? 'an' : 'a';
}

/** Below this, a preview's length rounds to 0 s: the summary gives none. */
const SHORTEST_PREVIEW = 0.05;

/**
 * The summary's one line: how the value is known, in plain words, with the preview's length when
 * the result says it. A value whose result does not say what it rests on says so, as its chip
 * does, and does not name an estimator it does not know; the confidence, method and analyzer
 * are left to the lines behind the disclosure.
 */
export function summaryText(
  kind: MeasuredValueProps['kind'],
  basis: string | null | undefined,
  previewSeconds: number | null | undefined,
  confidence?: string | null,
): string {
  if (kind === 'unverified' || kind === 'score') return KIND_TEXT[kind];
  if (!basis) {
    const known = kind === 'measured' ? 'Measured' : 'Estimated';
    return confidence ? `${known}, basis unknown` : `${known}, confidence and basis unknown`;
  }
  const known = kind === 'measured' ? 'Measured' : 'Estimated by an audio model';
  if (previewSeconds == null || previewSeconds < SHORTEST_PREVIEW) return known;
  const seconds = formatSeconds(previewSeconds);
  return `${known} from ${article(seconds)} ${seconds} s preview`;
}

/** The summary's disclosure button, in words that never call an estimate measured. */
export const DISCLOSURE_TEXT: Record<MeasuredValueProps['kind'], string> = {
  measured: 'How this was measured',
  estimate: 'How this was estimated',
  unverified: 'Why this is not confirmed',
  score: 'About this score',
};

/** The chip of each kind: its colour and icon, and its words, short enough for a chip. */
const CHIP: Record<MeasuredValueProps['kind'], { kind: ProvenanceKind; text: string }> = {
  measured: { kind: 'measured', text: 'Measured' },
  estimate: { kind: 'inferred', text: 'Model estimate' },
  unverified: { kind: 'unconfirmed', text: 'Not confirmed' },
  score: { kind: 'unconfirmed', text: 'v1 score' },
};

/**
 * The chip's words. A value whose result does not say what it rests on (a result from an older
 * API, or a copy no measurement confirms) says so on the chip itself, exactly when its
 * provenance line says "basis unknown": the compact view must not make it look like a value with
 * a known basis. An older estimate always has a confidence (a fixed description of the score),
 * so the basis alone decides.
 */
export function chipText(
  kind: MeasuredValueProps['kind'],
  basis: string | null | undefined,
): string {
  return basis ? CHIP[kind].text : `${CHIP[kind].text}, basis unknown`;
}

/** The value's badge: the colour of how it is known; the label in a text colour, never faded. */
const BADGE: Record<MeasuredValueProps['kind'], { variant: BadgeVariant; label: string }> = {
  measured: { variant: 'measured', label: 'text-text-secondary' },
  estimate: { variant: 'inferred', label: 'text-text-secondary' },
  unverified: { variant: 'neutral', label: 'text-text-chip' },
  score: { variant: 'neutral', label: 'text-text-chip' },
};

// The provenance lines carry the meaning of the value: text-chip keeps them at WCAG AA. They wrap
// anywhere, so an analyser name wider than a narrow column breaks instead of being cut off.
const LINE = 'max-w-60 wrap-anywhere text-chrome font-mono text-text-chip text-left';

// The summary's disclosure: the lines' size and colour, a ring on keyboard focus; at least 24 px
// high to touch, the extra height taken from the space around it so the layout does not move.
const DISCLOSURE =
  'relative inline-flex min-h-6 -my-1 max-w-60 items-center gap-1 rounded-sm text-chrome font-mono text-text-chip text-left underline decoration-dotted underline-offset-2 cursor-pointer hover:text-text-secondary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-void';

export const MeasuredValue: React.FC<MeasuredValueProps> = ({
  label,
  value,
  kind,
  confidence = null,
  basis = null,
  previewSeconds = null,
  detail = null,
  note = null,
  title,
  icon,
  size = 'sm',
  layout = 'full',
}) => {
  const [open, setOpen] = useState(false);
  const linesId = useId();
  const provenance = provenanceText(kind, confidence, basis);
  const badge = BADGE[kind];
  const chip = chipText(kind, basis);
  const compact = layout === 'compact';
  const summary = layout === 'summary';
  // The summary has no tooltip: what only the tooltip says goes in its panel.
  const lines = (
    <>
      <span className={LINE}>{provenance}</span>
      {detail && <span className={LINE}>{detail}</span>}
      {summary && note && <span className={LINE}>{note}</span>}
    </>
  );
  // A summary panel that would only repeat its label ("Measured, confidence and basis unknown")
  // is not offered.
  const more =
    Boolean(confidence || basis || detail || note) || kind === 'unverified' || kind === 'score';
  return (
    <span
      data-value-kind={kind}
      title={layout === 'bare' ? `${title} · ${provenance}` : layout === 'full' ? title : undefined}
      className={
        compact
          ? 'flex w-full flex-col items-start gap-1 md:inline-flex md:w-auto'
          : 'inline-flex flex-col items-start gap-1 max-w-full'
      }
    >
      {/* Compact: the value and its chip are one unit, closer to each other than to the next
          value. From md up they share a line; on a narrow screen, where a value and its chip
          together are wider than the screen, every chip sits right under its value, at the
          same edge */}
      <span
        data-value-pair={compact || undefined}
        className={
          compact
            ? 'flex max-w-full flex-col items-start gap-1 md:flex-row md:flex-nowrap md:items-center'
            : 'inline-flex flex-wrap items-center gap-1.5 max-w-full'
        }
      >
        <Badge variant={badge.variant} size={size} icon={icon} title={compact ? title : undefined}>
          <span className={badge.label}>{label}</span> <span>{value}</span>
        </Badge>
        {compact && (
          <ProvenanceChip
            kind={CHIP[kind].kind}
            className="shrink-0"
            disclosure={{
              expanded: open,
              controls: linesId,
              onToggle: () => setOpen((shown) => !shown),
              label: `${chip}: how ${label} was obtained`,
            }}
          >
            {chip}
          </ProvenanceChip>
        )}
      </span>
      {layout === 'full' && lines}
      {summary && (
        <>
          <span className={LINE}>{summaryText(kind, basis, previewSeconds, confidence)}</span>
          {more && (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={linesId}
              onClick={() => setOpen((shown) => !shown)}
              className={DISCLOSURE}
            >
              {DISCLOSURE_TEXT[kind]}
              <span className="sr-only"> ({label})</span>
              <ChevronDown
                size={12}
                aria-hidden="true"
                className={`flex-shrink-0 transition-transform duration-(--duration-fast) ${open ? 'rotate-180' : ''}`}
              />
            </button>
          )}
        </>
      )}
      {(compact || (summary && more)) && (
        <span id={linesId} hidden={!open} className="flex flex-col items-start gap-1">
          {open && lines}
        </span>
      )}
    </span>
  );
};

export default MeasuredValue;
