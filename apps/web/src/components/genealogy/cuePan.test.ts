import { describe, expect, it } from 'vitest';
import { cuePan, type ViewEdges } from './cuePan';
import type { EdgeCounts } from './firstView';
import { buttonsOf, firstView, generated, headOf, judgeView } from './generatedMaps';
import type { CardBox } from './lineageLayout';
import { VIEW_START_PAD } from './lineageLayout';

// An edge cue pans the map no further than it takes to bring the next cards past that edge
// wholly into view, to a stop where no card is cut (#240).

const SIDES: Array<keyof EdgeCounts> = ['right', 'down', 'left', 'up'];

type View = { left: number; right: number; top: number; bottom: number };

/**
 * Every stop along the pan's axis (each pixel within the pan's reach) where a view brings
 * another card wholly in, passes over none of the cards past that edge and cuts none; the first.
 */
function cleanStop(
  map: ReturnType<typeof firstView>,
  options: ReturnType<typeof generated>['options'],
  room: ReturnType<typeof generated>['room'],
  side: keyof EdgeCounts,
  view: View,
) {
  const alongX = side === 'left' || side === 'right';
  const sign = side === 'right' || side === 'down' ? 1 : -1;
  const boxes = [...map.laid.cards.values()];
  const head = headOf(boxes, options);
  const areaOf = (v: View) => ({ ...v, top: v.top + head(v.top) });
  const whole = (area: View, b: CardBox) =>
    b.x >= area.left - 0.5 &&
    b.x + b.width <= area.right + 0.5 &&
    b.y >= area.top - 0.5 &&
    b.y + b.height <= area.bottom + 0.5;
  const lo = (b: CardBox) => (alongX ? b.x : b.y);
  const hi = (b: CardBox) => (alongX ? b.x + b.width : b.y + b.height);
  const now = areaOf(view);
  const beyond = boxes.filter((b) =>
    sign > 0
      ? hi(b) > (alongX ? now.right : now.bottom) + 0.5
      : lo(b) < (alongX ? now.left : now.top) - 0.5,
  );
  const start = alongX ? view.left : view.top;
  const span = alongX ? view.right - view.left : view.bottom - view.top;
  const size = alongX ? map.laid.width : map.laid.height;
  const [least, most] = [
    Math.min(0, -start) - span / 2,
    Math.max(0, size - span - start) + span / 2,
  ];
  for (let at = sign > 0 ? 1 : -1; at >= least && at <= most; at += sign) {
    const v = alongX
      ? { ...view, left: view.left + at, right: view.right + at }
      : { ...view, top: view.top + at, bottom: view.bottom + at };
    const area = areaOf(v);
    const passed = beyond.some((b) =>
      sign > 0
        ? hi(b) <= (alongX ? area.left : area.top) + 0.5
        : lo(b) >= (alongX ? area.right : area.bottom) - 0.5,
    );
    if (passed) continue;
    if (!boxes.some((b) => whole(area, b) && !whole(now, b))) continue;
    if (judgeView(map.laid.cards, null, v, options, room).cut.length === 0) return at;
  }
  return null;
}

/**
 * Each cue pressed again and again from the map's first view: the presses that left a card cut
 * although a stop along the pan's axis cuts none (cuePan missed it), and those that left one
 * cut where none does (the map's cards stand so that each such stop cuts one).
 */
function pressAll(seed: number) {
  const { cards, options, room } = generated(seed);
  const first = firstView(cards, options, room);
  const boxes = [...first.laid.cards.values()];
  const anchor = first.laid.cards.get('c0') ?? null;
  const missed: string[] = [];
  let unavoidable = 0;
  let view: ViewEdges = first.view;
  let presses = 0;
  for (const side of SIDES) {
    for (let press = 0; press < 8; press += 1) {
      const before = judgeView(first.laid.cards, anchor, view, options, room);
      if (before.counts[side] === 0) break;
      const move = cuePan({
        side,
        cards: boxes,
        anchor,
        view,
        headOf: headOf(boxes, options),
        map: { width: first.laid.width, height: first.laid.height },
        buttonsOf: buttonsOf(room.width),
        pad: VIEW_START_PAD,
      });
      presses += 1;
      if (move === null) {
        missed.push(`${side} #${press + 1}: no move with ${before.counts[side]} past it`);
        break;
      }
      const next = {
        left: view.left + move.dx,
        right: view.right + move.dx,
        top: view.top + move.dy,
        bottom: view.bottom + move.dy,
      };
      const after = judgeView(first.laid.cards, anchor, next, options, room);
      if (after.cut.length > 0) {
        const clean = cleanStop(first, options, room, side, view);
        if (clean === null) unavoidable += 1;
        else missed.push(`${side} #${press + 1}: ${after.cut.join(' ')} (none at ${clean})`);
      }
      view = next;
    }
  }
  return { missed, unavoidable, presses, view };
}

const card = (x: number, y: number, width = 100, height = 40): CardBox => ({ x, y, width, height });

