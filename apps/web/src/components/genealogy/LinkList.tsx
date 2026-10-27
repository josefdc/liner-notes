import type React from 'react';
import { Pause, Play } from 'lucide-react';
import { provenanceText, relationSentence, type ShownLink } from './links';

/** The tracks' previews, played from the list (a preview never plays on hover). */
export interface LinkPreviews {
  /** The track's preview clip, if it has one (never for the analysed track). */
  urlOf: (id: string) => string | undefined;
  /** The track whose preview is playing, if any. */
  playingId: string | null;
  /** Plays the track's preview, or stops it when it is the one playing. */
  toggle: (id: string, url: string) => void;
}

/**
 * The genealogy graph's links as a list: for each one the relation as a sentence naming both
 * tracks, and where it comes from. The text alternative to the graph, collapsed by default.
 * Open, it lies over the graph instead of taking height from it, so opening it never lays the
 * graph out again.
 */
export const LinkList: React.FC<{
  links: readonly ShownLink[];
  nameOf: (id: string) => string;
  previews?: LinkPreviews;
}> = ({ links, nameOf, previews }) => {
  if (links.length === 0) return null;
  return (
    <details className="text-chrome font-mono text-text-chip">
      <summary className="cursor-pointer select-none text-text-secondary hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyber/70 rounded-sm">
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
            {previews &&
              [link.source, link.target].map((id) => {
                const url = previews.urlOf(id);
                if (!url) return null;
                const playing = previews.playingId === id;
                return (
                  <button
                    key={id}
                    type="button"
                    aria-label={`Play preview of ${nameOf(id)}`}
                    aria-pressed={playing}
                    onClick={() => previews.toggle(id, url)}
                    className={`ml-2 inline-flex items-center gap-1 rounded-sm border px-1.5 align-middle hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyber/70 ${playing ? 'border-cyber/50 text-cyber' : 'border-white/15 text-text-secondary'}`}
                  >
                    {playing ? (
                      <Pause size={10} aria-hidden="true" />
                    ) : (
                      <Play size={10} aria-hidden="true" />
                    )}
                    Preview
                  </button>
                );
              })}
          </li>
        ))}
      </ul>
    </details>
  );
};
