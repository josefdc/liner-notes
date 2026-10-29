import type { LinkType } from '@liner-notes/contract';

/**
 * The song-relations map as a lineage: where each track's card goes, worked out from its release
 * year and its relation to the analysed track. No DOM and no randomness: the same tracks always
 * give the same map.
 *
 * - The year axis runs left to right (horizontal) or top to bottom (vertical, on a phone or in a
 *   narrow panel). Each year a record gives a track has a slot on it, in year order; the gap
 *   between two slots grows with the years between them (in order, not to scale). A track with
 *   no year goes in an "Undated" slot, never at a year it does not carry: before the first year
 *   when it feeds the analysed track, so a source never sits after what it feeds, else after
 *   the last.
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

/** A panel narrower than this has no room for years side by side: its axis is vertical too. */
export const NARROW_PANEL_PX = 600;

/**
 * The axis's direction: vertical below md (`mdUp` false: the page's own breakpoint, 48rem), or
 * in a panel too narrow for years side by side.
 */
export function orientationFor(mdUp: boolean, panelWidth: number): Orientation {
  return !mdUp || panelWidth < NARROW_PANEL_PX ? 'vertical' : 'horizontal';
}

/**
 * With this many links or fewer in all the map is a compact row, not a canvas: a map is small
 * only when the whole of it is (a track with one relation and several second hops is drawn).
 */
export const SPARSE_LINKS = 2;
export const isSparse = (links: number) => links <= SPARSE_LINKS;

/**
 * The text's graphemes: what a reader sees as one character (an emoji with its modifiers, a
 * flag, a letter with its accents), never split. Where the browser has no `Intl.Segmenter`, its
 * code points (a surrogate pair still kept whole).
 */
const segmenter =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;
export const graphemes = (text: string): string[] =>
  segmenter ? Array.from(segmenter.segment(text), (part) => part.segment) : Array.from(text);

/**
 * Code points drawn about two monospace cells wide: East Asian Wide and Fullwidth characters
 * (Hangul, CJK, kana, fullwidth forms) and emoji, a flag (two regional indicators) and a keycap
 * among them.
 */
const WIDE =
  /^(?:[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]|[\u{1b000}-\u{1b2ff}\u{1f1e6}-\u{1f1ff}\u{1f200}-\u{1f2ff}\u{20000}-\u{3fffd}]|\p{Extended_Pictographic})/u;
/** An emoji's presentation (U+FE0F) or a keycap (U+20E3) anywhere in a grapheme. */
const EMOJI_PART = /[\ufe0f\u20e3]/u;

/** How many monospace cells a grapheme takes on a card: two for a wide one, else one. */
export const graphemeUnits = (grapheme: string): number =>
  WIDE.test(grapheme) || EMOJI_PART.test(grapheme) ? 2 : 1;

/** How many monospace cells a text takes on a card (see `graphemeUnits`). */
export const textUnits = (text: string): number =>
  graphemes(text).reduce((sum, grapheme) => sum + graphemeUnits(grapheme), 0);

/** Marks that never start a line in Japanese (kinsoku): closing brackets, stops, the long vowel. */
const NO_LINE_START = new Set([...'、。，．：；！？」』）］】〕〉》・ー〜…‥']);
/** Marks that never end a line in Japanese: opening brackets. */
const NO_LINE_END = new Set([...'「『（［【〔〈《']);
/**
 * True when a line may break between two graphemes of a word with no hyphen: next to a wide
 * character (CJK has no spaces between its words), unless the break would start a line with a
 * closing mark or end one with an opening mark.
 */
const softBreak = (before: string, after: string) =>
  (graphemeUnits(before) === 2 || graphemeUnits(after) === 2) &&
  !NO_LINE_START.has(after) &&
  !NO_LINE_END.has(before);
/** True when a line may break there with no hyphen, the marks' rule aside. */
const wideBreak = (before: string, after: string) =>
  graphemeUnits(before) === 2 || graphemeUnits(after) === 2;

/** How `wrapText` wraps a text. */
export interface WrapOptions {
  /**
   * True when the text's last lone "·" is the card's own separator (between an artist and a
   * year): it is left out where a line breaks at it. Any other "·" is the record's, kept.
   */
  separator?: boolean;
}

/**
 * A text's words, broken at spaces; a lone "·" is kept with the word after it, so no line ends
 * in one. `separatorAt`: the word the card's separator starts (with `separator`), else -1.
 */
