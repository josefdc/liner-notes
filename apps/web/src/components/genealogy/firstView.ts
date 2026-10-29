import type { CardBox, Orientation, ViewBreaks, YearSlot } from './lineageLayout';

/**
 * The song-relations map's first view, at its size (zoom 1: its text at 12 px, never smaller):
 * - a map that fits the room is shown whole, centred along its axis;
 * - a larger one shows the analysed track's card whole, as the map is laid out for the view (its
 *   year or row can move at the view's edge: each view is judged on that layout). Across the
 *   page the view starts at a dated year (never at the "Undated" column, unless every card is
 *   undated): of those from which that card ends up wholly in view, the one that shows the most
 *   cards whole, then the one with that card nearest the view's middle, then the earliest. Down
 *   a phone's column it is centred on that card, as far as the map allows, starting at a year's
 *   label or at a row of cards;
 * - where cards lie past the view, the edge cues say so ("4 more →"): "↑" at the top-left, the
 *   others at the bottom. The layout is given the view's far edges (`breaks`), so no card
 *   straddles them, and room is kept for a cue only where its button would lie over a card: at
 *   rest each card is wholly in view or wholly out of it, and none lies under a cue.
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

/** The map as laid out for a view: its cards, and the analysed track's among them. */
export interface LaidOut {
  cards: readonly CardBox[];
  anchor: CardBox | null;
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
  /** The height of an edge cue's button, and of the strip kept for the cues (px). */
  cue: number;
  /**
   * Across the page, the band the year labels take at the top of the view once the view starts
   * below the map's top (they stay pinned there, over the cards: px).
   */
  band: number;
  /**
   * The map laid out with a view's breaks (none: the cards as given, which no break moves). The
   * first view is judged on it.
   */
  layout?: (breaks: ViewBreaks | undefined) => LaidOut;
  /**
   * An edge cue's button width (px) for the cards past its side. Given, a strip is kept for the
   * cues only where a button would lie over a card ("↑" at the top-left down a column, the
   * others at the bottom); not given, a strip at the bottom of the view whenever cards lie past.
   */
  cueWidth?: (side: keyof EdgeCounts, count: number) => number;
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

/** What an edge cue shows: how many cards lie past its edge, and which way. */
export const CUE_TEXT: Record<keyof EdgeCounts, (count: number) => string> = {
  left: (count) => `← ${count} more`,
  right: (count) => `${count} more →`,
  up: (count) => `↑ ${count} more`,
  down: (count) => `${count} more ↓`,
};
/** An edge cue's name: the cards past its edge, where they are, and what it does. */
export function cueName(side: keyof EdgeCounts, count: number, orientation: Orientation): string {
  const tracks = `${count} more ${count === 1 ? 'track' : 'tracks'}`;
  const them = count === 1 ? 'it' : 'them';
  const along = orientation === 'horizontal' ? ['left', 'right'] : ['up', 'down'];
  const where = along.includes(side)
    ? side === along[0]
      ? 'in earlier years'
      : 'in later years'
    : { left: 'to the left', right: 'to the right', up: 'above', down: 'below' }[side];
  const pan = { left: 'left', right: 'right', up: 'up', down: 'down' }[side];
  return `${tracks} ${where}: pan ${pan} to ${them}`;
}
/**
 * An edge cue's width (px), at most: its words at 12 px in IBM Plex Mono, whose every glyph
 * (the arrows too) is 0.6 em wide, or less; its padding (6 px a side) and border (1 px a side).
 * A card is kept from under a cue only where one sits, so the bound is kept tight: a margin
 * here would cost a whole card at a phone's width.
 */
export const cueWidth = (side: keyof EdgeCounts, count: number) =>
  CUE_TEXT[side](count).length * 12 * 0.6 + 6 * 2 + 2;

/** How far an edge cue's button sits from the view's side, and from the button beside it (px). */
export const CUE_EDGE = 8;
export const CUE_GAP = 8;

/**
 * Where the edge cues' buttons at the bottom of a view sit, from its left (px): "← N more" at
 * the left; "N more ↓" then "N more →" at the right.
 */
export function bottomCues(
  counts: EdgeCounts,
  width: number,
  cueWidth: (side: keyof EdgeCounts, count: number) => number,
): Array<{ left: number; right: number }> {
  const boxes: Array<{ left: number; right: number }> = [];
  if (counts.left > 0) {
    boxes.push({ left: CUE_EDGE, right: CUE_EDGE + cueWidth('left', counts.left) });
  }
  let right = width - CUE_EDGE;
  for (const side of ['right', 'down'] as const) {
    if (counts[side] === 0) continue;
    const size = cueWidth(side, counts[side]);
    boxes.push({ left: right - size, right });
    right -= size + CUE_GAP;
  }
  return boxes;
}

/** The first view of a map (see the module's comment). */
export function planFirstView(input: FirstViewInput): FirstView {
  return input.orientation === 'horizontal' ? across(input) : down(input);
}

/** True when the card lies wholly between `from` and `to` along x (or y). */
const within = (from: number, to: number, start: number, size: number) =>
  start >= from - 0.5 && start + size <= to + 0.5;

/** A view's room for cards (map px), and where the view itself ends at its bottom. */
interface Area {
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** The view's bottom edge (the cues' buttons sit on it). */
  end: number;
}

