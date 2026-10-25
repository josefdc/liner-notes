import type React from 'react';
import { LINK_TYPE_LABEL, provenanceText, type ShownLink } from './links';

/**
 * The genealogy graph's links as a list: for each one the two tracks, the relation it is shown
 * as and where it comes from. The text alternative to the graph, collapsed by default.
 */
export const LinkList: React.FC<{
  links: readonly ShownLink[];
  labelOf: (id: string) => string;
}> = ({ links, labelOf }) => {
  if (links.length === 0) return null;
  return (
    <details className="group/links text-chrome font-mono text-text-chip">
      <summary className="cursor-pointer select-none text-text-secondary hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyber/50 rounded-sm">
        Links as a list ({links.length})
      </summary>
      <ul
        aria-label="Genealogy links"
        className="mt-1 flex flex-col gap-1.5 max-h-40 overflow-y-auto pr-1"
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
            <span className="text-text-secondary">
              {labelOf(link.source)} → {labelOf(link.target)}
            </span>
            : {LINK_TYPE_LABEL[link.type]}. <span>{provenanceText(link)}</span>.
          </li>
        ))}
      </ul>
    </details>
  );
};
