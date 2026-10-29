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
  /**
   * True when a card can be wholly in some view: no wider than the view, no taller than its
   * room under the band a view starting at that card has. One that cannot is cut wherever it
   * lies in view, so no stop is judged by it.
   */
  const fits = (box: CardBox) =>
    box.width <= view.right - view.left + 0.5 &&
    box.height <= view.bottom - view.top - headOf(box.y) + 0.5;
  const beyond = cards.filter((box) => edgeCounts([box], now)[side] > 0);
  if (beyond.length === 0) return null;
  // The least move that brings the nearest of them wholly in, and that card.
  const gap = (box: CardBox) =>
    sign > 0 ? hi(box, alongX) - end(now, alongX) : start(now, alongX) - lo(box, alongX);
  const need = Math.min(...beyond.map(gap));
  const next = beyond.filter((box) => gap(box) <= need + 0.5);
  // (Up, the band over the view's top may go with the move: as little as that may do.)
  const atLeast = side === 'up' ? Math.min(need, ...beyond.map((box) => view.top - box.y)) : need;

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
   * card that runs over its edges along the pan's axis and lies across from the view (a pan
   * back the other way finds none cut there either). A card far off to the side, which a pan
   * along this axis never shows, does not count.
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
    const facing = (box: CardBox) =>
      lo(box, !alongX) < end(room, !alongX) - 0.5 && hi(box, !alongX) > start(room, !alongX) + 0.5;
    const count = cards.filter((box) => {
      if (!fits(box)) return false;
      if (
        everywhere &&
        facing(box) &&
        (over(box, start(room, alongX)) || over(box, end(room, alongX)))
      ) {
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
    .filter((stop) => sign * stop >= atLeast - 0.5 && near(stop, along))
    .sort(
      (a, b) => Number(inside(b, along)) - Number(inside(a, along)) || Math.abs(a) - Math.abs(b),
    );
  /**
   * The moves across for a stop along the axis: those that put the edge of a card the view
   * then spans along the axis (one it could cut) at the view's edge, or that bring the next
   * card in where it lies past the view's other edges too; and the map's ends.
   */
  const crossesFor = (main: number) => {
    const room = roomAt(main, 0);
    const spanned = cards.filter(
      (box) =>
        lo(box, alongX) < end(room, alongX) - 0.5 && hi(box, alongX) > start(room, alongX) + 0.5,
    );
    return [
      ...new Set([
        0,
        across.least,
        across.most,
        ...stopsFor([...spanned, ...next], !alongX, 4).filter((stop) => near(stop, across)),
      ]),
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
   * Another card past that edge wholly in view, none of them passed over (gone past the view's
   * other edge without being wholly in it).
   */
  const bringsOne = (main: number, cross: number) => {
    const room = roomAt(main, cross);
    const passed = (box: CardBox) =>
      sign > 0
        ? hi(box, alongX) <= start(room, alongX) + 0.5
        : lo(box, alongX) >= end(room, alongX) - 0.5;
    return beyond.some((box) => whole(room, box)) && !beyond.some(passed);
  };
  const crosses = new Map<number, number[]>();
  const crossesAt = (main: number) => {
    let found = crosses.get(main);
    if (!found) {
      found = crossesFor(main);
      crosses.set(main, found);
    }
    return found;
  };
  const move = (main: number, cross: number) =>
    alongX ? { dx: main, dy: cross } : { dx: cross, dy: main };
  const anchorNow = anchor !== null && whole(now, anchor);
  // While the analysed card is in view, a stop that keeps it first; then: a stop that cuts no
  // card anywhere along the axis (that a pan along it could show), else none in view; inside
  // the map first; the next card wholly in, else another past that edge (where the next one
  // cannot be without a cut); the nearest along the axis, then across it.
  for (const keeping of anchorNow ? [true, false] : [false]) {
    for (const everywhere of [true, false]) {
      for (const within of [true, false]) {
        for (const brings of [bringsNext, bringsOne]) {
          for (const main of mains) {
            if (within && !inside(main, along)) continue;
            for (const cross of crossesAt(main)) {
              if (within && !inside(cross, across)) continue;
              if (keeping && !keeps(main, cross)) continue;
              if (!brings(main, cross) || cutsAt(main, cross, everywhere) !== 0) continue;
              return move(main, cross);
            }
          }
        }
      }
    }
  }
  // None: inside the map, the stop that cuts fewest of the cards that can be wholly in view
  // (one taller or wider than the room is cut wherever the view goes), the analysed card
  // kept where it can be, then the nearest.
  const fitting = (main: number, cross: number) => {
    const room = roomAt(main, cross);
    const buttons = buttonsOf(edgeCounts(cards, room), room);
    return cards.filter(
      (box) =>
        fits(box) &&
        !outside(room, box) &&
        (!whole(room, box) ||
          buttons.some(
            (b) =>
              box.x < b.x + b.width - 0.5 &&
              b.x < box.x + box.width - 0.5 &&
              box.y < b.y + b.height - 0.5 &&
              b.y < box.y + box.height - 0.5,
          )),
    ).length;
  };
  let best: { main: number; cross: number; cut: number; lost: boolean } | null = null;
  for (const main of mains) {
    if (!inside(main, along)) continue;
    for (const cross of crossesAt(main)) {
      if (!inside(cross, across)) continue;
      const cut = fitting(main, cross);
      const lost = anchor !== null && !whole(roomAt(main, cross), anchor);
      if (best === null || cut < best.cut || (cut === best.cut && !lost && best.lost)) {
        best = { main, cross, cut, lost };
      }
    }
  }
  if (best) return move(best.main, best.cross);
  return move(Math.max(along.least, Math.min(along.most, sign * need)), 0);
}
