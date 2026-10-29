import type { CardBox, Orientation, ViewBreaks, YearSlot } from './lineageLayout';

/**
 * The song-relations map's first view, at its size (zoom 1: its text at 12 px, never smaller):
 * - a map that fits the room is shown whole, centred along its axis;
 * - a larger one shows the analysed track's card whole. Across the page the view starts at the
 *   earliest dated year from which that card fits (never at the "Undated" column, unless every
 *   card is undated); down a phone's column it is centred on that card, as far as the map
 *   allows, starting at a year's label;
 * - where cards lie past the view, a strip at its bottom holds the edge cues ("4 more →"), and
 *   the layout is given the view's far edges (`breaks`), so no card straddles them nor lies
 *   under the strip: at rest each card is wholly in view or wholly out of it.
 * No DOM: the same sizes always give the same view.
 */

/** The map's room on screen: the svg's size, and the band laid over its top. */
export interface ViewRoom {
  width: number;
  height: number;
  inset: number;
}

/** A map's size (map px). */
export interface MapSize {
  width: number;
  height: number;
}

export interface FirstViewInput {
  orientation: Orientation;
  /** The map laid out with no break: its size, its year slots and its cards. */
  map: MapSize;
  slots: readonly YearSlot[];
  cards: readonly CardBox[];
  /** The analysed track's card (null: none). */
  anchor: CardBox | null;
  room: ViewRoom;
  /** Room kept before a year's cards when the view starts at it (across the page, px). */
  pad: number;
  /** The height of the strip the edge cues take at the bottom of the view (px). */
  cue: number;
  /**
   * Across the page, the band the year labels take at the top of the view once the view starts
   * below the map's top (they stay pinned there, over the cards: px).
   */
  band: number;
}

export interface FirstView {
  /** The pan (screen px, zoom 1). */
  x: number;
  y: number;
  /** Where the view's room for cards ends, in each direction; none where nothing runs past. */
  breaks: ViewBreaks | undefined;
}

/** The room below the band over the map's top (px), never less than 0. */
const roomBelow = (room: ViewRoom) => Math.max(0, room.height - room.inset);

/** The first view of a map (see the module's comment). */
export function planFirstView(input: FirstViewInput): FirstView {
  return input.orientation === 'horizontal' ? across(input) : down(input);
}

/** True when the card lies wholly between `from` and `to` along x (or y). */
const within = (from: number, to: number, start: number, size: number) =>
  start >= from - 0.5 && start + size <= to + 0.5;

/** Across the page: the years from left to right, the lanes from top to bottom. */
function across({ map, slots, cards, anchor, room, pad, cue, band }: FirstViewInput): FirstView {
  const below = roomBelow(room);
  let from = 0;
  let x = 0;
  if (map.width <= room.width) {
    x = (room.width - map.width) / 2;
  } else {
    // The earliest dated year from which the analysed card fits whole (any year when none is
    // dated); the first year's view starts at the map's own edge.
    const startOf = (slot: YearSlot) => (slot === slots[0] ? 0 : Math.max(0, slot.start - pad));
    const fits = (slot: YearSlot) =>
      anchor === null || within(startOf(slot), startOf(slot) + room.width, anchor.x, anchor.width);
    const dated = slots.filter((slot) => slot.year !== null);
    const own =
      anchor === null
        ? undefined
        : [...slots].reverse().find((slot) => slot.start <= anchor.x + anchor.width / 2);
    const start = (dated.length > 0 ? dated : slots).find(fits) ?? own ?? slots[0];
    from = start ? startOf(start) : 0;
    x = -from;
  }
  const to = from + room.width;
  const limit = Math.max(0, below - cue);
  // Across the lanes: from the map's top, unless the analysed card would then lie past the
  // room for cards. Then the view's top line (under the year labels, pinned over the top of the
  // view) goes where the room shows that card and the most other cards whole, nearest to the
  // card in the room's middle; never across a card above it in its year (a card across the
  // line starts at it, and would push the analysed one down).
  let top = 0;
  let crossFrom: number | undefined;
  if (anchor !== null && anchor.y + anchor.height > limit + 0.5) {
    const room = limit - band;
    const [low, high] = [anchor.y + anchor.height - room, anchor.y];
    const middle = Math.min(high, Math.max(low, anchor.y + anchor.height / 2 - room / 2));
    const column = cards.filter(
      (card) =>
        card !== anchor &&
        card.x < anchor.x + anchor.width &&
        card.x + card.width > anchor.x &&
        card.y < anchor.y,
    );
    /** The line moved off a card above the analysed one in its year, under it. */
    const clear = (line: number) =>
      column.reduce(
        (at, card) => (card.y < at && card.y + card.height > at ? card.y + card.height + 1 : at),
        line,
      );
    const shown = cards.filter((card) => within(from, to, card.x, card.width));
    const whole = (line: number) =>
      shown.filter((card) => within(line, line + room, card.y, card.height)).length;
    const lines = [
      middle,
      low,
      high,
      ...shown.flatMap((card) => [card.y, card.y + card.height - room]),
    ]
      .map((line) => Math.round(clear(Math.min(high, Math.max(low, line)))))
      .filter((line) => line >= low - 0.5 && line <= high + 0.5);
    crossFrom = lines.reduce((best, line) => {
      const [a, b] = [whole(line), whole(best)];
      return a > b || (a === b && Math.abs(line - middle) < Math.abs(best - middle)) ? line : best;
    }, lines[0] ?? Math.round(high));
    top = crossFrom - band;
  }
  // Cards past a side of the view: the cues' strip at its bottom is kept clear of cards.
  const past =
    top > 0 ||
    cards.some(
      (card) => !within(from, to, card.x, card.width) || card.y + card.height > top + below + 0.5,
    );
  const breaks: ViewBreaks = {};
  if (cards.some((card) => card.x + card.width > to + 0.5)) {
    Object.assign(breaks, { main: to, mainFrom: from });
  }
  if (past && cards.some((card) => card.y + card.height > top + limit + 0.5)) {
    Object.assign(breaks, { cross: top + limit, crossPast: top + below });
  }
  if (crossFrom !== undefined) Object.assign(breaks, { crossFrom });
  return { x, y: room.inset - top, breaks: noneIfEmpty(breaks) };
}