function wordsOf(text: string, separator = false): { words: string[]; separatorAt: number } {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const joined: string[] = [];
  let separatorAt = -1;
  for (let i = 0; i < words.length; i += 1) {
    if (words[i] === '·' && i + 1 < words.length) {
      if (separator) separatorAt = joined.length;
      joined.push(`· ${words[i + 1]}`);
      i += 1;
    } else joined.push(words[i]);
  }
  return { words: joined, separatorAt };
}

/**
 * `text` in lines of at most `maxChars` monospace cells (a wide character takes two, see
 * `graphemeUnits`), broken at spaces and, in CJK text, between characters (with no hyphen, and
 * not before a closing mark nor after an opening one). No line ends in a lone "·"; the card's
 * own separator (`options.separator`) starts none either: where the line breaks at it, it is
 * left out. A word longer than a line is broken inside, between two graphemes, its piece ending
 * in a hyphen (`hyphenated` says which lines end so). At most `maxLines` lines: text that needs more is cut, its last line ending in "…", and
 * said to be `truncated`.
 */
export function wrapText(
  text: string,
  maxChars: number,
  maxLines = 2,
  options: WrapOptions = {},
): { lines: string[]; hyphenated: boolean[]; truncated: boolean } {
  const width = Math.max(2, Math.floor(maxChars));
  const { words, separatorAt } = wordsOf(text, options.separator);
  const lines: string[] = [];
  const hyphenated: boolean[] = [];
  let line = '';
  let lineUnits = 0;
  const unitsOf = (parts: string[]) => parts.reduce((sum, part) => sum + graphemeUnits(part), 0);
  /** The graphemes of `parts` that fit `room` cells (at least one), and the rest. */
  const fitting = (parts: string[], room: number) => {
    let units = 0;
    let count = 0;
    while (count < parts.length && units + graphemeUnits(parts[count]) <= room) {
      units += graphemeUnits(parts[count]);
      count += 1;
    }
    return Math.max(1, count);
  };
  /** The most graphemes of `parts` that fit `room` cells and end where `may` lets a line break. */
  const breakingAt = (parts: string[], room: number, may: typeof softBreak) => {
    let best = 0;
    let units = 0;
    for (let i = 1; i < parts.length; i += 1) {
      units += graphemeUnits(parts[i - 1]);
      if (units > room) break;
      if (may(parts[i - 1], parts[i])) best = i;
    }
    return best;
  };
  const push = (text: string, hyphen: boolean) => {
    lines.push(text);
    hyphenated.push(hyphen);
    line = '';
    lineUnits = 0;
  };
  for (const [index, word] of words.entries()) {
    const whole = graphemes(word);
    let rest = whole;
    while (rest.length > 0) {
      // The card's separator never starts a line: the word after it starts it alone.
      if (rest === whole && index === separatorAt && !line && lines.length > 0) {
        rest = rest.slice(2);
      }
      const room = line ? width - lineUnits - 1 : width;
      const units = unitsOf(rest);
      if (units <= room) {
        line = line ? `${line} ${rest.join('')}` : rest.join('');
        lineUnits += (lineUnits > 0 ? 1 : 0) + units;
        rest = [];
        continue;
      }
      // CJK: as much as fits on this line, broken between characters.
      const soft = breakingAt(rest, room, softBreak);
      if (soft > 0) {
        const piece = rest.slice(0, soft).join('');
        push(line ? `${line} ${piece}` : piece, false);
        rest = rest.slice(soft);
      } else if (line) {
        push(line, false);
      } else {
        // A line of its own that no break fits: next to a wide character with no hyphen (the
        // marks' rule given up), else with one.
        const wide = breakingAt(rest, width, wideBreak);
        const count = wide > 0 ? wide : fitting(rest, width - 1);
        push(`${rest.slice(0, count).join('')}${wide > 0 ? '' : '-'}`, wide === 0);
        rest = rest.slice(count);
      }
    }
  }
  if (line) push(line, false);
  if (lines.length <= maxLines) return { lines, hyphenated, truncated: false };
  const kept = lines.slice(0, maxLines);
  const last = graphemes(
    hyphenated[maxLines - 1] ? kept[maxLines - 1].slice(0, -1) : kept[maxLines - 1],
  );
  kept[maxLines - 1] =
    `${last.slice(0, Math.min(last.length, fitting(last, width - 1))).join('')}…`;
  return {
    lines: kept,
    hyphenated: hyphenated.slice(0, maxLines - 1).concat(false),
    truncated: true,
  };
}

