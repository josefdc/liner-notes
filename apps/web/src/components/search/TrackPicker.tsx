import type React from 'react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { SearchCandidate } from '../../hooks/agent/types';
import { CoverThumb } from '../AlbumCover';
import { scrollBehavior } from '../../utils/motion';

/** The picker's question: its heading and the name of its list. */
const PICKER_QUESTION = 'Is this the right track?';

/** The row a navigation key moves to, or null for other keys. The arrows wrap around. */
function rowFor(key: string, current: number, count: number): number | null {
  switch (key) {
    case 'ArrowDown':
      return (current + 1) % count;
    case 'ArrowUp':
      return (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/** The visible height of the nearest box that scrolls `element`, or of the window. */
function scrollAreaHeight(element: HTMLElement): number {
  for (let around = element.parentElement; around; around = around.parentElement) {
    const { overflowY } = getComputedStyle(around);
    if (overflowY === 'auto' || overflowY === 'scroll') return around.clientHeight;
  }
  return window.innerHeight;
}

interface TrackPickerProps {
  /** The tracks the server offers for the search; never empty. */
  candidates: SearchCandidate[];
  /** A row chosen with Enter or a click. */
  onPick: (candidate: SearchCandidate) => void;
  /** Leaves the picker for the search box, the run dropped ("Search again", Escape). */
  onSearchAgain?: () => void;
}

/**
 * The track picker: the tracks a search matched, as a single-select listbox (WAI-ARIA 1.2).
 * The focus moves from row to row (a roving tabindex: the highlighted row is the list's one Tab
 * stop), so the browser keeps the focused row in view and every screen reader follows it; the
 * focus is not held in a text box here, which is what `aria-activedescendant` is for.
 *
 * Nothing is chosen for the user: the run waits until a row is picked or the picker is left.
 *
 * Every track the server offers gets a row (a repeated track id once), so the rows always match
 * the count in the server's question. Rows are not merged as the search suggestions are: the
 * server sends no ISRC here, and two rows with one title and artist can be two takes (a studio
 * and a live one), of which the picker is the last place to choose.
 */
export function TrackPicker({ candidates, onPick, onSearchAgain }: TrackPickerProps) {
  const id = useId();
  const headingId = `${id}-question`;
  const hintId = `${id}-hint`;

  const rows = useMemo(() => {
    const seen = new Set<string>();
    return candidates.filter((candidate) => !seen.has(candidate.id) && seen.add(candidate.id));
  }, [candidates]);
  const [highlighted, setHighlighted] = useState(0);
  // A new list starts at its first row.
  const [listShown, setListShown] = useState(rows);
  if (listShown !== rows) {
    setListShown(rows);
    setHighlighted(0);
  }
  const current = Math.min(highlighted, rows.length - 1);

  const pickerRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);

  // When a list appears, the picker is brought into view and its first row takes the focus, so
  // the keys work at once. Scrolled no further than it takes to show it whole; when it is taller
  // than the area it scrolls in (a phone on its side), its top, the question, is aligned with
  // the area's top, never scrolled past. Smoothly, unless the reader asked for reduced motion.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new list is the trigger
  useEffect(() => {
    const picker = pickerRef.current;
    if (picker) {
      const fits = picker.getBoundingClientRect().height <= scrollAreaHeight(picker);
      picker.scrollIntoView?.({ behavior: scrollBehavior(), block: fits ? 'nearest' : 'start' });
    }
    rowRefs.current[0]?.focus({ preventScroll: true });
  }, [rows]);

  const moveTo = (index: number) => {
    setHighlighted(index);
    rowRefs.current[index]?.focus();
  };

  const handleListKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const row = rows[current];
      if (row) onPick(row);
      return;
    }
    // Space would scroll the page. It picks nothing: the arrows already select the row they
    // reach, and the analysis starts only with Enter or a click.
    if (event.key === ' ') {
      event.preventDefault();
      return;
    }
    const next = rowFor(event.key, current, rows.length);
    if (next !== null) {
      event.preventDefault();
      moveTo(next);
    }
  };

  return (
    // Escape anywhere in the picker leaves it, from a row or from "Search again". Not a named
    // region: the question names the list, and is read once.
    // biome-ignore lint/a11y/noStaticElementInteractions: only listens for Escape
    <div
      ref={pickerRef}
      className="mb-6"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && onSearchAgain) {
          event.preventDefault();
          onSearchAgain();
        }
      }}
    >
      {/* Animated inside the scrolled box: its entrance offset does not move where it scrolls */}
      <div className="animate-fade-in-up">
        <div className="text-center mb-3">
          <h2 id={headingId} className="text-sm font-mono font-normal text-text-secondary">
            {PICKER_QUESTION}
          </h2>
          <p id={hintId} className="text-chrome font-mono text-text-muted mt-1">
            {onSearchAgain
              ? 'Arrow keys to move, Enter to analyze, Esc to search again'
              : 'Arrow keys to move, Enter to analyze'}
          </p>
        </div>
        <div
          role="listbox"
          aria-labelledby={headingId}
          aria-describedby={hintId}
          onKeyDown={handleListKeyDown}
          className="space-y-1"
        >
          {rows.map((candidate, index) => (
            // Chosen with Enter (the list's keys) or a click.
            // biome-ignore lint/a11y/useKeyWithClickEvents: the list's own keys choose it
            <div
              key={candidate.id}
              ref={(element) => {
                rowRefs.current[index] = element;
              }}
              role="option"
              // Selection follows focus, as a single-select listbox allows: the row the arrows
              // reach is the selected one. Choosing it, which starts the analysis, takes Enter or
              // a click.
              aria-selected={index === current}
              tabIndex={index === current ? 0 : -1}
              onFocus={() => setHighlighted(index)}
              onClick={() => onPick(candidate)}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded-sm text-left cursor-pointer transition-all focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-void focus-visible:outline-none ${
                index === current
                  ? 'bg-white/10 border border-white/30'
                  : 'bg-white/5 border border-transparent hover:bg-white/10'
              }`}
            >
              <CoverThumb url={candidate.coverUrl} className="w-8 h-8 rounded" iconSize={12} />
              <div className="flex-1 min-w-0">
                <span className="text-white text-sm font-mono truncate block">
                  {candidate.title}
                </span>
                <span className="text-text-tertiary text-xs truncate block">
                  {candidate.artist} • {candidate.releaseYear || candidate.album}
                </span>
              </div>
              {/* Kept in the layout on every row, so moving the highlight moves nothing */}
              <span
                aria-hidden="true"
                className={`text-text-secondary text-xs font-mono flex-shrink-0 ${index === current ? '' : 'invisible'}`}
              >
                ▶
              </span>
            </div>
          ))}
        </div>
        <p className="text-xs font-mono text-text-tertiary mt-3 text-center">
          Nothing is analyzed until you choose a track.
        </p>
        {onSearchAgain && (
          <div className="mt-2 flex justify-center">
            <button
              type="button"
              onClick={onSearchAgain}
              className="px-2 py-1 text-xs font-mono text-text-secondary hover:text-text-primary underline underline-offset-4 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
            >
              Search again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
