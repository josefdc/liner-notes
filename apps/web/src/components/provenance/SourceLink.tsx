import type { Evidence } from '@liner-notes/contract';
import { ExternalLink } from 'lucide-react';
import type React from 'react';
import { SOURCE_NAMES, safeHref, scopeText, sourceTierText } from './claims';

// One cited source: its name, its tier when the claim is shown as sourced (as the contract's
// evidence rules allow it, see sourceTier), and what its record is about when that is not this
// recording (the song, a whole release), as text. A web address that is not a plain http or
// https link (another scheme, a credential, a preview clip) is never made a link: the source is
// named, with its record.

interface SourceLinkProps {
  evidence: Evidence;
  /** Show the tier ("primary record", "editorial", "web page") after the name. */
  showTier?: boolean;
}

/** The visible text of a source: its name, its tier when shown, and its record's scope. */
export function sourceLabel(evidence: Evidence, showTier = true): string {
  const parts = [SOURCE_NAMES[evidence.source]];
  if (showTier) parts.push(sourceTierText(evidence));
  const scope = scopeText(evidence);
  if (scope) parts.push(scope);
  return parts.join(' · ');
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
  // The title is part of the link's name, once: no title attribute to announce it again.
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      data-source={evidence.source}
      className="inline-flex items-center gap-1 text-text-secondary underline underline-offset-2 decoration-white/30 hover:text-white hover:decoration-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyber focus-visible:ring-offset-2 focus-visible:ring-offset-void rounded-sm"
    >
      {label}
      <span className="sr-only">{title ? ` — ${title}` : ''}, opens in a new tab</span>
      <ExternalLink size={10} aria-hidden="true" className="flex-shrink-0" />
    </a>
  );
};

export default SourceLink;
