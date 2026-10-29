import {
  bottomCues,
  cueWidth,
  type EdgeCounts,
  edgeCounts,
  effectiveBreaks,
  type FirstViewInput,
  planFirstView,
} from './firstView';
import {
  type CardBox,
  type CardInput,
  LANES,
  type LayoutOptions,
  layoutLineage,
  type ViewBreaks,
  VIEW_START_PAD,
} from './lineageLayout';

/**
 * Generated song-relations maps for tests (#240): random cards, years, lanes and rooms from a
 * seed, laid out and given their first view as the map does it, and each card judged against a
 * view's room for cards (wholly in it or wholly out of it, none under an edge cue's button).
 */

/** A seeded random number generator (mulberry32): the same seed, the same map. */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cardWidth = (text: number) => 48 + text;
type Shape = 'random' | 'oneYear' | 'undated' | 'span100' | 'crowded' | 'many';
const SHAPES: Shape[] = ['random', 'oneYear', 'undated', 'span100', 'crowded', 'many'];

function cardsOf(r: () => number, count: number, shape: Shape, across: boolean, text: number) {
  const cards: CardInput[] = [];
  for (let i = 0; i < count; i += 1) {
    const lane = i === 0 ? 'current' : LANES[Math.floor(r() * LANES.length)];
    let year: number | null;
    if (shape === 'oneYear') year = 1990;
    else if (shape === 'undated') year = null;
    else if (shape === 'span100') year = 1920 + Math.floor(r() * 101);
    else if (shape === 'crowded') year = 2000 + Math.floor(r() * 3);
    else if (shape === 'many') year = 1900 + i;
    else year = r() < 0.15 ? null : 1960 + Math.floor(r() * 60);
    const wide = across && r() < 0.2 ? text + 16 * Math.floor(r() * 10) : text;
    const lines = 1 + Math.floor(r() * 9);
    cards.push({
      id: `c${i}`,
      year,
      early: r() < 0.5,
      lane,
      width: cardWidth(Math.min(wide, 352)),
      height: 12 + Math.max(28, lines * 15),
    });
  }
  return cards;
}

/** The map's options, as the Player's map lays it out. */
const ACROSS = (): LayoutOptions => ({
  orientation: 'horizontal',
  gap: 10,
  slotGap: 44,
  axisSize: 22,
  margin: { top: 8, right: 24, bottom: 16, left: 16 },
});
const DOWN = (perRow: number, text: number): LayoutOptions => ({
  orientation: 'vertical',
  gap: 10,
  slotGap: 18,
  axisSize: 20,
  crossSpace: perRow * (cardWidth(text) + 10) - 10,
  margin: { top: 8, right: 64, bottom: 16, left: 22 },
});
export const CUE = 24;

/** A generated map, from its seed. */
export function generated(seed: number) {
  const r = random(seed);
  const across = r() < 0.6;
  const shape = SHAPES[Math.floor(r() * SHAPES.length)];
  const count = [1, 2, 3, 5, 8, 13, 20, 60][Math.floor(r() * 8)];
  const text = across ? 96 + 16 * Math.floor(r() * 8) : 96 + 16 * Math.floor(r() * 10);
  const room = across
    ? {
        width: 600 + Math.floor(r() * 1400),
        height: 120 + Math.floor(r() * 900),
        inset: Math.floor(r() * 140),
      }
    : {
        width: 320 + Math.floor(r() * 300),
        height: 150 + Math.floor(r() * 800),
        inset: Math.floor(r() * 150),
      };
  const perRow = Math.max(1, Math.floor((room.width - 22 - 60 + 10) / (cardWidth(text) + 10)));
  const cards = cardsOf(r, count, shape, across, text);
  return { cards, options: across ? ACROSS() : DOWN(perRow, text), room };
}

/**
 * The map's first view, as the map draws it: planned, its breaks kept where they change the
 * layout, and laid out; then each card judged against the room for cards on screen.
 */
