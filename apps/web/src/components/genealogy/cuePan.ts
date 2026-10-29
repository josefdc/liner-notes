import { type EdgeCounts, edgeCounts } from './firstView';
import type { CardBox } from './lineageLayout';

/**
 * Where an edge cue ("4 more →") moves the song-relations map's view (#240): no further than it
 * takes to bring the next cards past that edge wholly into view, to a stop where no card is cut
 * (a card's or a year's edge), the analysed track's card kept in view where a stop allows it.
 * No DOM: the same map and view always give the same move.
 */

/** A view's edges (map px). */
export interface ViewEdges {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface CuePanInput {
  side: keyof EdgeCounts;
  cards: readonly CardBox[];
  /** The analysed track's card (null: none). */
  anchor: CardBox | null;
  /** The view now (map px), the band over its top included. */
  view: ViewEdges;
  /**
   * The opaque band over the top of a view whose top is at `top` (map px): the pinned year
   * labels, or "↑ N more"'s; the room for cards starts under it.
   */
  headOf: (top: number) => number;
  /** The map's size (map px): the view stays inside it where a stop allows. */
  map: { width: number; height: number };
  /** The edge cues' buttons over a view's bottom, for the cards past its edges (map px). */
  buttonsOf: (counts: EdgeCounts, view: ViewEdges) => CardBox[];
  /** Room kept before a card the view stops at, along the axis of years (map px). */
  pad: number;
}

/** The view's move (map px), or null when no card lies past that edge. */
export function cuePan(input: CuePanInput): { dx: number; dy: number } | null {
  const { side, cards, anchor, view, headOf, map, buttonsOf, pad } = input;
  const alongX = side === 'left' || side === 'right';
  const sign = side === 'right' || side === 'down' ? 1 : -1;
  /** The view moved by `main` along the pan's axis and `cross` across it: its room for cards. */
  const roomAt = (main: number, cross: number): ViewEdges => {
    const [dx, dy] = alongX ? [main, cross] : [cross, main];
    const top = view.top + dy;
    return {
      left: view.left + dx,
      right: view.right + dx,
      top: top + headOf(top),
      bottom: view.bottom + dy,
    };
  };
  const whole = (room: ViewEdges, box: CardBox) =>
    box.x >= room.left - 0.5 &&
    box.x + box.width <= room.right + 0.5 &&
    box.y >= room.top - 0.5 &&
    box.y + box.height <= room.bottom + 0.5;
  const outside = (room: ViewEdges, box: CardBox) =>
    box.x + box.width <= room.left + 0.5 ||
    box.x >= room.right - 0.5 ||
    box.y + box.height <= room.top + 0.5 ||
    box.y >= room.bottom - 0.5;
  // Along an axis: a box's start and end, a view's start and end.
  const lo = (box: CardBox, x: boolean) => (x ? box.x : box.y);
  const hi = (box: CardBox, x: boolean) => (x ? box.x + box.width : box.y + box.height);
  const start = (room: ViewEdges, x: boolean) => (x ? room.left : room.top);
  const end = (room: ViewEdges, x: boolean) => (x ? room.right : room.bottom);

  const now = roomAt(0, 0);
  const beyond = cards.filter((box) => edgeCounts([box], now)[side] > 0);
  if (beyond.length === 0) return null;
  // The least move that brings the nearest of them wholly in, and that card.
  const gap = (box: CardBox) =>
    sign > 0 ? hi(box, alongX) - end(now, alongX) : start(now, alongX) - lo(box, alongX);
  const need = Math.min(...beyond.map(gap));
  const next = beyond.filter((box) => gap(box) <= need + 0.5);

  // Every band a view's top may have under it (the pinned labels', or "↑ N more"'s), or none.
  const heads = [...new Set([0, headOf(Number.POSITIVE_INFINITY)])];
  /**
   * The moves along an axis that put a card's edge at the view's edge (with room before a card
   * it starts at), or the card just past it, whichever band the view's top then has.
   */
  const stopsFor = (boxes: readonly CardBox[], x: boolean, room: number) => {
    const raw = { start: x ? view.left : view.top, end: x ? view.right : view.bottom };
    const stops = new Set<number>();
    for (const box of boxes) {
      for (const head of x ? [0] : heads) {
        stops.add(lo(box, x) - room - raw.start - head);
        stops.add(lo(box, x) - raw.start - head);
        stops.add(hi(box, x) - raw.start - head);
      }
      stops.add(hi(box, x) + 4 - raw.end);
      stops.add(hi(box, x) - raw.end);
      stops.add(lo(box, x) - raw.end);
    }
    return [...stops];
  };

  // How far the view may go: inside the map, else up to half a view past its ends.
  const reachOf = (x: boolean) => {
    const raw = x ? [view.left, view.right] : [view.top, view.bottom];
    const span = raw[1] - raw[0];
    const size = x ? map.width : map.height;
    const least = Math.min(0, -raw[0]);
    const most = Math.max(0, size - span - raw[0]);
    return { least, most, span };
  };
  const along = reachOf(alongX);
  const across = reachOf(!alongX);
  const inside = (stop: number, reach: ReturnType<typeof reachOf>) =>
    stop >= reach.least - 0.5 && stop <= reach.most + 0.5;
  const near = (stop: number, reach: ReturnType<typeof reachOf>) =>
    stop >= reach.least - reach.span / 2 && stop <= reach.most + reach.span / 2;

  /**
   * The cards a view cuts: in view, at its edges or under a cue; with `everywhere`, also any
   * card of the map that runs over its edges along the pan's axis (a pan the other way later
   * finds none cut there either).
   */
  const counted = new Map<string, number>();
  const cutsAt = (main: number, cross: number, everywhere: boolean) => {
    const key = `${main} ${cross} ${everywhere}`;
    const known = counted.get(key);
    if (known !== undefined) return known;
    const room = roomAt(main, cross);
    const buttons = buttonsOf(edgeCounts(cards, room), room);
    const over = (box: CardBox, edge: number) =>
      lo(box, alongX) < edge - 0.5 && hi(box, alongX) > edge + 0.5;
    const count = cards.filter((box) => {
      if (everywhere && (over(box, start(room, alongX)) || over(box, end(room, alongX)))) {
        return true;
      }
      if (whole(room, box)) {
        return buttons.some(
          (b) =>
            box.x < b.x + b.width - 0.5 &&
            b.x < box.x + box.width - 0.5 &&
            box.y < b.y + b.height - 0.5 &&
            b.y < box.y + box.height - 0.5,
        );
      }
      return !outside(room, box);
    }).length;
    counted.set(key, count);
    return count;
  };

  const mains = [...stopsFor(cards, alongX, alongX ? pad : 4), sign * need]
    .filter((stop) => sign * stop >= need - 0.5 && near(stop, along))
    .sort(
      (a, b) => Number(inside(b, along)) - Number(inside(a, along)) || Math.abs(a) - Math.abs(b),
    );
  /**
   * The moves across that clear the cards a move along the axis leaves cut across it, or that
   * bring the next card in where it lies past the view's other edges too.
   */
  const crossesFor = (main: number) => {
    const room = roomAt(main, 0);
    const cut = cards.filter((box) => !whole(room, box) && !outside(room, box));
    return [
      0,
      ...stopsFor([...cut, ...next], !alongX, 4).filter((stop) => near(stop, across)),
    ].sort(
      (a, b) => Number(inside(b, across)) - Number(inside(a, across)) || Math.abs(a) - Math.abs(b),
    );
  };
  // (Kept only where it is in view now: a pan goes no further to bring it back.)
  const keeps = (main: number, cross: number) =>
    anchor === null || !whole(now, anchor) || whole(roomAt(main, cross), anchor);
  /** The next card past that edge wholly in view. */
  const bringsNext = (main: number, cross: number) =>
    next.some((box) => whole(roomAt(main, cross), box));
  /**
   * Another card wholly in view that was not, none of the cards past that edge passed over
   * (gone past the view's other edge without being wholly in it).
   */
  const bringsOne = (main: number, cross: number) => {
    const room = roomAt(main, cross);
    const passed = (box: CardBox) =>
      sign > 0
        ? hi(box, alongX) <= start(room, alongX) + 0.5
        : lo(box, alongX) >= end(room, alongX) - 0.5;
    return cards.some((box) => whole(room, box) && !whole(now, box)) && !beyond.some(passed);
  };
  const pairs = mains.flatMap((main) => crossesFor(main).map((cross) => [main, cross] as const));
  const move = (main: number, cross: number) =>
    alongX ? { dx: main, dy: cross } : { dx: cross, dy: main };
  // A stop that cuts no card anywhere along the axis, else none in view; inside the map first;
  // the next card wholly in, else another (where the next one cannot be without a cut); the
  // analysed card kept where one allows it; the nearest.
  for (const everywhere of [true, false]) {
    for (const within of [true, false]) {
      for (const brings of [bringsNext, bringsOne]) {
        const clean = pairs.filter(
          ([main, cross]) =>
            (!within || (inside(main, along) && inside(cross, across))) &&
            brings(main, cross) &&
            cutsAt(main, cross, everywhere) === 0,
        );
        const best = clean.find(([main, cross]) => keeps(main, cross)) ?? clean[0];
        if (best) return move(...best);
      }
    }
  }
  // None: the one that cuts fewest, inside the map.
  const fewest = mains
    .filter((stop) => inside(stop, along))
    .sort((a, b) => cutsAt(a, 0, false) - cutsAt(b, 0, false) || Math.abs(a) - Math.abs(b))[0];
  return move(fewest ?? Math.max(along.least, Math.min(along.most, sign * need)), 0);
}
