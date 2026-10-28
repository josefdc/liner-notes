import type { LinkType } from '@liner-notes/contract';
import { type Box, placeLabels } from './labels';

/**
 * The song-relations map as a lineage: where each track's card goes, worked out from its release
 * year and its relation to the analysed track. No DOM and no randomness: the same tracks always
 * give the same map.
 *
 * - The year axis runs left to right (horizontal) or top to bottom (vertical, on a phone or in a
 *   narrow panel). Each year a track carries has a slot on it, in year order; the gap between
 *   two slots grows with the years between them. A track with no year goes in an "Undated" slot
 *   at the end of the axis, never at a year it does not carry.
 * - Across the axis the cards sit in lanes by relation (samples, interpolations, covers, this
 *   track, remixes, shared producers, influences, then tracks with no link to this one).
 * - A collision pass moves a card across the axis only, so it never leaves its year's slot.
 */

/** The lanes across the axis, in their order. */
export const LANES = [
  'sample',
  'interpolation',
  'cover',
  'current',
  'remix',
  'producer',
  'influence',
  'second-hop',
] as const;
export type Lane = (typeof LANES)[number];

/**
 * A card's lane: the analysed track's own, else the relation its link to the analysed track is
 * drawn as (`type`, so a sample that is not sourced sits with the influences, in their grey),
 * else the lane of tracks with no link to it (a second hop).
 */
export function laneOf(isCurrent: boolean, linkType: LinkType | null): Lane {
  if (isCurrent) return 'current';
  return linkType ?? 'second-hop';
}

export type Orientation = 'horizontal' | 'vertical';

/** Tailwind's md breakpoint: below it the axis is vertical. */
export const MD_PX = 768;
/** A panel narrower than this has no room for years side by side: its axis is vertical too. */
export const NARROW_PANEL_PX = 600;

/** The axis's direction: vertical below md, or in a panel too narrow for years side by side. */
export function orientationFor(viewportWidth: number, panelWidth: number): Orientation {
  return viewportWidth < MD_PX || panelWidth < NARROW_PANEL_PX ? 'vertical' : 'horizontal';
}

/** With this many relations or fewer the map is a compact row, not a canvas. */
export const SPARSE_RELATIONS = 2;
export const isSparse = (relations: number) => relations <= SPARSE_RELATIONS;

/**
 * `text` in lines of at most `maxChars` characters, broken at spaces (a word longer than a line
 * is broken inside), at most `maxLines` of them. Text that needs more lines is cut, its last line
 * ending in "…", and said to be `truncated`.
 */
export function wrapText(
  text: string,
  maxChars: number,
  maxLines = 2,
): { lines: string[]; truncated: boolean } {
  const width = Math.max(1, Math.floor(maxChars));
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    let rest = word;
    while (rest.length > 0) {
      const room = line ? width - line.length - 1 : width;
      if (rest.length <= room) {
        line = line ? `${line} ${rest}` : rest;
        rest = '';
      } else if (line) {
        lines.push(line);
        line = '';
      } else {
        lines.push(rest.slice(0, width));
        rest = rest.slice(width);
      }
    }
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return { lines, truncated: false };
  const kept = lines.slice(0, maxLines);
  const last = kept[maxLines - 1];
  kept[maxLines - 1] = `${last.slice(0, Math.max(0, width - 1))}…`;
  return { lines: kept, truncated: true };
}

/**
 * The fewest characters a line needs for `text` to wrap into `maxLines` lines uncut, never
 * fewer than its longest word (a word is not broken to save width).
 */
export function charsToWrap(text: string, maxLines = 2): number {
  const length = text.trim().length;
  const longest = Math.max(
    0,
    ...text
      .trim()
      .split(/\s+/)
      .map((word) => word.length),
  );
  for (let chars = Math.max(longest, Math.ceil(length / maxLines)); chars < length; chars += 1) {
    if (!wrapText(text, chars, maxLines).truncated) return chars;
  }
  return length;
}

