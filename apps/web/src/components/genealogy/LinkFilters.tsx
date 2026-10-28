import type React from 'react';
import { useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { FILTER_LABEL, type FilterKind, isFiltering, type LinkFilter, NO_FILTER } from './filters';

/**
 * The map's filters: a box for each relation it has (and second hops), checked while its links
 * are shown, and "Sourced only". Folded under a button so the map keeps its room; how many links
 * are shown is said (and announced) while a filter is on, with a button that clears them. The
 * filters are not stored: a new result starts with every link.
 */
export const LinkFilters: React.FC<{
  /** The kinds of link the map has, with how many of each. */
  counts: ReadonlyArray<{ kind: FilterKind; count: number }>;
  /** How many links of each kind the filters show now. */
  shownOf: (kind: FilterKind) => number;
  /** What the filters did besides (a selected track's details they closed), said with the count. */
  note?: string | null;
  filter: LinkFilter;
  onChange: (filter: LinkFilter) => void;
  /** Links shown, and in all. */
  shown: number;
  total: number;
}> = ({ counts, shownOf, note = null, filter, onChange, shown, total }) => {
  const [open, setOpen] = useState(false);
  // Whether a filter was ever changed: clearing them then says every link is back.
  const [touched, setTouched] = useState(false);
  const groupId = useId();
  const filtering = isFiltering(filter);
  const change = (next: LinkFilter) => {
    setTouched(true);
    onChange(next);
  };
  const toggle = (kind: FilterKind) => {
    const off = new Set(filter.off);
    if (off.has(kind)) off.delete(kind);
    else off.add(kind);
    change({ ...filter, off });
  };
  const count = filtering
    ? `Showing ${shown} of ${total} ${total === 1 ? 'link' : 'links'}`
    : touched
      ? `Showing all ${total} ${total === 1 ? 'link' : 'links'}`
      : '';
  const said = [count, note].filter(Boolean).join('. ');
  // Every control at least 24 px tall (a touch target), its focus ring 2 px.
  const box =
    'inline-flex min-h-6 items-center gap-1.5 rounded-sm border px-1.5 py-0.5 cursor-pointer has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-cyber/70';
  return (
    // Its parts take their places in the line it is in; the boxes, open, on a line of their own.
    <div className="contents text-chrome font-mono text-text-chip">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-chrome font-mono text-text-chip">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={groupId}
          onClick={() => setOpen(!open)}
          className="inline-flex min-h-6 items-center gap-1 text-text-secondary hover:text-white rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyber/70"
        >
          Filter links
          <ChevronDown size={12} aria-hidden="true" className={open ? 'rotate-180' : undefined} />
        </button>
        <p
          aria-live="polite"
          aria-atomic="true"
          data-testid="filter-status"
          className={said ? '' : 'sr-only'}
        >
          {said}
        </p>
        {filtering && (
          <button
            type="button"
            onClick={() => change(NO_FILTER)}
            className="min-h-6 text-text-secondary underline underline-offset-2 hover:text-white rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyber/70"
          >
            Clear filters
          </button>
        )}
      </div>
      {open && (
        <fieldset
          id={groupId}
          className="basis-full flex flex-wrap items-center gap-1.5 text-chrome font-mono text-text-chip"
        >
          <legend className="sr-only">Show links</legend>
          {counts.map(({ kind, count: all }) => {
            const on = !filter.off.has(kind);
            return (
              <label
                key={kind}
                data-filter={kind}
                className={`${box} ${on ? 'border-white/30 text-text-secondary' : 'border-white/10 text-text-tertiary'}`}
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggle(kind)}
                  className="accent-cyber focus-visible:outline-none"
                />
                {FILTER_LABEL[kind]} ({shownOf(kind)}/{all})
              </label>
            );
          })}
          <label
            data-filter="sourced-only"
            className={`${box} ${filter.sourcedOnly ? 'border-analog/60 text-analog' : 'border-white/30 text-text-secondary'}`}
          >
            <input
              type="checkbox"
              checked={filter.sourcedOnly}
              onChange={() => change({ ...filter, sourcedOnly: !filter.sourcedOnly })}
              className="accent-analog focus-visible:outline-none"
            />
            Sourced only
          </label>
        </fieldset>
      )}
    </div>
  );
};