/** A word's pieces a line never breaks inside: between them a CJK line may break. */
function unbroken(word: string): string[] {
  const parts = graphemes(word);
  const pieces: string[] = [];
  let piece = '';
  parts.forEach((part, i) => {
    if (i > 0 && softBreak(parts[i - 1], part)) {
      pieces.push(piece);
      piece = '';
    }
    piece += part;
  });
  if (piece) pieces.push(piece);
  return pieces;
}

/**
 * The fewest monospace cells a line needs for `text` to wrap into `maxLines` lines uncut, never
 * fewer than its longest word (a word is not broken to save width; CJK text breaks between its
 * characters).
 */
export function charsToWrap(text: string, maxLines = 2, options: WrapOptions = {}): number {
  const length = textUnits(text.trim());
  const longest = Math.max(
    0,
    ...wordsOf(text).words.flatMap((word) => unbroken(word).map((piece) => textUnits(piece))),
  );
  for (let chars = Math.max(longest, Math.ceil(length / maxLines)); chars < length; chars += 1) {
    if (!wrapText(text, chars, maxLines, options).truncated) return chars;
  }
  return length;
}

/** A track's card to place: its year (null when it carries none), lane and size. */
export interface CardInput {
  id: string;
  year: number | null;
  /**
   * For a card with no year: true when it feeds the analysed track (a link from it into the
   * track or into one of the track's sources), so it goes in the "Undated" slot before the
   * first year; otherwise in the one after the last.
   */
  early?: boolean;
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
  /** For an "Undated" slot: before the first year (the undated sources) or after the last. */
  side: 'before' | 'after' | null;
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
  /**
   * Where the first view's room for cards ends (map px), along the axis (`main`) and across it
   * (`cross`): no card straddles such a line. A year's slot (down a column, a row of its cards)
   * that would run over it starts just past the view's end instead (`mainPast`, `crossPast`:
   * the line itself when not given), and so does a card across the row's lanes, so the first
   * view shows each card whole or not at all. The first slot in the view (from `mainFrom`), its
   * first row and the first lane are never moved: one too big for the view stays where it is.
   */
  breakAt?: ViewBreaks;
}

/** Where a first view ends, along and across the axis (map px); none where the map fits. */
export interface ViewBreaks {
  main?: number;
  /** Where the view ends along the axis, past `main` (a strip under the room for cards). */
  mainPast?: number;
  /** Where the view starts along the axis (the map's start when not given). */
  mainFrom?: number;
  cross?: number;
  /** Where the view ends across the axis, past `cross`. */
  crossPast?: number;
  /**
   * Where the room for cards starts across the axis (horizontal), when the view starts below the
   * map's top: a card over the line starts at it instead, wholly in the view.
   */
  crossFrom?: number;
}

/** How far past a break a moved card starts (px): a hair, so it is wholly out of the view. */
export const BREAK_CLEAR = 2;
/**
 * Room kept before a year's cards where a view starts at that year (map px): the year that
 * starts this near the view's start (`mainFrom`) is its first, never moved past the break.
 */
export const VIEW_START_PAD = 16;

export interface LineageLayout {
  orientation: Orientation;
  cards: ReadonlyMap<string, CardBox>;
  slots: YearSlot[];
  margin: Margin;
  axisSize: number;
  width: number;
  height: number;
}