/** A track's card to place: its year (null when it carries none), lane and size. */
export interface CardInput {
  id: string;
  year: number | null;
  lane: Lane;
  width: number;
  height: number;
}

/** A card placed: its top-left corner and size. */
export interface CardBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A year's slot along the axis: where it starts and how long it is (null year: "Undated"). */
export interface YearSlot {
  year: number | null;
  label: string;
  start: number;
  size: number;
}

export interface Margin {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface LayoutOptions {
  orientation: Orientation;
  /** Space between two cards, and between a slot's rows. */
  gap?: number;
  /** The least space between two year slots; more for years far apart. */
  slotGap?: number;
  /**
   * Room across the axis for a slot's cards (vertical only): cards past it wrap into another row
   * inside their year's slot.
   */
  crossSpace?: number;
  /** The year labels' room: a band above the cards (horizontal), a heading over each slot (vertical). */
  axisSize?: number;
  margin?: Partial<Margin>;
}

export interface LineageLayout {
  orientation: Orientation;
  cards: ReadonlyMap<string, CardBox>;
  slots: YearSlot[];
  margin: Margin;
  axisSize: number;
  width: number;
  height: number;
}

/** The space between two year slots: more for years far apart, most before "Undated". */
function slotSpacing(before: number | null, after: number | null, slotGap: number): number {
  if (after === null || before === null) return slotGap * 2;
  const years = Math.max(1, after - before);
  return slotGap + Math.min(slotGap, Math.round(6 * Math.log2(years)));
}

/** Lays the cards out on the year axis (see the module's comment). */
export function layoutLineage(cards: readonly CardInput[], options: LayoutOptions): LineageLayout {
  const { orientation, gap = 8, slotGap = 24, axisSize = 20 } = options;
  const margin: Margin = { top: 0, right: 0, bottom: 0, left: 0, ...options.margin };
  const horizontal = orientation === 'horizontal';
  const crossSpace = horizontal ? Number.POSITIVE_INFINITY : (options.crossSpace ?? Infinity);
  const mainOf = (card: CardInput) => (horizontal ? card.width : card.height);
  const crossOf = (card: CardInput) => (horizontal ? card.height : card.width);

  // Lanes in their order, the empty ones left out; each one card's breadth apart.
  const lanes = LANES.filter((lane) => cards.some((card) => card.lane === lane));
  const pitch = Math.max(0, ...cards.map(crossOf)) + gap;
  const desiredCross = (card: CardInput) => lanes.indexOf(card.lane) * pitch;

  // Year slots in order, then the undated one.
  const years = [...new Set(cards.flatMap((card) => (card.year === null ? [] : [card.year])))].sort(
    (a, b) => a - b,
  );
  const keys: Array<number | null> = cards.some((card) => card.year === null)
    ? [...years, null]
    : years;

  // Each slot's cards across the axis: in lane order, then the order they were given; the
  // collision pass moves a card further across past the one before it, and (vertical) wraps it
  // into a new row of its slot when it would run past `crossSpace`.
  type Row = { cards: Array<{ card: CardInput; cross: number }>; main: number };
  const slotRows = keys.map((year) => {
    const members = cards
      .map((card, order) => ({ card, order }))
      .filter(({ card }) => card.year === year)
      .sort((a, b) => lanes.indexOf(a.card.lane) - lanes.indexOf(b.card.lane) || a.order - b.order)
      .map(({ card }) => card);
    const rows: Row[] = [];
    let row: Row = { cards: [], main: 0 };
    for (const card of members) {
      const size = crossOf(card);
      const fit = (cross: number) => Math.max(0, Math.min(cross, crossSpace - size));
      const previous = row.cards.at(-1);
      let cross = previous
        ? Math.max(desiredCross(card), previous.cross + crossOf(previous.card) + gap)
        : fit(desiredCross(card));
      if (previous && cross + size > crossSpace) {
        rows.push(row);
        row = { cards: [], main: 0 };
        cross = fit(desiredCross(card));
      }
      row.cards.push({ card, cross });
      row.main = Math.max(row.main, mainOf(card));
    }
    if (row.cards.length > 0) rows.push(row);
    return rows;
  });

  // Along the axis: each slot after the one before it, the cards after the slot's heading.
  const mainStart = horizontal ? margin.left : margin.top;
  const crossStart = horizontal ? margin.top + axisSize : margin.left;
  const heading = horizontal ? 0 : axisSize;
  const slots: YearSlot[] = [];
  const placed = new Map<string, CardBox>();
  let at = mainStart;
  let crossEnd = 0;
  keys.forEach((year, index) => {
    if (index > 0) at += slotSpacing(keys[index - 1], year, slotGap);
    const rows = slotRows[index];
    const size = heading + rows.reduce((sum, row) => sum + row.main, 0) + gap * (rows.length - 1);
    slots.push({ year, label: year === null ? 'Undated' : String(year), start: at, size });
    let rowAt = at + heading;
    for (const row of rows) {
      for (const { card, cross } of row.cards) {
        const main = rowAt + (row.main - mainOf(card)) / 2;
        placed.set(
          card.id,
          horizontal
            ? { x: main, y: crossStart + cross, width: card.width, height: card.height }
            : { x: crossStart + cross, y: main, width: card.width, height: card.height },
        );
        crossEnd = Math.max(crossEnd, cross + crossOf(card));
      }
      rowAt += row.main + gap;
    }
    at += size;
  });

  const mainEnd = at + (horizontal ? margin.right : margin.bottom);
  const crossTotal = crossStart + crossEnd + (horizontal ? margin.bottom : margin.right);
  return {
    orientation,
    cards: placed,
    slots,
    margin,
    axisSize,
    width: horizontal ? mainEnd : crossTotal,
    height: horizontal ? crossTotal : mainEnd,
  };
}

/** Whether two boxes (top-left corners) overlap, or come within `gap` of each other. */
export function boxesMeet(a: CardBox, b: CardBox, gap = 0): boolean {
  return (
    a.x < b.x + b.width + gap &&
    b.x < a.x + a.width + gap &&
    a.y < b.y + b.height + gap &&
    b.y < a.y + a.height + gap
  );
}

/** A chip to place near a point (an edge's middle, a card): its size and how much it matters. */
export interface ChipInput {
  /** Where it would best go (its centre), the nearest free place after. */
  near: { x: number; y: number };
  width: number;
  height: number;
  priority: number;
}

/**
 * Where each chip goes (its top-left corner), or null for one with no free place: never over a
 * card, an obstacle or another chip, inside `bounds`. Candidates are a grid over `bounds`, the
 * nearest to the chip's point first. Deterministic.
 */
export function placeChips(
  chips: readonly ChipInput[],
  cards: readonly CardBox[],
  bounds: CardBox,
  step = 6,
  gap = 3,
): Array<CardBox | null> {
  const choices = chips.map((chip) => {
    const free: Array<Box & { distance: number }> = [];
    for (let y = bounds.y; y + chip.height <= bounds.y + bounds.height; y += step) {
      for (let x = bounds.x; x + chip.width <= bounds.x + bounds.width; x += step) {
        const box = { x, y, width: chip.width, height: chip.height };
        if (cards.some((card) => boxesMeet(box, card, gap))) continue;
        const [cx, cy] = [x + chip.width / 2, y + chip.height / 2];
        free.push({
          // placeLabels reads a box by its centre
          x: cx,
          y: cy,
          width: chip.width,
          height: chip.height,
          distance: Math.hypot(cx - chip.near.x, cy - chip.near.y),
        });
      }
    }
    free.sort((a, b) => a.distance - b.distance || a.y - b.y || a.x - b.x);
    return { candidates: free, priority: chip.priority, kind: 'chip' };
  });
  const { at } = placeLabels(choices, [], gap);
  return at.map((index, i) => {
    if (index === -1) return null;
    const box = choices[i].candidates[index];
    return {
      x: box.x - box.width / 2,
      y: box.y - box.height / 2,
      width: box.width,
      height: box.height,
    };
  });
}