/** Down a column: the years from top to bottom. */
function down({ map, slots, cards, anchor, room, cue }: FirstViewInput): FirstView {
  const below = roomBelow(room);
  if (map.height <= below) {
    return { x: 0, y: room.inset + (below - map.height) / 2, breaks: undefined };
  }
  // The room for cards above the cues' strip.
  const limit = Math.max(0, below - cue);
  const fits = (top: number) =>
    anchor === null || within(top, top + limit, anchor.y, anchor.height);
  // Centred on the analysed card as far as the map allows, then up to the label of the year
  // the view's top falls in, where the card still fits; else up to the top of a row of cards
  // (no card across the view's top); else the first such line below that the card fits from.
  const centre = anchor ? anchor.y + anchor.height / 2 : 0;
  const wanted = Math.max(0, Math.min(centre - limit / 2, map.height - below));
  const clear = (line: number) =>
    !cards.some((card) => card.y < line - 0.5 && card.y + card.height > line + 0.5);
  const labels = [0, ...slots.map((slot) => slot.start)].filter(clear).sort((a, b) => a - b);
  const rows = [...labels, ...cards.map((card) => card.y - 4)].filter(clear).sort((a, b) => a - b);
  // The label of the year the view's top falls in.
  const label = [...labels].reverse().find((at) => at <= wanted + 0.5);
  const top =
    (label !== undefined && fits(label) ? label : undefined) ??
    [...rows].reverse().find((at) => at <= wanted + 0.5 && fits(at)) ??
    rows.find((at) => fits(at)) ??
    (anchor ? Math.max(0, anchor.y - 4) : 0);
  const breaks: ViewBreaks = {};
  if (cards.some((card) => card.y + card.height > top + limit + 0.5)) {
    Object.assign(breaks, { main: top + limit, mainPast: top + below, mainFrom: top });
  }
  return { x: 0, y: room.inset - top, breaks: noneIfEmpty(breaks) };
}

const noneIfEmpty = (breaks: ViewBreaks) =>
  breaks.main === undefined && breaks.cross === undefined && breaks.crossFrom === undefined
    ? undefined
    : breaks;

/** The breaks along the axis, and across it (each with what goes with it). */
const mainOf = ({ main, mainPast, mainFrom }: ViewBreaks): ViewBreaks | undefined =>
  main === undefined ? undefined : { main, mainPast, mainFrom };
const crossOf = ({ cross, crossPast }: ViewBreaks): ViewBreaks | undefined =>
  cross === undefined ? undefined : { cross, crossPast };
const crossFromOf = ({ crossFrom }: ViewBreaks): ViewBreaks | undefined =>
  crossFrom === undefined ? undefined : { crossFrom };

/** True when two sets of breaks are the same (both none, or the same lines). */
export const sameBreaks = (a: ViewBreaks | undefined, b: ViewBreaks | undefined) =>
  a?.main === b?.main &&
  a?.mainPast === b?.mainPast &&
  a?.mainFrom === b?.mainFrom &&
  a?.cross === b?.cross &&
  a?.crossPast === b?.crossPast &&
  a?.crossFrom === b?.crossFrom;

/**
 * The breaks that move a card (`moves` says whether one line alone does: the view's end along
 * the axis, its end across it, its start across it): one that moves none is left out. So two rooms whose breaks move no card have the same breaks (none),
 * and the map is laid out again only when a card moves.
 */
export function effectiveBreaks(
  breaks: ViewBreaks | undefined,
  moves: (only: ViewBreaks) => boolean,
): ViewBreaks | undefined {
  if (!breaks) return undefined;
  const kept = [mainOf(breaks), crossOf(breaks), crossFromOf(breaks)].filter(
    (only): only is ViewBreaks => only !== undefined && moves(only),
  );
  return noneIfEmpty(Object.assign({}, ...kept));
}

/** How many cards lie past each side of the view (map px): the edge cues' counts. */
export interface EdgeCounts {
  left: number;
  right: number;
  up: number;
  down: number;
}

/**
 * The cards past each side of `view` (map px), each counted once: past the right or the left
 * first, else past the bottom or the top. A card partly past a side counts for it.
 */
export function edgeCounts(
  cards: Iterable<CardBox>,
  view: { left: number; top: number; right: number; bottom: number },
): EdgeCounts {
  const counts: EdgeCounts = { left: 0, right: 0, up: 0, down: 0 };
  for (const card of cards) {
    if (card.x + card.width > view.right + 0.5) counts.right += 1;
    else if (card.x < view.left - 0.5) counts.left += 1;
    else if (card.y + card.height > view.bottom + 0.5) counts.down += 1;
    else if (card.y < view.top - 0.5) counts.up += 1;
  }
  return counts;
}

/** True when two sets of counts are the same. */
export const sameCounts = (a: EdgeCounts, b: EdgeCounts) =>
  a.left === b.left && a.right === b.right && a.up === b.up && a.down === b.down;
