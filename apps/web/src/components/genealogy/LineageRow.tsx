import type React from 'react';
import { Music } from 'lucide-react';
import type { GenealogyNode } from '../../types';
import { placeholderBackground } from '../../styles/placeholder';
import { isValidImageUrl } from '../../utils/image';
import { type CardDrawn, cardWords } from './cardWords';
import { relationLabel, relationSentence, relationToTrack, type ShownLink } from './links';
import { LINK_COLOR } from './linkStyle';

/** True for a link whose direction the row may draw: known, and not a shared producer. */
const directed = (link: ShownLink) => link.directionKnown && link.type !== 'producer';

/**
 * The map when it has two relations to the analysed track or fewer: a compact row of cards
 * instead of a canvas.
 * - The tracks this one uses sit before it and the tracks that use it after it, each with its
 *   relation between them, but only for a link whose direction is known (not a shared producer,
 *   nor a link whose years contradict it): that order says which record came from which.
 * - Every other track is in "Related tracks", in no order: its relation to this one without an
 *   arrow, or (a second hop) its best link to another track, said as a sentence naming both.
 * - With no analysed track, each link is drawn once, from its source to its target.
 * A relation is named in the words the canvas, the list and the cards use ("Sample", "Possible
 * sample"), its border solid when the link is sourced and dashed when it is not.
 */
export const LineageRow: React.FC<{
  nodes: readonly GenealogyNode[];
  links: readonly ShownLink[];
  currentId: string | null;
  /** A track's year, when it carries one. */
  yearOf: (id: string) => number | null;
  /** True for a track a sourced link says this one uses. */
  isOrigin: (id: string) => boolean;
  /**
   * A track's name for screen readers, from the words its card draws (`drawn`): then its
   * relation and how it is known.
   */
  describe: (node: GenealogyNode, drawn: CardDrawn) => string;
  /** How a relation names a track (its title and year). */
  nameOf: (id: string) => string;
  /** The selected track (its details are open under the row), if any. */
  selectedId?: string | null;
  /** A click or Enter on a card selects its track (or clears it, selected); it never analyses. */
  onSelect: (node: GenealogyNode) => void;
  /** Room left at the top for the panel's heading, which lies over it (px). */
  topInset?: number;
}> = ({
  nodes,
  links,
  currentId,
  yearOf,
  isOrigin,
  describe,
  nameOf,
  selectedId = null,
  onSelect,
  topInset = 0,
}) => {
  const current = nodes.find((node) => node.id === currentId) ?? null;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const byYear = (a: GenealogyNode, b: GenealogyNode) =>
    (yearOf(a.id) ?? Number.POSITIVE_INFINITY) - (yearOf(b.id) ?? Number.POSITIVE_INFINITY);
  const related = nodes
    .filter((node) => node.id !== currentId)
    .map((node) => ({
      node,
      link: current ? relationToTrack(links, node.id, current.id).link : null,
    }));
  const sources = related
    .filter(({ link }) => current && link && directed(link) && link.target === current.id)
    .sort((a, b) => byYear(a.node, b.node));
  const later = related
    .filter(({ link }) => current && link && directed(link) && link.source === current.id)
    .sort((a, b) => byYear(a.node, b.node));
  // The rest: a relation to this track without a known direction, or a second hop (the track's
  // best link to another track), or none.
  // With no analysed track the links show every linked track: only the others are listed here.
  const others = related
    .filter((item) => !sources.includes(item) && !later.includes(item))
    .map(({ node, link }) => ({
      node,
      link: current ? (link ?? relationToTrack(links, node.id, null).link) : null,
    }))
    .filter(
      ({ node }) =>
        current !== null || !links.some((l) => l.source === node.id || l.target === node.id),
    )
    // By year, the undated last.
    .sort((a, b) => byYear(a.node, b.node));

  const card = (node: GenealogyNode) => {
    const { title, meta } = cardWords(node, yearOf(node.id));
    const isCurrent = node.id === currentId;
    const tag = isCurrent ? 'This track' : isOrigin(node.id) ? 'Origin' : null;
    const selected = node.id === selectedId;
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
          {/* A space between the lines (a flex column draws none): they read apart, as drawn. */}
          <span className="text-text-primary wrap-break-word">{title}</span>
          {meta && ' '}
          {meta && <span className="text-text-tertiary wrap-break-word">{meta}</span>}
          {tag && ' '}
          {tag && <span className={isCurrent ? 'text-cyber' : 'text-analog'}>{tag}</span>}
        </span>
      </span>
    );
    if (isCurrent) return <div className="max-w-64">{body}</div>;
    return (
      <button
        type="button"
        aria-label={describe(node, {
          title: { lines: [title] },
          meta: { lines: meta ? [meta] : [] },
          tag,
        })}
        aria-pressed={selected}
        data-card-id={node.id}
        onClick={() => onSelect(node)}
        // Selected: a solid ring, apart from the card's frame (focus adds its own ring outside).
        // In forced-colors mode, where the focus is a solid outline too, the selection is dashed.
        className={`max-w-64 rounded-sm hover:brightness-125 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-cyber/70 focus-visible:ring-offset-2 focus-visible:ring-offset-void ${selected ? 'outline-2 outline-white outline-offset-1 forced-colors:outline-dashed' : ''}`}
      >
        {body}
      </button>
    );
  };

  /** A relation's chip; its arrow only where `arrow` (a known direction, drawn in order). */
  const chip = (link: ShownLink, arrow: boolean) => (
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

  const row = 'flex flex-col gap-1 @xl:flex-row @xl:items-center @xl:gap-2';
  return (
    // A row where the panel is wide enough (a container query), else a column, its arrows
    // turned down.
    <div
      data-testid="lineage-row"
      className="@container flex flex-col gap-3 px-4 pb-3"
      style={{ paddingTop: topInset + 8 }}
    >
      {current ? (
        <div className="flex flex-col gap-2 @xl:flex-row @xl:items-center">
          {sources.length > 0 && (
            <ul aria-label="Tracks this one uses" className="flex flex-col gap-2">
              {sources.map(({ node, link }) => (
                <li key={node.id} className={row}>
                  {card(node)}
                  {link && chip(link, true)}
                </li>
              ))}
            </ul>
          )}
          {card(current)}
          {later.length > 0 && (
            <ul aria-label="Tracks that use this one" className="flex flex-col gap-2">
              {later.map(({ node, link }) => (
                <li key={node.id} className={row}>
                  {link && chip(link, true)}
                  {card(node)}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        // No analysed track: each link once, from its source to its target.
        links.length > 0 && (
          <ul aria-label="Links" className="flex flex-col gap-2">
            {links.map((link, index) => {
              const [from, to] = [byId.get(link.source), byId.get(link.target)];
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: two tracks may share links
                <li key={index} className={row}>
                  {from && card(from)}
                  {chip(link, directed(link))}
                  {to && card(to)}
                </li>
              );
            })}
          </ul>
        )
      )}
      {others.length > 0 && (
        <ul aria-label="Related tracks" className="flex flex-col gap-2">
          {others.map(({ node, link }) => (
            <li key={node.id} className={row}>
              {card(node)}
              {link ? (
                <>
                  {chip(link, false)}
                  <span className="font-mono text-chrome text-text-tertiary">
                    {relationSentence(link, nameOf)}
                  </span>
                </>
              ) : (
                <span className="font-mono text-chrome text-text-tertiary">
                  {current ? 'No link to this track' : 'No link to another track'}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
