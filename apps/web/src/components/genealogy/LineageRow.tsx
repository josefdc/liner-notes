import type React from 'react';
import type { GenealogyNode } from '../../types';
import { Music } from 'lucide-react';
import { placeholderBackground } from '../../styles/placeholder';
import { isValidImageUrl } from '../../utils/image';
import { cardWords } from './cardWords';
import { relationLabel, relationToTrack, type ShownLink } from './links';
import { LINK_COLOR } from './linkStyle';

/**
 * The map when it has two relations or fewer: a compact row of cards instead of a canvas. The
 * tracks this one uses sit before it, the tracks that use it after it, each with its relation
 * between them in the words the canvas, the list and the cards use ("Sample", "Possible
 * sample"), its border solid when the link is sourced and dashed when it is not, and an arrow
 * only when the direction is known. Tracks with no link to this one follow, said so.
 */
export const LineageRow: React.FC<{
  nodes: readonly GenealogyNode[];
  links: readonly ShownLink[];
  currentId: string | null;
  /** A track's year, when it carries one. */
  yearOf: (id: string) => number | null;
  /** True for a track a sourced link says this one uses. */
  isOrigin: (id: string) => boolean;
  /** A track's name for screen readers: its relation and how it is known. */
  describe: (node: GenealogyNode) => string;
  onAnalyse: (node: GenealogyNode) => void;
  /** Room left at the top for the panel's heading, which lies over it (px). */
  topInset?: number;
}> = ({ nodes, links, currentId, yearOf, isOrigin, describe, onAnalyse, topInset = 0 }) => {
  const current = nodes.find((node) => node.id === currentId) ?? null;
  const byYear = (a: GenealogyNode, b: GenealogyNode) =>
    (yearOf(a.id) ?? Number.POSITIVE_INFINITY) - (yearOf(b.id) ?? Number.POSITIVE_INFINITY);
  const related = nodes
    .filter((node) => node.id !== currentId)
    .map((node) => ({ node, link: relationToTrack(links, node.id, currentId).link }));
  const sources = related
    .filter(({ link }) => current && link && link.target === current.id)
    .sort((a, b) => byYear(a.node, b.node));
  const later = related
    .filter(({ link }) => current && link && link.source === current.id)
    .sort((a, b) => byYear(a.node, b.node));
  const others = related.filter((item) => !sources.includes(item) && !later.includes(item));

  const card = (node: GenealogyNode) => {
    const { title, meta } = cardWords(node, yearOf(node.id));
    const isCurrent = node.id === currentId;
    const tag = isCurrent ? 'This track' : isOrigin(node.id) ? 'Origin' : null;
    const frame = isCurrent
      ? 'border-cyber/70'
      : isOrigin(node.id)
        ? 'border-analog/70'
        : 'border-white/25';
    const body = (
      <span
        data-lineage-card={node.id}
        className={`flex items-start gap-2 rounded-sm border bg-void px-2 py-1.5 text-left ${frame}`}
      >
        {isValidImageUrl(node.img) ? (
          <img src={node.img} alt="" className="size-7 shrink-0 rounded-sm object-cover" />
        ) : (
          // No cover: the neutral placeholder the map and the Dashboard's cards draw, not an
          // image of its own.
          <span
            aria-hidden="true"
            className="flex size-7 shrink-0 items-center justify-center rounded-sm text-text-tertiary"
            style={{ background: placeholderBackground }}
          >
            <Music size={14} />
          </span>
        )}
        <span className="flex min-w-0 flex-col font-mono text-chrome">
          <span className="text-text-primary wrap-break-word">{title}</span>
          {meta && <span className="text-text-tertiary wrap-break-word">{meta}</span>}
          {tag && <span className={isCurrent ? 'text-cyber' : 'text-analog'}>{tag}</span>}
        </span>
      </span>
    );
    if (isCurrent) return <div className="max-w-64">{body}</div>;
    return (
      <button
        type="button"
        aria-label={describe(node)}
        onClick={() => onAnalyse(node)}
        className="max-w-64 rounded-sm hover:brightness-125 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyber/70"
      >
        {body}
      </button>
    );
  };

  const relation = (link: ShownLink | null) => {
    if (!link) {
      return (
        <span className="font-mono text-chrome text-text-tertiary">
          {currentId === null ? 'No link to another track' : 'No direct link to this track'}
        </span>
      );
    }
    const arrow = link.directionKnown && link.type !== 'producer';
    return (
      <span
        data-relation-chip=""
        data-link-kind={link.kind}
        data-link-type={link.type}
        className="inline-flex w-fit items-center gap-1 rounded-sm border bg-void px-1.5 py-0.5 font-mono text-chrome text-text-secondary"
        style={{
          borderColor: LINK_COLOR[link.type],
          borderStyle: link.kind === 'sourced' ? 'solid' : 'dashed',
        }}
      >
        {relationLabel(link)}
        {arrow && (
          // Down where the row is a column, right where it is a row.
          <span
            aria-hidden="true"
            className="inline-block @max-xl:rotate-90"
            style={{ color: LINK_COLOR[link.type] }}
          >
            →
          </span>
        )}
      </span>
    );
  };

  return (
    // A row where the panel is wide enough (a container query: the xl column is narrow), else a
    // column, its arrows turned down.
    <div
      data-testid="lineage-row"
      className="@container flex flex-col gap-3 px-4 pb-3"
      style={{ paddingTop: topInset + 8 }}
    >
      <div className="flex flex-col gap-2 @xl:flex-row @xl:items-center">
        {sources.length > 0 && (
          <ul aria-label="Tracks this one uses" className="flex flex-col gap-2">
            {sources.map(({ node, link }) => (
              <li
                key={node.id}
                className="flex flex-col gap-1 @xl:flex-row @xl:items-center @xl:gap-2"
              >
                {card(node)}
                {relation(link)}
              </li>
            ))}
          </ul>
        )}
        {current && card(current)}
        {later.length > 0 && (
          <ul aria-label="Tracks that use this one" className="flex flex-col gap-2">
            {later.map(({ node, link }) => (
              <li
                key={node.id}
                className="flex flex-col gap-1 @xl:flex-row @xl:items-center @xl:gap-2"
              >
                {relation(link)}
                {card(node)}
              </li>
            ))}
          </ul>
        )}
      </div>
      {others.length > 0 && (
        <ul aria-label="Other tracks" className="flex flex-col gap-2">
          {others.map(({ node, link }) => (
            <li
              key={node.id}
              className="flex flex-col gap-1 @xl:flex-row @xl:items-center @xl:gap-2"
            >
              {card(node)}
              {relation(link)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