/** The space between two year slots: more for years far apart, most next to an "Undated" one. */
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
  const breakMain = options.breakAt?.main;
  /** Where a slot or a row moved past the main break starts. */
  const pastMain = (options.breakAt?.mainPast ?? breakMain ?? 0) + BREAK_CLEAR;
  const viewFrom = options.breakAt?.mainFrom ?? Number.NEGATIVE_INFINITY;
  // Across the row's lanes, measured from where the lanes start.
  const crossStart = horizontal ? margin.top + axisSize : margin.left;
  const breakCross =
    horizontal && options.breakAt?.cross !== undefined
      ? options.breakAt.cross - crossStart
      : undefined;
  const pastCross =
    (options.breakAt?.crossPast ?? options.breakAt?.cross ?? 0) - crossStart + BREAK_CLEAR;
  const fromCross =
    horizontal && options.breakAt?.crossFrom !== undefined
      ? options.breakAt.crossFrom - crossStart
      : undefined;
  /**
   * A card's place across: one over the line the view's room starts at starts at it, and one
   * that would run over the break goes past it (not from 0).
   */
  const pastBreak = (at: number, size: number) => {
    const cross =
      fromCross !== undefined && at < fromCross && at + size > fromCross ? fromCross : at;
    // (A card that starts in the strip between the break and the view's end goes past it too.)
    return breakCross !== undefined &&
      cross > 0 &&
      cross < pastCross - BREAK_CLEAR &&
      cross + size > breakCross
      ? pastCross
      : cross;
  };
  // Horizontal: each lane a band. Vertical: the cards start right after the axis, in lane order
  // (a narrow panel has no room for a band per lane).
  const desiredCross = (card: CardInput) => (horizontal ? lanes.indexOf(card.lane) * pitch : 0);

  // Year slots in order, between the undated sources before them and the other undated tracks
  // after them: a track that feeds this one never sits after it.
  const years = [...new Set(cards.flatMap((card) => (card.year === null ? [] : [card.year])))].sort(
    (a, b) => a - b,
  );
  type Key = { year: number | null; side: 'before' | 'after' | null };
  const undated = (side: 'before' | 'after') =>
    cards.some((card) => card.year === null && (side === 'before') === Boolean(card.early))
      ? [{ year: null, side }]
      : [];
  const keys: Key[] = [
    ...undated('before'),
    ...years.map((year) => ({ year, side: null })),
    ...undated('after'),
  ];
  const inSlot = (card: CardInput, key: Key) =>
    key.year === null
      ? card.year === null && (key.side === 'before') === Boolean(card.early)
      : card.year === key.year;

  // Each slot's cards across the axis: in lane order, then the order they were given; the
  // collision pass moves a card further across past the one before it, and (vertical) wraps it
  // into a new row of its slot when it would run past `crossSpace`.
  type Row = { cards: Array<{ card: CardInput; cross: number }>; main: number };
  const slotRows = keys.map((key) => {
    const members = cards
      .map((card, order) => ({ card, order }))
      .filter(({ card }) => inSlot(card, key))
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
      cross = pastBreak(cross, size);
      row.cards.push({ card, cross });
      row.main = Math.max(row.main, mainOf(card));
    }
    if (row.cards.length > 0) rows.push(row);
    return rows;
  });

  // Along the axis: each slot after the one before it, the cards after the slot's heading.
  const mainStart = horizontal ? margin.left : margin.top;
  const heading = horizontal ? 0 : axisSize;
  const slots: YearSlot[] = [];
  const placed = new Map<string, CardBox>();
  let at = mainStart;
  let crossEnd = 0;
  /** True when [from, to] runs over the main break, starting in the view past `after`. */
  const overBreak = (from: number, to: number, after: number) =>
    breakMain !== undefined &&
    from > after &&
    from >= viewFrom &&
    from < pastMain - BREAK_CLEAR &&
    to > breakMain;
  /** Where the first slot in the view starts (none yet). */
  let firstInView = Number.NaN;
  keys.forEach(({ year, side }, index) => {
    if (index > 0) at += slotSpacing(keys[index - 1].year, year, slotGap);
    const rows = slotRows[index];
    // A slot whose heading and first row would run over the break starts past it, but for the
    // first slot in the view.
    // (Only the year that starts at the view's start, or within its pad: a view that starts
    // inside a year has no first year of its own.)
    if (Number.isNaN(firstInView) && at >= viewFrom) {
      firstInView = at <= viewFrom + VIEW_START_PAD + 0.5 ? at : Number.NEGATIVE_INFINITY;
    }
    if (
      rows.length > 0 &&
      overBreak(at, at + heading + rows[0].main, Math.max(mainStart, firstInView))
    ) {
      at = pastMain;
    }
    const start = at;
    let rowAt = at + heading;
    rows.forEach((row, r) => {
      // Down a column, a later row of the slot that would run over the break starts past it.
      if (r > 0 && overBreak(rowAt, rowAt + row.main, start)) {
        rowAt = pastMain;
      }
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
      rowAt += row.main + (r < rows.length - 1 ? gap : 0);
    });
    const size = rows.length > 0 ? rowAt - start : heading;
    slots.push({ year, side, label: year === null ? 'Undated' : String(year), start, size });
    at = start + size;
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
  /** Where it would best go (its centre). */
  near: { x: number; y: number };
  width: number;
  height: number;
  priority: number;
}

/**
 * Where each chip goes (its top-left corner), or null for one with no free place near its point:
 * never over a card, an obstacle or another chip, inside `bounds`, and its centre at most
 * `reach` from its point. The search goes outward from the point, ring by ring, and stops at the
 * first free place, so a chip costs little where there is room near its link. Chips are placed in
 * priority order (then in their own). Deterministic.
 */
export function placeChips(
  chips: readonly ChipInput[],
  cards: readonly CardBox[],
  bounds: CardBox,
  { step = 6, gap = 3, reach = 140 }: { step?: number; gap?: number; reach?: number } = {},
): Array<CardBox | null> {
  const order = chips
    .map((_, i) => i)
    .sort((a, b) => chips[b].priority - chips[a].priority || a - b);
  const placed: CardBox[] = [];
  const at: Array<CardBox | null> = chips.map(() => null);
  const inside = (box: CardBox) =>
    box.x >= bounds.x &&
    box.y >= bounds.y &&
    box.x + box.width <= bounds.x + bounds.width &&
    box.y + box.height <= bounds.y + bounds.height;
  const free = (box: CardBox) =>
    inside(box) &&
    !cards.some((card) => boxesMeet(box, card, gap)) &&
    !placed.some((chip) => boxesMeet(box, chip, gap));
  for (const i of order) {
    const { near, width, height } = chips[i];
    const boxAt = (dx: number, dy: number) => ({
      x: near.x + dx - width / 2,
      y: near.y + dy - height / 2,
      width,
      height,
    });
    let found: CardBox | null = null;
    for (let ring = 0; ring * step <= reach && found === null; ring += 1) {
      // The ring's points, nearest first, within the reach.
      const points: Array<[number, number]> = [];
      if (ring === 0) points.push([0, 0]);
      for (let k = -ring; k <= ring && ring > 0; k += 1) {
        points.push([k, -ring], [k, ring]);
        if (Math.abs(k) !== ring) points.push([-ring, k], [ring, k]);
      }
      points.sort(
        (a, b) => Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1]) || a[1] - b[1] || a[0] - b[0],
      );
      for (const [px, py] of points) {
        if (Math.hypot(px, py) * step > reach) continue;
        const box = boxAt(px * step, py * step);
        if (free(box)) {
          found = box;
          break;
        }
      }
    }
    if (found) {
      placed.push(found);
      at[i] = found;
    }
  }
  return at;
}

