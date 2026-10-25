import type { Evidence } from '@liner-notes/contract';
import { ExternalLink } from 'lucide-react';
import type React from 'react';
import { SOURCE_NAMES, safeHref, sourceTierText } from './claims';

// One cited source: its name and, when the claim is shown as sourced, its tier, as text. A web
// address that is not http or https is never made a link: the source is named, with its record.

interface SourceLinkProps {
  evidence: Evidence;
  /** Show the tier ("primary record", "editorial", "web page") after the name. */
  showTier?: boolean;
}

/** The visible text of a source: its name, and its tier when shown. */
export function sourceLabel(evidence: Evidence, showTier = true): string {
  const name = SOURCE_NAMES[evidence.source];
  return showTier ? `${name} · ${sourceTierText(evidence)}` : name;
}

export const SourceLink: React.FC<SourceLinkProps> = ({ evidence, showTier = true }) => {
  const label = sourceLabel(evidence, showTier);
  const href = safeHref(evidence.url);
  const title = evidence.title.trim();
  if (!href) {
    const record = evidence.recordRef ? `record ${evidence.recordRef}` : 'no web link';
    return (
      <span data-source={evidence.source} title={title || undefined}>
        {label} <span className="break-all">({record})</span>
      </span>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      data-source={evidence.source}
      title={title || undefined}
      className="inline-flex items-center gap-1 text-text-secondary underline underline-offset-2 decoration-white/30 hover:text-white hover:decoration-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyber rounded-sm"
    >
      {label}
      <span className="sr-only">{title ? ` — ${title}` : ''}, opens in a new tab</span>
      <ExternalLink size={10} aria-hidden="true" className="flex-shrink-0" />
    </a>
  );
};

export default SourceLink;
