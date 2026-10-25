import type React from 'react';
import { provenanceText, relationSentence, type ShownLink } from './links';

/**
 * The genealogy graph's links as a list: for each one the relation as a sentence naming both
 * tracks, and where it comes from. The text alternative to the graph, collapsed by default.
 * Open, it lies over the graph instead of taking height from it, so opening it never lays the
 * graph out again.
 */
export const LinkList: React.FC<{
  links: readonly ShownLink[];
  nameOf: (id: string) => string;
}> = ({ links, nameOf }) => {
  if (links.length === 0) return null;
  return (
    <details className="text-chrome font-mono text-text-chip">
      <summary className="cursor-pointer select-none text-text-secondary hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyber/50 rounded-sm">
        Links as a list ({links.length})
      </summary>
      <ul
        aria-label="Genealogy links"
        className="absolute bottom-full left-0 right-0 z-30 flex flex-col gap-1.5 max-h-[min(15rem,35dvh)] overflow-y-auto border-t border-white/10 bg-void px-4 py-3"
      >
        {links.map((link, index) => (
          <li
            // Links have no id: two tracks may be joined by more than one relation.
            // biome-ignore lint/suspicious/noArrayIndexKey: the list is rebuilt with the graph
            key={index}
            data-link-index={index}
            data-link-kind={link.kind}
            data-link-type={link.type}
          >
            <span className="text-text-secondary">{relationSentence(link, nameOf)}.</span>{' '}
            {provenanceText(link)}.
          </li>
        ))}
      </ul>
    </details>
  );
};
