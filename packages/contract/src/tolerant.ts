/**
 * Tolerant readers. A cross-reference violation or an unknown value never rejects a result:
 * after a deploy, a page opened earlier may receive values it does not know yet (a new source,
 * claim subject, key moment type or link type). Lists of such items drop the items they cannot
 * read instead of failing, and optional single values the reader cannot read become absent.
 * Readers never display what they dropped.
 *
 * The snapshots record which lists and values are tolerant (snapshot.ts), so making one strict
 * again is a breaking change.
 */

import { z } from "zod";

const tolerantFilters = new WeakSet<object>();

/** An array of `item` that drops the entries `item` cannot parse. */
export function tolerantList<T extends z.ZodType>(item: T) {
  const list = z.preprocess(
    (value) =>
      Array.isArray(value) ? value.filter((entry) => item.safeParse(entry).success) : value,
    z.array(item),
  );
  tolerantFilters.add((list as unknown as { _zod: { def: { in: object } } })._zod.def.in);
  return list;
}

/** True for the filter step of a `tolerantList`. */
export function isTolerantFilter(step: object): boolean {
  return tolerantFilters.has(step);
}
