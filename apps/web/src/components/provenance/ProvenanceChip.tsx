import {
  BookOpen,
  ChevronDown,
  CircleDashed,
  CircleHelp,
  FileText,
  Gauge,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import type React from 'react';
import { Badge, type BadgeVariant } from '../ui/Badge';

// How a value or a claim is known, as a chip: an icon and words, never colour alone.
// - Measured (cyan, a gauge): read from the audio signal.
// - Sourced (amber, an open book): stated by a cited source. The book has no check mark: a
//   verifier's verdict is a chip of its own beside it.
// - Inferred (violet, sparkles): written or estimated by a model, and only that.
// - Record (neutral, a page): taken from source records by code, with no citation to show.
// - Unconfirmed (neutral, a question mark): shown, but nothing confirms how it was obtained.
// - Missing (neutral, a dashed circle): not there at all.

export type ProvenanceKind =
  | 'measured'
  | 'sourced'
  | 'inferred'
  | 'record'
  | 'unconfirmed'
  | 'missing';

const KINDS: Record<ProvenanceKind, { variant: BadgeVariant; icon: LucideIcon; text: string }> = {
  measured: { variant: 'measured', icon: Gauge, text: 'Measured' },
  sourced: { variant: 'sourced', icon: BookOpen, text: 'Sourced' },
  inferred: { variant: 'inferred', icon: Sparkles, text: 'Model inference' },
  record: { variant: 'neutral', icon: FileText, text: 'From source data' },
  unconfirmed: { variant: 'neutral', icon: CircleHelp, text: 'Not confirmed' },
  missing: { variant: 'neutral', icon: CircleDashed, text: 'Missing' },
};

/** The words a chip of a kind shows when it is given none of its own. */
export const PROVENANCE_TEXT: Record<ProvenanceKind, string> = Object.fromEntries(
  Object.entries(KINDS).map(([kind, { text }]) => [kind, text]),
) as Record<ProvenanceKind, string>;

/** A chip that opens and closes the provenance it summarises (a disclosure button). */
export interface ChipDisclosure {
  expanded: boolean;
  /** The id of the element the chip shows and hides. */
  controls: string;
  onToggle: () => void;
  /** The button's name: it starts with the chip's words, then says what it opens. */
  label: string;
}

interface ProvenanceChipProps {
  kind: ProvenanceKind;
  /** Words in place of the kind's own ("Model estimate", "From source data"). */
  children?: React.ReactNode;
  size?: 'sm' | 'md';
  title?: string;
  glow?: boolean;
  className?: string;
  disclosure?: ChipDisclosure;
}

export const ProvenanceChip: React.FC<ProvenanceChipProps> = ({
  kind,
  children,
  size = 'sm',
  title,
  glow = false,
  className = '',
  disclosure,
}) => {
  const { variant, icon: Icon, text } = KINDS[kind];
  const iconSize = size === 'md' ? 14 : 12;
  const chip = (
    <Badge
      variant={variant}
      size={size}
      glow={glow}
      icon={<Icon size={iconSize} />}
      title={disclosure ? undefined : title}
      data-provenance={kind}
      className={disclosure ? '' : className}
    >
      {children ?? text}
      {disclosure && (
        <ChevronDown
          size={iconSize}
          aria-hidden="true"
          className={`flex-shrink-0 transition-transform duration-(--duration-fast) ${disclosure.expanded ? 'rotate-180' : ''}`}
        />
      )}
    </Badge>
  );
  if (!disclosure) return chip;
  return (
    <button
      type="button"
      aria-expanded={disclosure.expanded}
      aria-controls={disclosure.controls}
      aria-label={disclosure.label}
      title={title}
      onClick={disclosure.onToggle}
      className={`inline-flex max-w-full rounded-sm cursor-pointer hover:brightness-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-void ${className}`}
    >
      {chip}
    </button>
  );
};

export default ProvenanceChip;
