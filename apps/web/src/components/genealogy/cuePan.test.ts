import { describe, expect, it } from 'vitest';
import { cuePan, type ViewEdges } from './cuePan';
import { bottomCues, cueWidth, type EdgeCounts, edgeCounts } from './firstView';
import { buttonsOf, firstView, generated, headOf, judgeView } from './generatedMaps';
import type { CardBox } from './lineageLayout';
import { VIEW_START_PAD } from './lineageLayout';

// An edge cue pans the map no further than it takes to bring the next cards past that edge
// wholly into view, to a stop where no card is cut (#240).

const SIDES: Array<keyof EdgeCounts> = ['right', 'down', 'left', 'up'];

type View = { left: number; right: number; top: number; bottom: number };

/**
 * A stop inside the map, along the pan's axis and across it, where a view brings a card past
 * that edge wholly in, passes over none of the cards past that edge and cuts none; the first found, or
 * null (with `keep`, one where that card is wholly in view too). The stops are those that put a card's edge at one of the view's edges (under the band
 * over its top, whichever it then has): where any view is clean, one of these is.
 */
function cleanStop(
  map: ReturnType<typeof firstView>,
  options: ReturnType<typeof generated>['options'],
  room: ReturnType<typeof generated>['room'],
  side: keyof EdgeCounts,
  view: View,
  keep: CardBox | null = null,
) {
  const alongX = side === 'left' || side === 'right';
  const sign = side === 'right' || side === 'down' ? 1 : -1;
  const boxes = [...map.laid.cards.values()];
  const head = headOf(boxes, options, room.width);
  const heads = [...new Set([0, head(Number.POSITIVE_INFINITY)])];
  const areaOf = (v: View) => ({ ...v, top: v.top + head(v.top) });
  const whole = (area: View, b: CardBox) =>
    b.x >= area.left - 0.5 &&
    b.x + b.width <= area.right + 0.5 &&
    b.y >= area.top - 0.5 &&
    b.y + b.height <= area.bottom + 0.5;
  const lo = (b: CardBox, x: boolean) => (x ? b.x : b.y);
  const hi = (b: CardBox, x: boolean) => (x ? b.x + b.width : b.y + b.height);
  const now = areaOf(view);
  // The cards the cue counts: past that edge (one past a side and the top counts for the side).
  const beyond = boxes.filter((b) => edgeCounts([b], now)[side] > 0);
  /** The moves along an axis that put a card's edge at the view's start or end, in the map. */
  const stops = (x: boolean) => {
    const [start, end] = x ? [view.left, view.right] : [view.top, view.bottom];
    const size = x ? map.laid.width : map.laid.height;
    const [least, most] = [Math.min(0, -start), Math.max(0, size - (end - start) - start)];
    const found = new Set([0, least, most]);
    for (const b of boxes) {
      for (const h of x ? [0] : heads) {
        found.add(lo(b, x) - start - h);
        found.add(hi(b, x) - start - h);
      }
      found.add(lo(b, x) - end);
      found.add(hi(b, x) - end);
    }
    return [...found].filter((at) => at >= least - 0.5 && at <= most + 0.5);
  };
  const crosses = stops(!alongX);
  for (const main of stops(alongX).filter((at) => sign * at > 0)) {
    for (const cross of crosses) {
      const [dx, dy] = alongX ? [main, cross] : [cross, main];
      const v = {
        left: view.left + dx,
        right: view.right + dx,
        top: view.top + dy,
        bottom: view.bottom + dy,
      };
      const area = areaOf(v);
      const passed = beyond.some((b) =>
        sign > 0
          ? hi(b, alongX) <= (alongX ? area.left : area.top) + 0.5
          : lo(b, alongX) >= (alongX ? area.right : area.bottom) - 0.5,
      );
      if (passed) continue;
      if (!beyond.some((b) => whole(area, b))) continue;
      if (keep && !whole(area, keep)) continue;
      if (judgeView(map.laid.cards, null, v, options, room).cut.length === 0) return { dx, dy };
    }
  }
  return null;
}

