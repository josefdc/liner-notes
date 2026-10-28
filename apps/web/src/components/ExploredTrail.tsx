import type React from 'react';
import { shownTrail, stepUrl, type Trail, type TrailStep } from '../router/trail';
import { isPlainClick } from '../utils/plainClick';

interface ExploredTrailProps {
  trail: Trail;
  /** The track on screen, the trail's last step. */
  current: { title: string; artist: string | null; url: string };
  /** Opens a step of the trail in this page (a plain click on its link). */
  onOpen: (step: TrailStep, index: number) => void;
}

const LINK =
  'break-words rounded-sm underline underline-offset-4 decoration-white/30 hover:text-white hover:decoration-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyber/70';

/** "Title · Artist", or the title alone. */
const nameOf = (step: { title: string; artist: string | null }) =>
  step.artist ? `${step.title} · ${step.artist}` : step.title;

/**
 * The tracks explored in this chain, oldest first, the one on screen last: each earlier one a
 * link to the view its next track was analysed from (its Player, or its full-size map). The
 * last few are named; the line says how many earlier ones it leaves out. It wraps: no width
 * scrolls it sideways.
 */
export const ExploredTrail: React.FC<ExploredTrailProps> = ({ trail, current, onOpen }) => {
  const { steps, hidden } = shownTrail(trail);
  if (trail.steps.length === 0) return null;
  return (
    <nav
      aria-label="Explored tracks"
      data-explored-trail
      className="shrink-0 min-w-0 px-4 md:px-6 py-2 border-b border-white/5 bg-void"
    >
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0 text-xs font-mono text-text-secondary">
        {hidden > 0 && (
          <li className="text-text-tertiary">
            <span aria-hidden="true">… </span>
            {hidden === 1 ? '1 earlier track' : `${hidden} earlier tracks`}
            <span aria-hidden="true" className="ml-2">
              ›
            </span>
          </li>
        )}
        {steps.map(({ step, index }) => (
          <li key={`${index}:${step.trackId}`} className="min-w-0 inline-flex items-center gap-2">
            <a
              href={stepUrl(step)}
              onClick={(event) => {
                if (!isPlainClick(event)) return;
                event.preventDefault();
                onOpen(step, index);
              }}
              className={LINK}
            >
              {nameOf(step)}
              {step.view === 'map' && <span className="text-text-tertiary"> (map)</span>}
            </a>
            <span aria-hidden="true" className="text-text-tertiary">
              ›
            </span>
          </li>
        ))}
        <li className="min-w-0">
          <a
            href={current.url}
            aria-current="page"
            // The page it names is the one on screen: a plain click stays here.
            onClick={(event) => {
              if (isPlainClick(event)) event.preventDefault();
            }}
            className="break-words rounded-sm text-white font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyber/70"
          >
            {nameOf(current)}
          </a>
        </li>
      </ol>
    </nav>
  );
};
