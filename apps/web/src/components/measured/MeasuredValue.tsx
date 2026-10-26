import type React from 'react';
import { useId, useState } from 'react';
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
  /** Method, model and analyzer; null when the result does not say. */
  detail?: string | null;
  /** The full provenance, for the tooltip. */
  title: string;
  icon?: React.ReactNode;
  size?: 'sm' | 'md';
  layout?: 'full' | 'compact' | 'bare';
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

/** The chip of each kind: its colour and icon, and its words, short enough for a chip. */
const CHIP: Record<MeasuredValueProps['kind'], { kind: ProvenanceKind; text: string }> = {
  measured: { kind: 'measured', text: 'Measured' },
  estimate: { kind: 'inferred', text: 'Model estimate' },
  unverified: { kind: 'unconfirmed', text: 'Not confirmed' },
  score: { kind: 'unconfirmed', text: 'v1 score' },
};

/**
 * The chip's words. A measured value or an estimate whose result gives neither its confidence
 * nor its basis (a result from an older API) says so on the chip itself: in the compact view it
 * must not look like a value with both.
 */
export function chipText(
  kind: MeasuredValueProps['kind'],
  confidence: string | null | undefined,
  basis: string | null | undefined,
): string {
  const unknown = !confidence && !basis && (kind === 'measured' || kind === 'estimate');
  return unknown ? `${CHIP[kind].text}, basis unknown` : CHIP[kind].text;
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

export const MeasuredValue: React.FC<MeasuredValueProps> = ({
  label,
  value,
  kind,
  confidence = null,
  basis = null,
  detail = null,
  title,
  icon,
  size = 'sm',
  layout = 'full',
}) => {
  const [open, setOpen] = useState(false);
  const linesId = useId();
  const provenance = provenanceText(kind, confidence, basis);
  const badge = BADGE[kind];
  const chip = chipText(kind, confidence, basis);
  const compact = layout === 'compact';
  const lines = (
    <>
      <span className={LINE}>{provenance}</span>
      {detail && <span className={LINE}>{detail}</span>}
    </>
  );
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
      {compact && (
        <span id={linesId} hidden={!open} className="flex flex-col items-start gap-1">
          {open && lines}
        </span>
      )}
    </span>
  );
};

export default MeasuredValue;