/** A view judged on the map laid out for it. */
interface Judged {
  view: FirstView;
  /** The cards wholly in the room for cards. */
  whole: number;
  /** True when the analysed card is (or there is none). */
  anchorIn: boolean;
}

const inside = (area: Area, card: CardBox) =>
  within(area.left, area.right, card.x, card.width) &&
  within(area.top, area.bottom, card.y, card.height);
const meet = (a: CardBox, b: CardBox) =>
  a.x < b.x + b.width - 0.5 &&
  b.x < a.x + a.width - 0.5 &&
  a.y < b.y + b.height - 0.5 &&
  b.y < a.y + a.height - 0.5;

/**
 * A view laid out and judged; with `clear` (no strip kept for the cues), null when a bottom
 * cue's button would lie over a card of it.
 */
function judge(input: FirstViewInput, view: FirstView, area: Area, clear: boolean): Judged | null {
  const laid = input.layout ? input.layout(view.breaks) : input;
  if (clear && input.cueWidth) {
    const counts = edgeCounts(laid.cards, { ...area, bottom: area.end });
    const buttons = bottomCues(counts, area.right - area.left, input.cueWidth).map(
      ({ left, right }): CardBox => ({
        x: area.left + left,
        y: area.end - input.cue,
        width: right - left,
        height: input.cue,
      }),
    );
    if (laid.cards.some((card) => buttons.some((button) => meet(card, button)))) return null;
  }
  return {
    view,
    whole: laid.cards.filter((card) => inside(area, card)).length,
    anchorIn: laid.anchor === null || inside(area, laid.anchor),
  };
}

/**
 * The view with the smallest strip kept for the cues at its bottom where no cue's button lies
 * over a card (none, else the cue's height), judged.
 */
function smallest(
  input: FirstViewInput,
  viewFor: (strip: number) => { view: FirstView; area: Area },
) {
  if (input.cueWidth) {
    const bare = viewFor(0);
    const judged = judge(input, bare.view, bare.area, true);
    if (judged) return judged;
  }
  const kept = viewFor(input.cue);
  return judge(input, kept.view, kept.area, false) as Judged;
}

/** Across the page: the years from left to right, the lanes from top to bottom. */
function across(input: FirstViewInput): FirstView {
  const { map, slots, anchor, room, pad } = input;
  /** The view from `from` (map px, the pan along the axis `x`), judged. */
  const judged = (from: number, x: number) =>
    smallest(input, (strip) => acrossFrom(input, from, x, strip));
  if (map.width <= room.width) return judged(0, (room.width - map.width) / 2).view;
  // The dated years from which the analysed card's own box is wholly in view (any year when
  // none is dated); the first year's view starts at the map's own edge.
  const startOf = (slot: YearSlot) => (slot === slots[0] ? 0 : Math.max(0, slot.start - pad));
  const fits = (from: number) =>
    anchor === null || within(from, from + room.width, anchor.x, anchor.width);
  const dated = slots.filter((slot) => slot.year !== null);
  const starts = [...new Set((dated.length > 0 ? dated : slots).map(startOf))].filter(fits);
  // Of those, the ones where the card is wholly in view as the map is laid out for them (its
  // year moves past the view's edge when the year runs over it).
  const views = starts
    .map((from) => ({ from, ...judged(from, -from) }))
    .filter((view) => view.anchorIn);
  if (views.length === 0) {
    // None: from the analysed card's own year (else the first).
    const own =
      anchor === null
        ? undefined
        : [...slots].reverse().find((slot) => slot.start <= anchor.x + anchor.width / 2);
    const start = own ?? slots[0];
    const from = start ? startOf(start) : 0;
    return judged(from, -from).view;
  }
  // The one that shows the most cards whole; then the one with the analysed card nearest the
  // view's middle; then the earliest (the starts are in order: a tie keeps the one before).
  const off = (from: number) =>
    anchor === null ? 0 : Math.abs(anchor.x + anchor.width / 2 - (from + room.width / 2));
  return views.reduce((a, b) =>
    b.whole > a.whole || (b.whole === a.whole && off(b.from) < off(a.from) - 0.5) ? b : a,
  ).view;
}

/**
 * Across the page, the view whose room for cards starts at `from` (map px; the pan along the
 * axis `x`), with a strip of `strip` px kept at its bottom for the cues where cards lie past.
 */
