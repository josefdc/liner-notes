import type React from 'react';

/** The `name` the graph's lists share: both lie over the graph, so one is open at a time. */
export const GRAPH_LISTS = 'genealogy-lists';

/**
 * A graph list's toggle handler: when it opens, the other lists beside it close. Browsers with
 * exclusive `<details name>` do that themselves (and this then finds nothing open); this does it
 * where they do not.
 */
export function closeOtherLists(event: React.SyntheticEvent<HTMLDetailsElement>) {
  const opened = event.currentTarget;
  if (!opened.open) return;
  const lists = opened.parentElement?.querySelectorAll<HTMLDetailsElement>(
    `:scope > details[name="${GRAPH_LISTS}"]`,
  );
  for (const other of lists ?? []) {
    if (other !== opened && other.open) other.open = false;
  }
}
