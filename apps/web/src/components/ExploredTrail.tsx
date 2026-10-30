import type React from 'react';
import {
  shownTrail,
  stepUrl,
  TRAIL_SHOWN,
  type Trail,
  type TrailStep,
  type TrailView,
} from '../router/trail';
import { useCompactBand } from '../utils/layout';
import { isPlainClick } from '../utils/plainClick';

interface ExploredTrailProps {
  trail: Trail;
  /** The track on screen, the trail's last step, and the view it is on. */
  current: { title: string; artist: string | null; url: string; view: TrailView };
  /** Opens a step of the trail in this page (a plain click on its link). */
  onOpen: (step: TrailStep, index: number) => void;
}

/** How many tracks the line names where the band must stay small, the one on screen included. */
const COMPACT_SHOWN = 2;

// One line, its names cut with an ellipsis (each whole in its link's name and its tooltip).
const LINK =
  'block min-w-0 truncate rounded-sm underline underline-offset-4 decoration-white/30 hover:text-white hover:decoration-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyber/70';

/** "Title · Artist", or the title alone; "(map)" for a full-size map. */
const nameOf = (step: { title: string; artist: string | null; view: TrailView }) =>
  `${step.artist ? `${step.title} · ${step.artist}` : step.title}${step.view === 'map' ? ' (map)' : ''}`;

/**
 * The tracks explored in this chain, oldest first, the one on screen last: each earlier one a
 * link to the view its next track was analysed from (its Player, or its full-size map). One
 * line, whatever the names: the last few are named (on a phone, or a window held sideways, only
 * the one before), and the line says how many earlier ones it leaves out.
 */
export const ExploredTrail: React.FC<ExploredTrailProps> = ({ trail, current, onOpen }) => {
  const compact = useCompactBand();
  const { steps, hidden } = shownTrail(trail, compact ? COMPACT_SHOWN : TRAIL_SHOWN);
  if (trail.steps.length === 0) return null;
  const currentName = nameOf(current);
  return (
    <nav
      aria-label="Explored tracks"
      data-explored-trail
      className="shrink-0 min-w-0 overflow-hidden px-4 md:px-6 py-1.5 border-b border-white/5 bg-void"
    >
      <ol className="flex flex-nowrap items-center gap-2 min-w-0 text-xs font-mono text-text-secondary">
        {hidden > 0 && (
          <li className="shrink-0 whitespace-nowrap text-text-tertiary">
            <span aria-hidden="true">… </span>
            {hidden === 1 ? '1 earlier' : `${hidden} earlier`}
            <span aria-hidden="true" className="ml-2">
              ›
            </span>
          </li>
        )}
        {steps.map(({ step, index }) => {
          const name = nameOf(step);
          return (
            <li
              key={`${index}:${step.trackId}`}
              // Compact, the one step named gets the room: the heading below names the track
              // on screen already.
              className={`min-w-0 flex items-center gap-2 ${compact ? 'flex-1 min-w-[40%]' : ''}`}
            >
              <a
                href={stepUrl(step)}
                title={name}
                onClick={(event) => {
                  if (!isPlainClick(event)) return;
                  event.preventDefault();
                  onOpen(step, index);
                }}
                className={LINK}
              >
                {name}
              </a>
              <span aria-hidden="true" className="shrink-0 text-text-tertiary">
                ›
              </span>
            </li>
          );
        })}
        {/* The track on screen keeps more of its name than the ones before it, but where the
            line is short it gives way first */}
        <li
          className={`flex ${compact ? 'min-w-[5ch] max-w-[40%] shrink-[2]' : 'min-w-0 shrink-0 max-w-[60%]'}`}
        >
          <a
            href={current.url}
            title={currentName}
            aria-current="page"
            // The page it names is the one on screen: a plain click stays here.
            onClick={(event) => {
              if (isPlainClick(event)) event.preventDefault();
            }}
            className="block min-w-0 truncate rounded-sm text-white font-semibold focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyber/70"
          >
            {currentName}
          </a>
        </li>
      </ol>
    </nav>
  );
};