function acrossFrom(
  { cards, anchor, room, band }: FirstViewInput,
  from: number,
  x: number,
  strip: number,
): { view: FirstView; area: Area } {
  const below = roomBelow(room);
  // The view's left edge (map px): `from`, or left of it where the map, centred, fits.
  const left = Math.min(from, -x);
  const to = left + room.width;
  const limit = Math.max(0, below - strip);
  const shown = cards.filter((card) => within(left, to, card.x, card.width));
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
    const wholeFrom = (line: number) =>
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
      const [a, b] = [wholeFrom(line), wholeFrom(best)];
      return a > b || (a === b && Math.abs(line - middle) < Math.abs(best - middle)) ? line : best;
    }, lines[0] ?? Math.round(high));
    top = crossFrom - band;
  }
  // Cards past a side of the view: the strip at its bottom is kept clear of cards.
  const past =
    top > 0 ||
    cards.some(
      (card) => !within(left, to, card.x, card.width) || card.y + card.height > top + below + 0.5,
    );
  const reach = past ? limit : below;
  const breaks: ViewBreaks = {};
  if (cards.some((card) => card.x + card.width > to + 0.5)) {
    Object.assign(breaks, { main: to, mainFrom: from });
  }
  if (past && cards.some((card) => card.y + card.height > top + limit + 0.5)) {
    Object.assign(breaks, { cross: top + limit, crossPast: top + below });
  }
  if (crossFrom !== undefined) Object.assign(breaks, { crossFrom });
  return {
    view: { x, y: room.inset - top, breaks: noneIfEmpty(breaks) },
    area: {
      left,
      right: to,
      top: crossFrom ?? top,
      bottom: top + reach,
      end: top + below,
    },
  };
}

/** Down a column: the years from top to bottom. */
function down(input: FirstViewInput): FirstView {
  const { map, slots, cards, anchor, room, cue } = input;
  const below = roomBelow(room);
  if (map.height <= below) {
    return { x: 0, y: room.inset + (below - map.height) / 2, breaks: undefined };
  }
  /**
   * The view from `top` (map px), judged: "↑ N more" at its top-left (cards above it) takes a
   * strip of its own there, before the view's room; the smallest strip at the bottom.
   */
  const judged = (top: number) => {
    const raised = input.cueWidth !== undefined && cards.some((card) => card.y < top - 0.5);
    const head = raised ? cue : 0;
    return smallest(input, (strip) => {
      const limit = Math.max(0, below - head - strip);
      const breaks: ViewBreaks = {};
      if (cards.some((card) => card.y + card.height > top + limit + 0.5)) {
        Object.assign(breaks, { main: top + limit, mainPast: top + below - head, mainFrom: top });
      }
      return {
        view: { x: 0, y: room.inset + head - top, breaks: noneIfEmpty(breaks) },
        area: { left: 0, right: room.width, top, bottom: top + limit, end: top + below - head },
      };
    });
  };
  // The room for cards, at most (a strip for the cues at the bottom).
  const limit = Math.max(0, below - cue);
  const fits = (top: number) =>
    anchor === null ||
    within(top, top + below - (input.cueWidth ? 0 : cue), anchor.y, anchor.height);
  // Centred on the analysed card as far as the map allows, then up to the label of the year
  // the view's top falls in, where the card still fits; else up to the top of a row of cards
  // (no card across the view's top); else the first such line below that the card fits from.
  // Each judged on the map laid out for it: the first where the card is wholly in view.
  const centre = anchor ? anchor.y + anchor.height / 2 : 0;
  const wanted = Math.max(0, Math.min(centre - limit / 2, map.height - below));
  const clear = (line: number) =>
    !cards.some((card) => card.y < line - 0.5 && card.y + card.height > line + 0.5);
  const labels = [0, ...slots.map((slot) => slot.start)].filter(clear).sort((a, b) => a - b);
  const rows = [...labels, ...cards.map((card) => card.y - 4)].filter(clear).sort((a, b) => a - b);
  // The label of the year the view's top falls in.
  const label = [...labels].reverse().find((at) => at <= wanted + 0.5);
  const tops = [
    ...(label !== undefined ? [label] : []),
    ...[...rows].reverse().filter((at) => at <= wanted + 0.5),
    ...rows.filter((at) => at > wanted + 0.5),
  ].filter(fits);
  for (const top of new Set(tops)) {
    const view = judged(top);
    if (view.anchorIn) return view.view;
  }
  // None: the analysed card at the view's bottom, or at its top where the room is taller.
  return judged(anchor ? Math.max(0, Math.max(anchor.y - 4, anchor.y + anchor.height - limit)) : 0)
    .view;
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
 * The breaks that change the layout: one (with what goes with it) is left out when the map laid
 * out without it is the same as with all of them (`layoutOf` gives a layout's places, as a key).
 * So two rooms whose breaks move no card have the same breaks (none), the map is laid out again
 * only when a card moves, and a break that only matters with another (a card moved down by the
 * view's top line, onto its bottom one) is kept.
 */
export function effectiveBreaks(
  breaks: ViewBreaks | undefined,
  layoutOf: (breaks: ViewBreaks | undefined) => string,
): ViewBreaks | undefined {
  if (!breaks) return undefined;
  const full = layoutOf(breaks);
  let kept = [mainOf(breaks), crossOf(breaks), crossFromOf(breaks)].filter(
    (only): only is ViewBreaks => only !== undefined,
  );
  const merged = (groups: ViewBreaks[]) => noneIfEmpty(Object.assign({}, ...groups));
  for (const group of [...kept]) {
    const without = kept.filter((other) => other !== group);
    if (layoutOf(merged(without)) === full) kept = without;
  }
  return merged(kept);
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