/**
 * Each cue pressed again and again from the map's first view: the presses that left a card cut
 * although a stop along the pan's axis cuts none (cuePan missed it), and those that left one
 * cut where none does (the map's cards stand so that each such stop cuts one).
 */
function pressAll(seed: number, sides: Array<keyof EdgeCounts> = SIDES) {
  const { cards, options, room } = generated(seed);
  const first = firstView(cards, options, room);
  const boxes = [...first.laid.cards.values()];
  const anchor = first.laid.cards.get('c0') ?? null;
  const missed: string[] = [];
  const dropped: string[] = [];
  const analysedCut: string[] = [];
  let unavoidable = 0;
  let view: ViewEdges = first.view;
  let presses = 0;
  for (const side of sides) {
    for (let press = 0; press < 8; press += 1) {
      const before = judgeView(first.laid.cards, anchor, view, options, room);
      if (before.counts[side] === 0) break;
      const move = cuePan({
        side,
        cards: boxes,
        anchor,
        view,
        headOf: headOf(boxes, options, room.width),
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
      // The analysed card in view before the press: kept wherever a clean stop keeps it.
      if (anchor && before.anchorIn && !before.anchorTooBig && !after.anchorIn) {
        const kept = cleanStop(first, options, room, side, view, anchor);
        if (kept)
          dropped.push(
            `${side} #${press + 1}: the analysed card dropped (kept at ${JSON.stringify(kept)})`,
          );
      }
      // Never the analysed card cut where it fits the room (a stop that cuts only cards too
      // large for any view comes first).
      if (anchor && !after.anchorTooBig && after.cut.some((one) => one.startsWith('c0 '))) {
        analysedCut.push(`${side} #${press + 1}: ${after.cut.join(' ')}`);
      }
      if (after.cut.length > 0) {
        const clean = cleanStop(first, options, room, side, view);
        if (clean === null) unavoidable += 1;
        else
          missed.push(
            `${side} #${press + 1}: ${after.cut.join(' ')} (none at ${JSON.stringify(clean)})`,
          );
      }
      view = next;
    }
  }
  return { missed, dropped, analysedCut, unavoidable, presses, view };
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

  it('keeps the analysed card when "↓" first pans the wide map at 1920 px', () => {
    // The wide map's cards as the Player draws them at 1920x1080 (map px), its first view, and
    // its year labels pinned over a view that starts below the map's top. "2 more ↓": a stop
    // 85 px down brings h1 and h3 in and keeps "This track"; h4, some 1300 px off to the right,
    // runs over that stop's bottom edge but no pan down shows it.
    const cards = [
      card(636, 142, 256, 57), // current, the analysed track
      card(16, 30, 256, 57),
      card(316, 30, 256, 57),
      card(2234, 254, 320, 87),
      card(1922, 30, 256, 57),
      card(936, 30, 256, 42),
      card(2608, 30, 256, 42),
      card(2914, 30, 256, 42),
      card(1554, 478, 256, 42), // h1
      card(2608, 478, 256, 42),
      card(1242, 478, 256, 57), // h3
      card(3220, 478, 320, 102), // h4
      card(3628, 366, 256, 42),
    ];
    const view = { left: 0, right: 1920, top: 0, bottom: 450 };
    const move = cuePan({
      side: 'down',
      cards,
      anchor: cards[0],
      view,
      headOf: (top) => (top - 2 > 0 ? 28 : 0),
      map: { width: 3908, height: 585 },
      buttonsOf: (counts, room) =>
        bottomCues(counts, 1920, cueWidth).map(({ left, right }) => ({
          x: room.left + left,
          y: room.bottom - 24,
          width: right - left,
          height: 24,
        })),
      pad: VIEW_START_PAD,
    });
    expect(move).not.toBeNull();
    const { dx = 0, dy = 0 } = move ?? {};
    const room = { left: dx, right: 1920 + dx, top: dy + (dy - 2 > 0 ? 28 : 0), bottom: 450 + dy };
    const whole = (box: CardBox) =>
      box.x >= room.left &&
      box.x + box.width <= room.right &&
      box.y >= room.top &&
      box.y + box.height <= room.bottom;
    expect(whole(cards[0]), 'the analysed card').toBe(true);
    expect(whole(cards[8]) && whole(cards[10]), 'h1 and h3').toBe(true);
    // Nothing in view cut.
    for (const box of cards) {
      const out =
        box.x + box.width <= room.left ||
        box.x >= room.right ||
        box.y + box.height <= room.top ||
        box.y >= room.bottom;
      expect(whole(box) || out, JSON.stringify(box)).toBe(true);
    }
  });

  it('weighs no card far off across the axis, which a pan along it never shows', () => {
    // "↓": 310–350 below brings the view down 50 px. A card 1600 px off to the right, which
    // no pan down shows, runs over that stop's bottom edge: the nearest stop still wins, not
    // one past that card.
    const cards = [card(10, 10), card(200, 310), card(2000, 340, 100, 80)];
    const view = { left: 0, right: 400, top: 0, bottom: 300 };
    const map = { width: 2100, height: 600 };
    expect(cuePan({ ...plain, side: 'down', cards, view, map })).toEqual({ dx: 0, dy: 50 });
  });

  it('where every stop cuts a card, weighs none that no view holds whole', () => {
    // "↓" in a 300 px view: a 400 px card at the left is cut wherever it is in view, and the
    // two columns at 100 and 300 (on past the map's end) overlap so that every stop cuts two
    // of them, at its top and at its bottom (a move across keeps one column in view). The view goes no further than the next card needs, not past the tall
    // card (to 500 px and more) to leave it out.
    const column = (x: number) => Array.from({ length: 22 }, (_, i) => card(x, i * 50, 100, 100));
    const cards = [card(0, 100, 100, 400), card(200, 310), ...column(100), ...column(300)];
    const view = { left: 0, right: 400, top: 0, bottom: 300 };
    const move = cuePan({ ...plain, side: 'down', cards, view, map: { width: 400, height: 1000 } });
    expect(move?.dx).toBe(0);
    expect(move?.dy).toBeGreaterThanOrEqual(50);
    expect(move?.dy).toBeLessThan(100);
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
    [97, 'across'],
    [1, 'down'],
  ])('leaves no card cut, press after press, on a generated map (seed %i, %s)', (seed) => {
    const { missed, dropped, unavoidable, presses } = pressAll(seed);
    expect(presses).toBeGreaterThan(0);
    expect(missed).toEqual([]);
    expect(dropped).toEqual([]);
    expect(unavoidable).toBe(0);
  });

  it.each([
    [50149, 'a 134 px room: the analysed card, or a card too tall for any view'],
    [50203, 'a 94 px room: cards that fit, or cards too tall for any view'],
  ])('weighs only the cards that fit where every stop cuts one (seed %i, up: %s)', (seed) => {
    const { missed, dropped, analysedCut, presses } = pressAll(seed, ['up']);
    expect(presses).toBeGreaterThan(0);
    expect(analysedCut).toEqual([]);
    expect(missed).toEqual([]);
    expect(dropped).toEqual([]);
  });

  it('leaves a card cut, or the analysed card out, on 400 generated maps only where every stop does', () => {
    // The reference: every stop along the pan's axis and across it that puts a card's edge at
    // the view's edge, inside the map (see `cleanStop`).
    const bad: string[] = [];
    let presses = 0;
    let unavoidable = 0;
    for (let seed = 1; seed <= 400; seed += 1) {
      const result = pressAll(seed);
      presses += result.presses;
      unavoidable += result.unavoidable;
      const problems = [...result.missed, ...result.dropped];
      if (problems.length > 0) bad.push(`${seed}: ${problems.join('; ')}`);
    }
    expect(presses).toBeGreaterThan(1500);
    expect(bad).toEqual([]);
    // (Rare: tall cards of uneven heights side by side in a short view, no stop clear of them.)
    expect(unavoidable / presses).toBeLessThan(0.05);
    // (A second or so alone; a loaded machine takes longer.)
  }, 30_000);
});