describe('cuePan', () => {
  const plain = {
    anchor: null,
    headOf: () => 0,
    map: { width: 1000, height: 200 },
    buttonsOf: () => [],
    pad: 16,
  };

  it('pans only as far as it takes to bring the next card wholly in, to a stop that cuts none', () => {
    const cards = [card(10, 10), card(150, 10), card(290, 10), card(430, 10), card(570, 10)];
    const view = { left: 0, right: 320, top: 0, bottom: 200 };
    // 290–390 runs over the right edge. 70 brings it in but cuts 10–110 at the left; the
    // nearest stop that cuts none starts the view where 10–110 ends: 110–430 (150–250 and
    // 290–390 whole, 430–530 just past it), not a whole view further.
    expect(cuePan({ ...plain, side: 'right', cards, view })).toEqual({ dx: 110, dy: 0 });
    // And back: 0–320 would cut 290–390 again; the view ends where it starts, a little past
    // the map's start (-30–290) rather than cut a card.
    const back = { left: 110, right: 430, top: 0, bottom: 200 };
    expect(cuePan({ ...plain, side: 'left', cards, view: back })).toEqual({ dx: -140, dy: 0 });
  });

  it('does nothing where no card lies past that edge', () => {
    const cards = [card(10, 10)];
    expect(
      cuePan({
        ...plain,
        side: 'right',
        cards,
        view: { left: 0, right: 320, top: 0, bottom: 200 },
      }),
    ).toBeNull();
  });

  it('keeps the analysed card in view where a stop allows it', () => {
    const cards = [card(10, 10), card(150, 10), card(290, 10), card(410, 10)];
    const view = { left: 0, right: 300, top: 0, bottom: 200 };
    // Both 110 (110–410) and 150 (150–450, 10–110 past it, 410–510 cut) bring 290–390 in;
    // 110 keeps 150–250, the analysed card, in view and cuts none.
    expect(cuePan({ ...plain, side: 'right', cards, view, anchor: cards[1] })).toEqual({
      dx: 110,
      dy: 0,
    });
    // Where no stop that cuts none keeps it, the view goes on without it.
    expect(cuePan({ ...plain, side: 'right', cards, view, anchor: cards[0] })?.dx).toBe(110);
  });

  it('moves across the axis too where the next card lies past the view’s other edge', () => {
    // The next card right is lower than the view's bottom: the view goes down to it as well.
    const cards = [card(10, 10), card(200, 160)];
    const view = { left: 0, right: 250, top: 0, bottom: 150 };
    const move = cuePan({ ...plain, side: 'right', cards, view, map: { width: 400, height: 300 } });
    expect(move).not.toBeNull();
    const { dx = 0, dy = 0 } = move ?? {};
    const after = { left: dx, right: 250 + dx, top: dy, bottom: 150 + dy };
    // 200–300 × 160–200 wholly in view; 10–110 × 10–50 wholly in or wholly out.
    expect(after.left <= 200 && after.right >= 300 && after.top <= 160 && after.bottom >= 200).toBe(
      true,
    );
    const first = cards[0];
    const whole =
      after.left <= first.x && after.right >= 110 && after.top <= 10 && after.bottom >= 50;
    const out = after.left >= 110 || after.top >= 50;
    expect(whole || out).toBe(true);
  });

  it.each([
    [892, 'right', 1],
    [2664, 'right', 2],
    [580, 'left', 4],
  ] as const)(
    'keeps the analysed card in view on a generated map (seed %i, %s #%i)',
    (seed, side, presses) => {
      const { cards, options, room } = generated(seed);
      const first = firstView(cards, options, room);
      const boxes = [...first.laid.cards.values()];
      const anchor = first.laid.cards.get('c0') ?? null;
      let view: ViewEdges = first.view;
      const sides: Array<keyof EdgeCounts> =
        side === 'left' ? ['right', 'down', 'left'] : ['right'];
      let pressed = 0;
      for (const at of sides) {
        for (let press = 0; press < 8 && pressed < (at === side ? presses : 8); press += 1) {
          const before = judgeView(first.laid.cards, anchor, view, options, room);
          if (before.counts[at] === 0) break;
          const move = cuePan({
            side: at,
            cards: boxes,
            anchor,
            view,
            headOf: headOf(boxes, options),
            map: { width: first.laid.width, height: first.laid.height },
            buttonsOf: buttonsOf(room.width),
            pad: VIEW_START_PAD,
          });
          if (move === null) break;
          const next = {
            left: view.left + move.dx,
            right: view.right + move.dx,
            top: view.top + move.dy,
            bottom: view.bottom + move.dy,
          };
          const after = judgeView(first.laid.cards, anchor, next, options, room);
          if (at === side && pressed === presses - 1) {
            // In view before the press, in view after it: a stop that keeps it cuts none either.
            expect(before.anchorIn).toBe(true);
            expect(after.anchorIn).toBe(true);
            expect(after.cut).toEqual([]);
          }
          view = next;
          if (at === side) pressed += 1;
        }
      }
      expect(pressed).toBe(presses);
    },
  );

  it.each([
    [97, 'across'],
    [1, 'down'],
  ])('leaves no card cut, press after press, on a generated map (seed %i, %s)', (seed) => {
    const { missed, unavoidable, presses } = pressAll(seed);
    expect(presses).toBeGreaterThan(0);
    expect(missed).toEqual([]);
    expect(unavoidable).toBe(0);
  });

  it('leaves a card cut on 400 generated maps only where every stop along the axis cuts one', () => {
    const bad: string[] = [];
    let presses = 0;
    let unavoidable = 0;
    for (let seed = 1; seed <= 400; seed += 1) {
      const result = pressAll(seed);
      presses += result.presses;
      unavoidable += result.unavoidable;
      if (result.missed.length > 0) bad.push(`${seed}: ${result.missed.join('; ')}`);
    }
    expect(presses).toBeGreaterThan(400);
    expect(bad).toEqual([]);
    // (Such maps are rare: tall cards of uneven heights side by side in a short view.)
    expect(unavoidable / presses).toBeLessThan(0.1);
  });
});