/** A point on the map. */
export interface Point {
  x: number;
  y: number;
}

/** A link's route: its SVG path, its middle (where its chip goes), and its two ends. */
export interface Route {
  d: string;
  mid: Point;
  start: Point;
  end: Point;
  /** True for a route out to a rail beside a column of cards, false between facing sides. */
  rail: boolean;
}

/**
 * Each link's route between its two cards, inside the drawing:
 * - between cards that stand apart across the page, a curve from the side of one facing the
 *   other to the facing side of the other;
 * - between cards in one column, out to a rail to the right of the column (and of every card
 *   between them), along it and back in; links that would share a stretch of rail get rails of
 *   their own, `railStep` apart, the shorter ones nearer the cards, so they fan out rather than
 *   run as one bundle. The rails take at most `railRoom` px beside the cards.
 * The ends on a card's side are spread down its edge, in the order of their other ends, so no two
 * arrowheads meet. `right` is how far right the routes reach: the drawing is at least that wide.
 */
export function routeLinks(
  links: ReadonlyArray<{ source: string; target: string }>,
  cards: ReadonlyMap<string, CardBox>,
  {
    railStep = 5,
    railGap = 8,
    railRoom = 80,
  }: { railStep?: number; railGap?: number; railRoom?: number } = {},
): { routes: Route[]; right: number } {
  const none: CardBox = { x: 0, y: 0, width: 0, height: 0 };
  const boxes = links.map((link) => [
    cards.get(link.source) ?? none,
    cards.get(link.target) ?? none,
  ]);
  const apart = (a: CardBox, b: CardBox) => a.x + a.width < b.x || b.x + b.width < a.x;
  const centreY = (box: CardBox) => box.y + box.height / 2;

  // Which side of each card each end leaves from: the facing side, or the right (a rail).
  type End = { link: number; card: string; side: 'left' | 'right'; other: number };
  const ends: End[] = [];
  links.forEach((link, n) => {
    const [a, b] = boxes[n];
    const forward = a.x < b.x;
    const [sideA, sideB]: Array<'left' | 'right'> = apart(a, b)
      ? forward
        ? ['right', 'left']
        : ['left', 'right']
      : ['right', 'right'];
    ends.push({ link: n, card: link.source, side: sideA, other: centreY(b) });
    ends.push({ link: n, card: link.target, side: sideB, other: centreY(a) });
  });
  // The ends on one side of one card, spread down its edge in the order of their other ends.
  const endY = new Map<string, number>();
  const groups = new Map<string, End[]>();
  for (const end of ends) {
    const key = `${end.card}\u0000${end.side}`;
    groups.set(key, [...(groups.get(key) ?? []), end]);
  }
  for (const group of groups.values()) {
    const box = cards.get(group[0].card) ?? none;
    group.sort((p, q) => p.other - q.other || p.link - q.link);
    group.forEach((end, i) => {
      endY.set(
        `${end.link}\u0000${end.card === links[end.link].source ? 's' : 't'}`,
        box.y + (box.height * (i + 1)) / (group.length + 1),
      );
    });
  }

  // Rails: a level for each rail link, so that links whose stretches overlap differ.
  const railLinks = links
    .map((_, n) => n)
    .filter((n) => !apart(boxes[n][0], boxes[n][1]))
    .map((n) => {
      const [y1, y2] = [endY.get(`${n}\u0000s`) ?? 0, endY.get(`${n}\u0000t`) ?? 0];
      return { n, top: Math.min(y1, y2), bottom: Math.max(y1, y2) };
    })
    .sort((p, q) => p.bottom - p.top - (q.bottom - q.top) || p.n - q.n);
  const level = new Map<number, number>();
  const levels: Array<Array<{ top: number; bottom: number }>> = [];
  for (const rail of railLinks) {
    let at = levels.findIndex((taken) =>
      taken.every((other) => rail.bottom + 2 < other.top || other.bottom + 2 < rail.top),
    );
    if (at === -1) {
      at = levels.length;
      levels.push([]);
    }
    levels[at].push(rail);
    level.set(rail.n, at);
  }
  const step =
    levels.length > 1 ? Math.min(railStep, (railRoom - railGap - 2) / (levels.length - 1)) : 0;

  let right = 0;
  const routes = links.map((_link, n): Route => {
    const [a, b] = boxes[n];
    const [sy, ty] = [endY.get(`${n}\u0000s`) ?? centreY(a), endY.get(`${n}\u0000t`) ?? centreY(b)];
    if (apart(a, b)) {
      const forward = a.x < b.x;
      const start = { x: forward ? a.x + a.width : a.x, y: sy };
      const end = { x: forward ? b.x : b.x + b.width, y: ty };
      const half = (end.x - start.x) / 2;
      right = Math.max(right, start.x, end.x);
      return {
        d: `M${start.x},${start.y} C${start.x + half},${sy} ${end.x - half},${ty} ${end.x},${end.y}`,
        mid: { x: (start.x + end.x) / 2, y: (sy + ty) / 2 },
        start,
        end,
        rail: false,
      };
    }
    const start = { x: a.x + a.width, y: sy };
    const end = { x: b.x + b.width, y: ty };
    const [top, bottom] = [Math.min(sy, ty), Math.max(sy, ty)];
    const column = Math.max(
      start.x,
      end.x,
      ...[...cards.values()]
        .filter((c) => c.y < bottom && c.y + c.height > top && !apart(c, a))
        .map((c) => c.x + c.width),
    );
    const rx = column + railGap + (level.get(n) ?? 0) * step;
    right = Math.max(right, rx);
    const r = Math.min(6, (bottom - top) / 2, rx - Math.max(start.x, end.x));
    const down = ty >= sy ? 1 : -1;
    const d = [
      `M${start.x},${sy}`,
      `H${rx - r}`,
      `Q${rx},${sy} ${rx},${sy + down * r}`,
      `V${ty - down * r}`,
      `Q${rx},${ty} ${rx - r},${ty}`,
      `H${end.x}`,
    ].join(' ');
    return { d, mid: { x: rx, y: (sy + ty) / 2 }, start, end, rail: true };
  });
  return { routes, right };
}