export function firstView(
  cards: CardInput[],
  options: LayoutOptions,
  room: { width: number; height: number; inset: number },
) {
  const free = layoutLineage(cards, options);
  const band = (options.axisSize ?? 20) + 6;
  const laidWith = (breaks: ViewBreaks | undefined) =>
    breaks ? layoutLineage(cards, { ...options, breakAt: breaks }) : free;
  const input: FirstViewInput = {
    orientation: options.orientation,
    map: { width: free.width, height: free.height },
    slots: free.slots,
    cards: [...free.cards.values()],
    anchor: free.cards.get('c0') ?? null,
    room,
    pad: VIEW_START_PAD,
    cue: CUE,
    band,
    layout: (breaks) => {
      const laid = laidWith(breaks);
      return { cards: [...laid.cards.values()], anchor: laid.cards.get('c0') ?? null };
    },
    cueWidth,
  };
  const plan = planFirstView(input);
  const placesOf = (breaks: ViewBreaks | undefined) =>
    cards.map((card) => JSON.stringify(laidWith(breaks).cards.get(card.id))).join(' ');
  const breaks = effectiveBreaks(plan.breaks, placesOf);
  const laid = laidWith(breaks);
  const view = {
    left: -plan.x,
    right: room.width - plan.x,
    top: room.inset - plan.y,
    bottom: room.height - plan.y,
  };
  const anchor = laid.cards.get('c0') ?? null;
  return { ...judgeView(laid.cards, anchor, view, options, room), breaks, laid, view };
}

/** The band over the top of a view whose top is at `top` (map px), as the map draws it. */
export function headOf(boxes: Iterable<CardBox>, options: LayoutOptions) {
  const band = (options.axisSize ?? 20) + 6;
  const all = [...boxes];
  return (top: number) =>
    options.orientation === 'horizontal'
      ? top - ((options.margin?.top ?? 0) - 6) > 0
        ? band
        : 0
      : all.some((box) => box.y < top - 0.5)
        ? CUE
        : 0;
}

/** The edge cues' buttons over a view's bottom (map px), for the cards past its edges. */
export const buttonsOf =
  (width: number) => (counts: EdgeCounts, view: { left: number; bottom: number }) =>
    bottomCues(counts, width, cueWidth).map(
      ({ left, right }): CardBox => ({
        x: view.left + left,
        y: view.bottom - CUE,
        width: right - left,
        height: CUE,
      }),
    );

/**
 * Each card against a view (map px, the band over its top included): the cards cut (in part in
 * its room for cards, or under an edge cue's button), and whether the analysed card is wholly
 * in it. A card too large for the room is cut whatever the view, and so not counted.
 */
export function judgeView(
  cards: ReadonlyMap<string, CardBox>,
  anchor: CardBox | null,
  view: { left: number; right: number; top: number; bottom: number },
  options: LayoutOptions,
  room: { width: number; height: number; inset: number },
) {
  const across = options.orientation === 'horizontal';
  const band = (options.axisSize ?? 20) + 6;
  const boxes = [...cards.entries()];
  // The room for cards: under the pinned year labels (across), or under the band "↑ N more"
  // takes while a card starts above the view (down); both opaque.
  const area = { ...view, top: view.top + headOf(cards.values(), options)(view.top) };
  const counts = edgeCounts(
    boxes.map(([, box]) => box),
    area,
  );
  const buttons = buttonsOf(room.width)(counts, view);
  const within = (box: CardBox) =>
    box.x >= area.left - 0.5 &&
    box.x + box.width <= area.right + 0.5 &&
    box.y >= area.top - 0.5 &&
    box.y + box.height <= area.bottom + 0.5;
  const outside = (box: CardBox) =>
    box.x + box.width <= area.left + 0.5 ||
    box.x >= area.right - 0.5 ||
    box.y + box.height <= area.top + 0.5 ||
    box.y >= area.bottom - 0.5;
  const under = (box: CardBox) =>
    buttons.some(
      (b) =>
        box.x < b.x + b.width - 0.5 &&
        b.x < box.x + box.width - 0.5 &&
        box.y < b.y + b.height - 0.5 &&
        b.y < box.y + box.height - 0.5,
    );
  // A card too large for the room is cut whatever the view: one taller than the room below the
  // bands over its top and above the cues' strip at its bottom.
  const fits = (box: CardBox) =>
    box.width <= room.width && box.height <= room.height - room.inset - (across ? band : CUE) - CUE;
  const cut = boxes
    .filter(([, box]) => fits(box) && !outside(box) && (!within(box) || under(box)))
    .map(([id, box]) => `${id} ${[box.x, box.y, box.width, box.height].map(Math.round)}`);
  return {
    // (Where the analysed card is too large for the room, the view is cut wherever it goes.)
    cut: anchor && !fits(anchor) ? [] : cut,
    anchorIn: !anchor || !fits(anchor) || (within(anchor) && !under(anchor)),
    counts,
    fits,
  };
}
