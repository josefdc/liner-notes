import { describe, expect, it } from 'vitest';
import {
  edgeCounts,
  effectiveBreaks,
  type FirstViewInput,
  planFirstView,
  sameBreaks,
} from './firstView';
import { type CardBox, layoutLineage, type YearSlot } from './lineageLayout';

const slot = (year: number | null, start: number, size: number): YearSlot => ({
  year,
  side: year === null ? 'before' : null,
  label: year === null ? 'Undated' : String(year),
  start,
  size,
});
const card = (x: number, y: number, width = 200, height = 60): CardBox => ({ x, y, width, height });

/** A row across the page: an "Undated" column, then years, one card per year in lane 0. */
function row(anchorAt: number, extra: CardBox[] = []): FirstViewInput {
  const slots = [
    slot(null, 16, 200),
    slot(1990, 300, 200),
    slot(2000, 560, 200),
    slot(2010, 820, 200),
  ];
  const cards = [...slots.map((s) => card(s.start, 30)), ...extra];
  return {
    orientation: 'horizontal',
    map: { width: 1060, height: 120 },
    slots,
    cards,
    anchor: cards[anchorAt],
    room: { width: 600, height: 400, inset: 40 },
    pad: 16,
    cue: 24,
    band: 28,
  };
}

describe('the first view (#240)', () => {
  it('shows a map that fits whole, centred along its axis, at its top across it', () => {
    const input = row(3);
    const wide = { ...input, room: { width: 1200, height: 400, inset: 40 } };
    expect(planFirstView(wide)).toEqual({ x: 70, y: 40, breaks: undefined });
  });

  it('starts at a dated year from which the analysed card fits, never at "Undated"', () => {
    // The analysed card in 2000: from 1990 and from 2000 it fits, with two cards whole each;
    // from 1990 it lies nearer the view's middle.
    const at2000 = planFirstView(row(2));
    expect(at2000.x).toBe(-284);
    expect(at2000.breaks).toEqual({ main: 884, mainFrom: 284 });
    // In 2010: from 1990 it would run past the view's edge, from 2000 it fits.
    const at2010 = planFirstView(row(3));
    expect(at2010.x).toBe(-544);
    // The card wholly in view.
    const anchor = row(3).anchor as CardBox;
    expect(anchor.x + at2010.x).toBeGreaterThanOrEqual(0);
    expect(anchor.x + anchor.width + at2010.x).toBeLessThanOrEqual(600);
    // Every card undated: the view starts at the map's edge.
    const undated = row(0);
    const all = { ...undated, slots: undated.slots.map((s) => ({ ...s, year: null })) };
    expect(planFirstView(all).x).toBe(-0);
  });

  it('starts where the most cards are whole, not at the earliest year the analysed card fits', () => {
    // As on a track with many relations: the analysed card in 2010, three tracks in 2020, one
    // in each earlier year. From 2000 (the earliest year it fits from) two cards are whole;
    // from 2010, four.
    const slots = [
      slot(null, 16, 200),
      slot(1990, 300, 200),
      slot(2000, 560, 200),
      slot(2010, 820, 200),
      slot(2020, 1080, 200),
    ];
    const anchor = card(820, 30);
    const cards = [
      card(16, 30),
      card(300, 30),
      card(560, 30),
      anchor,
      card(1080, 30),
      card(1080, 100),
      card(1080, 170),
    ];
    const input: FirstViewInput = {
      orientation: 'horizontal',
      map: { width: 1300, height: 240 },
      slots,
      cards,
      anchor,
      room: { width: 600, height: 400, inset: 40 },
      pad: 16,
      cue: 24,
      band: 28,
    };
    const view = planFirstView(input);
    expect(view.x).toBe(-804);
    expect(view.breaks).toBeUndefined();
    // The analysed card wholly in view.
    expect(anchor.x + view.x).toBeGreaterThanOrEqual(0);
    expect(anchor.x + anchor.width + view.x).toBeLessThanOrEqual(600);
    // With one track in 2020, both starts show two cards whole: the one with the analysed card
    // nearer the view's middle wins (from 2000: 76 px off it; from 2010: 184 px).
    const fewer = { ...input, cards: cards.slice(0, 5) };
    expect(planFirstView(fewer).x).toBe(-544);
    // A tie where the later start has the analysed card nearer the middle: from 1990 and from
    // 2000 a 1000 px room shows four cards whole; the card lies 136 px off the middle from
    // 1990, 124 px from 2000.
    const later = {
      ...input,
      map: { width: 1600, height: 240 },
      slots: [...slots, slot(2030, 1340, 200)],
      cards: [...cards.slice(0, 5), card(1340, 30)],
      room: { width: 1000, height: 400, inset: 40 },
    };
    expect(planFirstView(later).x).toBe(-544);
  });

  it('keeps the bottom strip clear for the edge cues where cards lie past the view', () => {
    // A lane low enough to run under the cues' strip (the room is 360 below the band).
    const low = planFirstView(row(2, [card(560, 300)]));
    expect(low.breaks).toEqual({ main: 884, mainFrom: 284, cross: 336, crossPast: 360 });
    // A map that fits along its axis and across it: no strip, no break.
    const fits = { ...row(2), room: { width: 1200, height: 400, inset: 40 } };
    expect(planFirstView(fits).breaks).toBeUndefined();
  });

  it('down a column, centres on the analysed card from a year’s label, the cues’ strip clear', () => {
    const slots = [0, 1, 2, 3, 4, 5].map((i) => slot(1990 + i, i * 300, 280));
    const cards = slots.map((s) => card(22, s.start + 20, 300, 260));
    const input: FirstViewInput = {
      orientation: 'vertical',
      map: { width: 360, height: 1800 },
      slots,
      cards,
      anchor: cards[3],
      room: { width: 390, height: 700, inset: 100 },
      pad: 16,
      cue: 24,
      band: 0,
    };
    const view = planFirstView(input);
    // Centred on the card, the view's top would fall in 1992 (at 762): from 1992's label the
    // card would run under the strip, so the view starts at the top of 1992's card instead
    // (none cut), the card wholly above the strip.
    expect(view).toEqual({
      x: 0,
      y: 100 - 616,
      breaks: { main: 616 + 576, mainPast: 616 + 600, mainFrom: 616 },
    });
    // With more room the view starts at 1992's label.
    const taller = planFirstView({ ...input, room: { width: 390, height: 760, inset: 100 } });
    expect(taller.y).toBe(100 - 600);
    // A column that fits: centred below the band.
    const short = { ...input, map: { width: 360, height: 400 }, cards: cards.slice(0, 1) };
    expect(planFirstView(short)).toEqual({ x: 0, y: 200, breaks: undefined });
  });

  it('tells two sets of breaks apart', () => {
    expect(sameBreaks(undefined, undefined)).toBe(true);
    expect(sameBreaks({ main: 10 }, { main: 10 })).toBe(true);
    expect(sameBreaks({ main: 10 }, { main: 11 })).toBe(false);
    expect(sameBreaks({ main: 10 }, { main: 10, cross: 5 })).toBe(false);
    expect(sameBreaks({ main: 10, mainFrom: 0 }, { main: 10, mainFrom: 4 })).toBe(false);
    expect(sameBreaks({ cross: 5, crossPast: 9 }, { cross: 5, crossPast: 8 })).toBe(false);
    expect(sameBreaks({ main: 10 }, undefined)).toBe(false);
  });

  it('keeps only the breaks that move a card', () => {
    const cards = [1990, 2000, 2010].map((year, i) => ({
      id: `c${i}`,
      year,
      lane: 'sample' as const,
      width: 200,
      height: 60,
    }));
    const options = { orientation: 'horizontal' as const, slotGap: 44 };
    const free = layoutLineage(cards, options);
    const moves = (only: object) => {
      const laid = layoutLineage(cards, { ...options, breakAt: only });
      return cards.some((c) => laid.cards.get(c.id)?.x !== free.cards.get(c.id)?.x);
    };
    // A line through the second card moves it; one between the cards moves none.
    const through = (free.cards.get('c1') as CardBox).x + 100;
    expect(effectiveBreaks({ main: through, cross: 1000 }, moves)).toEqual({ main: through });
    const between = (free.cards.get('c1') as CardBox).x - 10;
    expect(effectiveBreaks({ main: between }, moves)).toBeUndefined();
    expect(effectiveBreaks(undefined, moves)).toBeUndefined();
  });

  it('counts the cards past each edge, each once', () => {
    const view = { left: 0, top: 0, right: 600, bottom: 400 };
    expect(
      edgeCounts(
        [
          card(10, 10),
          card(500, 10),
          card(-300, 10),
          card(10, 390),
          card(10, -100),
          card(700, 500),
        ],
        view,
      ),
    ).toEqual({ left: 1, right: 2, up: 1, down: 1 });
  });
});
