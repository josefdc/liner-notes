import { describe, expect, it } from 'vitest';
import {
  BREAK_CLEAR,
  boxesMeet,
  type CardBox,
  type CardInput,
  charsToWrap,
  graphemes,
  graphemeUnits,
  isSparse,
  LANES,
  type Lane,
  laneOf,
  layoutLineage,
  orientationFor,
  placeChips,
  routeLinks,
  textUnits,
  wrapText,
} from './lineageLayout';

const card = (id: string, year: number | null, lane: Lane, height = 52): CardInput => ({
  id,
  year,
  lane,
  width: 200,
  height,
});

// A map like the genealogy-kinds result's: sources of every relation, many in one year, a
// remix after this track, a second hop, and two tracks that carry no year.
const CARDS: CardInput[] = [
  card('current', 2011, 'current', 70),
  card('sample', 1984, 'sample'),
  card('interpolation', 1984, 'interpolation'),
  card('cover', 1984, 'cover'),
  card('producer', 1984, 'producer'),
  card('influence', 1984, 'influence'),
  card('sample-2', 1984, 'sample', 64),
  card('inferred-1', 1990, 'influence'),
  card('inferred-2', 1990, 'influence'),
  card('inferred-3', 1990, 'influence'),
  card('older', 1977, 'sample'),
  card('remix', 2015, 'remix'),
  card('later', 2020, 'influence'),
  card('sibling', 1999, 'second-hop'),
  card('undated-1', null, 'remix'),
  card('undated-2', null, 'sample', 64),
];

const centre = (box: CardBox) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
const placed = (layout: ReturnType<typeof layoutLineage>, id: string) => {
  const box = layout.cards.get(id);
  if (!box) throw new Error(`${id} is not placed`);
  return box;
};

/** Every pair of placed cards that overlap. */
function overlaps(layout: ReturnType<typeof layoutLineage>): string[] {
  const entries = [...layout.cards];
  const found: string[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      if (boxesMeet(entries[i][1], entries[j][1])) found.push(`${entries[i][0]}/${entries[j][0]}`);
    }
  }
  return found;
}

describe('layoutLineage, horizontal', () => {
  const layout = layoutLineage(CARDS, { orientation: 'horizontal', margin: { top: 40, left: 16 } });

  it('places x by year: an earlier year always to the left, one year one column', () => {
    const dated = CARDS.filter((c) => c.year !== null);
    for (const a of dated) {
      for (const b of dated) {
        const [xa, xb] = [centre(placed(layout, a.id)).x, centre(placed(layout, b.id)).x];
        if ((a.year ?? 0) < (b.year ?? 0)) expect(xa, `${a.id} before ${b.id}`).toBeLessThan(xb);
        if (a.year === b.year) expect(xa).toBe(xb);
      }
    }
    expect(layout.slots.map((slot) => slot.label)).toEqual([
      '1977',
      '1984',
      '1990',
      '1999',
      '2011',
      '2015',
      '2020',
      'Undated',
    ]);
    // Years further apart are further apart on the axis.
    const startOf = (label: string) => layout.slots.find((s) => s.label === label)?.start ?? 0;
    expect(startOf('1999') - startOf('1990')).toBeGreaterThan(startOf('2015') - startOf('2011'));
  });

  it('anchors the analysed track at its year', () => {
    const slot = layout.slots.find((s) => s.year === 2011);
    const x = centre(placed(layout, 'current')).x;
    expect(slot).toBeDefined();
    expect(x).toBeGreaterThan(slot?.start ?? 0);
    expect(x).toBeLessThan((slot?.start ?? 0) + (slot?.size ?? 0));
    // Sources to its left, the tracks after it to its right.
    expect(centre(placed(layout, 'sample')).x).toBeLessThan(x);
    expect(centre(placed(layout, 'remix')).x).toBeGreaterThan(x);
  });

  it('puts a track with no year in the "Undated" column at the end of the axis, never at a year', () => {
    const undated = layout.slots.at(-1);
    expect(undated).toMatchObject({ year: null, label: 'Undated' });
    const lastDated = Math.max(
      ...CARDS.filter((c) => c.year !== null).map((c) => {
        const box = placed(layout, c.id);
        return box.x + box.width;
      }),
    );
    for (const id of ['undated-1', 'undated-2']) {
      const box = placed(layout, id);
      expect(box.x).toBeGreaterThan(lastDated);
      expect(box.x).toBeGreaterThanOrEqual(undated?.start ?? 0);
      expect(box.x + box.width).toBeLessThanOrEqual((undated?.start ?? 0) + (undated?.size ?? 0));
    }
    // No slot is made up for them: the dated slots are the years the cards carry.
    expect(layout.slots.filter((s) => s.year !== null)).toHaveLength(7);
  });

  it('sets lanes by relation, in their order across the axis', () => {
    // In one year, the lanes come in order from the top.
    const y = (id: string) => placed(layout, id).y;
    expect(y('sample')).toBeLessThan(y('interpolation'));
    expect(y('interpolation')).toBeLessThan(y('cover'));
    expect(y('cover')).toBeLessThan(y('producer'));
    expect(y('producer')).toBeLessThan(y('influence'));
    // A lane is a band: an uncrowded card of a lane sits in it whatever its year.
    expect(y('older')).toBe(y('sample'));
    expect(y('sibling')).toBeGreaterThan(y('current'));
    // The analysed track's lane comes after the sources' and before the remixes'.
    expect(LANES.indexOf('current')).toBeGreaterThan(LANES.indexOf('cover'));
    expect(LANES.indexOf('current')).toBeLessThan(LANES.indexOf('remix'));
    expect(y('remix')).toBeGreaterThan(y('current'));
  });

  it('lets no two cards overlap, moving them across the axis only', () => {
    expect(overlaps(layout)).toEqual([]);
    // Two samples of 1984 and three influences of 1990: stacked, not on top of each other.
    expect(placed(layout, 'sample-2').x).toBe(placed(layout, 'sample').x);
    expect(placed(layout, 'sample-2').y).not.toBe(placed(layout, 'sample').y);
  });

  it('is the same map every time for the same cards', () => {
    const again = layoutLineage(CARDS, {
      orientation: 'horizontal',
      margin: { top: 40, left: 16 },
    });
    expect([...again.cards]).toEqual([...layout.cards]);
    expect(again.slots).toEqual(layout.slots);
  });

  it('covers every card in its extent', () => {
    for (const box of layout.cards.values()) {
      expect(box.x + box.width).toBeLessThanOrEqual(layout.width);
      expect(box.y + box.height).toBeLessThanOrEqual(layout.height);
      expect(box.y).toBeGreaterThanOrEqual(40 + layout.axisSize);
    }
  });
});

describe('layoutLineage, vertical (below md, or a narrow panel)', () => {
  it('turns the axis vertical below md, and in a panel too narrow for years side by side', () => {
    expect(orientationFor(390, 390)).toBe('vertical');
    expect(orientationFor(767, 767)).toBe('vertical');
    expect(orientationFor(1024, 1024)).toBe('horizontal');
    // A panel too narrow for years side by side, at any width of the window.
    expect(orientationFor(1440, 360)).toBe('vertical');
    expect(orientationFor(1440, 1440)).toBe('horizontal');
  });

  const layout = layoutLineage(CARDS, {
    orientation: 'vertical',
    crossSpace: 260,
    margin: { top: 52, left: 14, right: 24 },
  });

  it('runs the years from top to bottom, each card in its year’s slot', () => {
    const dated = CARDS.filter((c) => c.year !== null);
    for (const a of dated) {
      for (const b of dated) {
        if ((a.year ?? 0) < (b.year ?? 0)) {
          const [boxA, boxB] = [placed(layout, a.id), placed(layout, b.id)];
          expect(boxA.y + boxA.height, `${a.id} above ${b.id}`).toBeLessThan(boxB.y);
        }
      }
    }
    for (const c of CARDS) {
      const slot = layout.slots.find((s) => s.year === c.year);
      const box = placed(layout, c.id);
      expect(box.y).toBeGreaterThanOrEqual((slot?.start ?? 0) + layout.axisSize);
      expect(box.y + box.height).toBeLessThanOrEqual((slot?.start ?? 0) + (slot?.size ?? 0));
    }
    expect(layout.slots.at(-1)?.label).toBe('Undated');
  });

  it('wraps a crowded year into rows inside the panel, with no overlap', () => {
    expect(overlaps(layout)).toEqual([]);
    for (const box of layout.cards.values()) {
      expect(box.x).toBeGreaterThanOrEqual(14);
      expect(box.x + box.width).toBeLessThanOrEqual(14 + 260);
    }
    // Lanes in order inside a year: the 1984 sample above its interpolation.
    expect(placed(layout, 'sample').y).toBeLessThan(placed(layout, 'interpolation').y);
  });
});

/** The cards that straddle a line across the map (x = at, or y = at): neither before nor past it. */
function straddling(
  layout: ReturnType<typeof layoutLineage>,
  axis: 'x' | 'y',
  at: number,
): string[] {
  return [...layout.cards]
    .filter(([, box]) => {
      const [from, to] = axis === 'x' ? [box.x, box.x + box.width] : [box.y, box.y + box.height];
      return from < at && to > at;
    })
    .map(([id]) => id);
}

describe('layoutLineage, where the first view ends (#240)', () => {
  const options = { orientation: 'horizontal' as const, margin: { top: 40, left: 16 } };
  const free = layoutLineage(CARDS, options);

  it('starts a year that would run over the view’s right edge past it, and moves no year before', () => {
    // A line through the 1999 column, as the free layout places it.
    const slot = free.slots.find((s) => s.year === 1999);
    if (!slot) throw new Error('no 1999');
    const edge = slot.start + slot.size / 2;
    expect(straddling(free, 'x', edge)).toEqual(['sibling']);
    const broken = layoutLineage(CARDS, { ...options, breakAt: { main: edge } });
    expect(straddling(broken, 'x', edge)).toEqual([]);
    expect(placed(broken, 'sibling').x).toBeGreaterThanOrEqual(edge);
    // Each card keeps its year's column, in year order; the earlier years do not move.
    for (const card of CARDS) {
      const was = placed(free, card.id);
      const now = placed(broken, card.id);
      if (was.x + was.width <= edge) expect(now, card.id).toEqual(was);
      else expect(now.x - was.x, card.id).toBeCloseTo(edge + BREAK_CLEAR - slot.start, 6);
    }
    expect(broken.slots.map((s) => s.label)).toEqual(free.slots.map((s) => s.label));
    expect(overlaps(broken)).toEqual([]);
    expect(broken.width).toBeGreaterThan(free.width);
  });

  it('moves a card across the lanes past the view’s bottom edge, never one in the first lane', () => {
    const current = placed(free, 'current');
    const edge = current.y + current.height / 2;
    expect(straddling(free, 'y', edge).length).toBeGreaterThan(0);
    const broken = layoutLineage(CARDS, { ...options, breakAt: { cross: edge } });
    expect(straddling(broken, 'y', edge)).toEqual([]);
    expect(placed(broken, 'current').y).toBe(edge + BREAK_CLEAR);
    // Above the edge nothing moves, and no card leaves its year.
    for (const card of CARDS) {
      const was = placed(free, card.id);
      const now = placed(broken, card.id);
      expect(now.x, card.id).toBe(was.x);
      if (was.y + was.height <= edge) expect(now.y, card.id).toBe(was.y);
    }
    expect(overlaps(broken)).toEqual([]);
    // A line through the first lane: those cards cannot be shown whole by moving them.
    const first = placed(free, 'sample');
    const through = first.y + first.height / 2;
    const kept = layoutLineage(CARDS, { ...options, breakAt: { cross: through } });
    expect(placed(kept, 'sample')).toEqual(first);
  });

  it('down a column, starts a year, or a row of a crowded year, past the view’s bottom edge', () => {
    const column = {
      orientation: 'vertical' as const,
      crossSpace: 260,
      margin: { top: 52, left: 14 },
    };
    const freeColumn = layoutLineage(CARDS, column);
    // The 1984 slot holds rows: a line through its second row, and one through the 2011 card.
    const second = placed(freeColumn, 'cover');
    const rowEdge = second.y + second.height / 2;
    const yearEdge = placed(freeColumn, 'current').y + 10;
    for (const edge of [rowEdge, yearEdge]) {
      expect(straddling(freeColumn, 'y', edge).length, `${edge}`).toBeGreaterThan(0);
      const broken = layoutLineage(CARDS, { ...column, breakAt: { main: edge } });
      expect(straddling(broken, 'y', edge), `${edge}`).toEqual([]);
      expect(overlaps(broken)).toEqual([]);
      // Each card still in its year's slot, its year's label above it.
      for (const c of CARDS) {
        const slot = broken.slots.find((s) => s.year === c.year);
        const box = placed(broken, c.id);
        expect(box.y).toBeGreaterThanOrEqual((slot?.start ?? 0) + broken.axisSize);
        expect(box.y + box.height).toBeLessThanOrEqual((slot?.start ?? 0) + (slot?.size ?? 0));
      }
    }
    // A year moved whole takes its label with it: the 2011 slot starts past the edge.
    const moved = layoutLineage(CARDS, { ...column, breakAt: { main: yearEdge } });
    expect(moved.slots.find((s) => s.year === 2011)?.start).toBe(yearEdge + BREAK_CLEAR);
  });

  it('moves a card past a break by a hair: wholly out of the view, with no more gap than that', () => {
    expect(BREAK_CLEAR).toBe(2);
    const slot = free.slots.find((s) => s.year === 1999);
    if (!slot) throw new Error('no 1999');
    const edge = slot.start + slot.size / 2;
    const broken = layoutLineage(CARDS, { ...options, breakAt: { main: edge } });
    expect(placed(broken, 'sibling').x).toBe(edge + BREAK_CLEAR);
    expect(placed(broken, 'sibling').x).toBeGreaterThan(edge);
    // With a strip between the room for cards and the view's end (the edge cues'), past the
    // strip; a card that starts in the strip goes past it too.
    const strip = layoutLineage(CARDS, {
      ...options,
      breakAt: { main: edge, mainPast: edge + 30 },
    });
    expect(placed(strip, 'sibling').x).toBe(edge + 30 + BREAK_CLEAR);
    const inStrip = layoutLineage(CARDS, {
      ...options,
      breakAt: { main: slot.start - 10, mainPast: slot.start + 20 },
    });
    expect(placed(inStrip, 'sibling').x).toBe(slot.start + 20 + BREAK_CLEAR);
  });

  it('never moves the first year in a view that starts past the map’s start', () => {
    const slot = free.slots.find((s) => s.year === 1999);
    if (!slot) throw new Error('no 1999');
    // A view from 1999 too narrow for its column: the column stays, the next years move.
    const narrow = layoutLineage(CARDS, {
      ...options,
      breakAt: { main: slot.start + 20, mainFrom: slot.start - 8 },
    });
    expect(placed(narrow, 'sibling')).toEqual(placed(free, 'sibling'));
    // From the map's start, the same line moves 1999.
    const fromStart = layoutLineage(CARDS, { ...options, breakAt: { main: slot.start + 20 } });
    expect(placed(fromStart, 'sibling').x).toBe(slot.start + 20 + BREAK_CLEAR);
  });

  it('starts a card across the view’s top line (a view below the map’s top) at the line', () => {
    const current = placed(free, 'current');
    const line = current.y + current.height / 2;
    const broken = layoutLineage(CARDS, { ...options, breakAt: { crossFrom: line } });
    expect(straddling(broken, 'y', line)).toEqual([]);
    expect(placed(broken, 'current').y).toBe(line);
    for (const card of CARDS) {
      const was = placed(free, card.id);
      if (was.y + was.height <= line) expect(placed(broken, card.id), card.id).toEqual(was);
    }
    expect(overlaps(broken)).toEqual([]);
  });

  it('lays the map out as before with no break, or one past the map', () => {
    expect(layoutLineage(CARDS, { ...options, breakAt: {} })).toEqual(free);
    expect(layoutLineage(CARDS, { ...options, breakAt: { main: free.width + 10 } })).toEqual(free);
  });
});

describe('a card’s lane', () => {
  it('is the analysed track’s, the relation its link is drawn as, or a second hop', () => {
    expect(laneOf(true, 'sample')).toBe('current');
    expect(laneOf(false, 'cover')).toBe('cover');
    expect(laneOf(false, null)).toBe('second-hop');
  });
});

describe('the compact row', () => {
  it('stands in for the canvas only when the whole map is small: two links or fewer', () => {
    expect(isSparse(0)).toBe(true);
    expect(isSparse(2)).toBe(true);
    expect(isSparse(3)).toBe(false);
  });
});

describe('wrapText, character by character (#240)', () => {
  it('counts a wide character (CJK, kana, Hangul, fullwidth, an emoji) as two cells', () => {
    expect(textUnits('abc')).toBe(3);
    expect(textUnits('夜明け')).toBe(6);
    expect(textUnits('シティポップ')).toBe(12);
    expect(textUnits('한국')).toBe(4);
    expect(textUnits('ＡＢ')).toBe(4);
    expect(textUnits('😀')).toBe(2);
    // A letter with its accent, and an emoji with its modifier, are one grapheme each.
    expect(graphemes('e\u0301')).toEqual(['e\u0301']);
    expect(graphemes('👍🏽')).toHaveLength(1);
    expect(graphemeUnits('👍🏽')).toBe(2);
    expect(graphemeUnits('e\u0301')).toBe(1);
  });

  it('wraps wide characters by the cells they take, never past the line', () => {
    const title = '夜明けの街角で踊る二人の物語シティポップリミックス';
    const wrapped = wrapText(title, 20, 4);
    for (const line of wrapped.lines) expect(textUnits(line), line).toBeLessThanOrEqual(20);
    expect(wrapped.lines.map((line) => line.replace(/-$/, '')).join('')).toBe(title);
  });

  it('never splits an emoji or a letter from its accent when it breaks a word', () => {
    const word = `${'a'.repeat(45)}😀${'b'.repeat(150)}`;
    const wrapped = wrapText(word, 47, 6);
    for (const line of wrapped.lines) {
      expect(line, line).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
      expect(line, line).not.toMatch(/(?<![\ud800-\udbff])[\udc00-\udfff]/);
      expect(textUnits(line)).toBeLessThanOrEqual(47);
    }
    expect(wrapped.lines.map((line) => line.replace(/-$/, '')).join('')).toBe(word);
    const accents = wrapText('e\u0301'.repeat(30), 10, 6);
    for (const line of accents.lines) expect(line.startsWith('\u0301'), line).toBe(false);
    // Cut to fit: the ellipsis never follows half an emoji.
    const cut = wrapText('😀'.repeat(40), 9, 2);
    expect(cut.truncated).toBe(true);
    expect(cut.lines[1]).toMatch(/^(😀)+…$/);
  });
});

describe('wrapText', () => {
  it('wraps at spaces into at most two lines, and says when it had to cut', () => {
    expect(wrapText('One More Time (Daft Punk) / Swoon (Chemical Brothers)', 27)).toEqual({
      lines: ['One More Time (Daft Punk) /', 'Swoon (Chemical Brothers)'],
      hyphenated: [false, false],
      truncated: false,
    });
    const cut = wrapText('One More Time (Daft Punk) / Swoon (Chemical Brothers)', 20);
    expect(cut.truncated).toBe(true);
    expect(cut.lines).toHaveLength(2);
    expect(cut.lines[1].endsWith('…')).toBe(true);
    // A word longer than a line is broken inside it, with a hyphen, never silently.
    expect(wrapText('Supercalifragilistic', 8, 3)).toEqual({
      lines: ['Superca-', 'lifragi-', 'listic'],
      hyphenated: [true, true, false],
      truncated: false,
    });
    // Four lines hold an 80-character title in 24 characters a line.
    const long = 'Here Comes the Hotstepper (Heartical Mix) [feat. Somebody Else and the Rest]';
    expect(wrapText(long, 24, 4).truncated).toBe(false);
  });

  it('finds the fewest characters a line needs for two lines', () => {
    const title = 'One More Time (Daft Punk) / Swoon (Chemical Brothers)';
    const chars = charsToWrap(title);
    expect(wrapText(title, chars).truncated).toBe(false);
    expect(wrapText(title, chars - 1).truncated).toBe(true);
    // A word is never broken to save width.
    expect(charsToWrap('Song')).toBe(4);
    expect(charsToWrap('Supercalifragilistic and more')).toBe(20);
  });
});

describe('placeChips', () => {
  const cards: CardBox[] = [
    { x: 0, y: 0, width: 100, height: 40 },
    { x: 0, y: 70, width: 100, height: 40 },
    { x: 140, y: 0, width: 100, height: 110 },
  ];
  const bounds = { x: 0, y: 0, width: 240, height: 150 };

  it('puts each chip clear of every card and of the other chips, as near its point as it can', () => {
    const chips = placeChips(
      [
        { near: { x: 50, y: 55 }, width: 60, height: 16, priority: 2 },
        { near: { x: 50, y: 55 }, width: 60, height: 16, priority: 1 },
      ],
      cards,
      bounds,
    );
    expect(chips.every((chip) => chip !== null)).toBe(true);
    const shown = chips.filter((chip): chip is CardBox => chip !== null);
    for (const chip of shown) {
      for (const c of cards) expect(boxesMeet(chip, c)).toBe(false);
    }
    expect(boxesMeet(shown[0], shown[1])).toBe(false);
    // The first sits in the band between the two cards it is nearest to.
    expect(shown[0].y).toBeGreaterThanOrEqual(40);
    expect(shown[0].y + shown[0].height).toBeLessThanOrEqual(70);
  });

  it('leaves out a chip with no free place rather than cover a card', () => {
    const full = { x: 0, y: 0, width: 100, height: 100 };
    expect(
      placeChips([{ near: { x: 50, y: 50 }, width: 60, height: 16, priority: 1 }], [full], full),
    ).toEqual([null]);
  });
});

describe('placeChips, its reach', () => {
  it('leaves a chip out rather than put it far from its link', () => {
    // Free room only 200 px from the point.
    const wall = { x: 0, y: 0, width: 300, height: 300 };
    const bounds = { x: 0, y: 0, width: 600, height: 300 };
    expect(
      placeChips(
        [{ near: { x: 150, y: 150 }, width: 40, height: 16, priority: 1 }],
        [wall],
        bounds,
        {
          reach: 100,
        },
      ),
    ).toEqual([null]);
    const far = placeChips(
      [{ near: { x: 150, y: 150 }, width: 40, height: 16, priority: 1 }],
      [wall],
      bounds,
      { reach: 220 },
    )[0];
    expect(far).not.toBeNull();
    expect((far?.x ?? 0) + 20 - 150).toBeLessThanOrEqual(220);
  });
});

describe('routeLinks', () => {
  // A column of cards (the vertical map): a source on top, this track, and cards between.
  const column = new Map<string, CardBox>(
    ['a', 'b', 'c', 'current', 'd'].map((id, i) => [
      id,
      { x: 22, y: i * 70, width: 200, height: 60 },
    ]),
  );
  const links = [
    { source: 'a', target: 'current' },
    { source: 'b', target: 'current' },
    { source: 'c', target: 'current' },
    { source: 'current', target: 'd' },
  ];
  const { routes, right } = routeLinks(links, column, { railRoom: 40 });

  it('keeps every route inside the room beside the column, and says how far right it goes', () => {
    expect(right).toBeLessThanOrEqual(222 + 40);
    for (const route of routes) {
      // A rail route goes no further right than its rail (its middle).
      const xs = [
        ...route.d.matchAll(/[MHQ](-?[\d.]+)/g),
        ...route.d.matchAll(/ (-?[\d.]+),/g),
      ].map((m) => Number(m[1]));
      expect(route.rail).toBe(true);
      expect(route.mid.x).toBeLessThanOrEqual(right);
      expect(Math.max(...xs)).toBeLessThanOrEqual(route.mid.x + 0.01);
    }
  });

  it('fans links that share a stretch out to rails of their own', () => {
    const rails = routes.slice(0, 3).map((route) => route.mid.x);
    expect(new Set(rails).size).toBe(3);
    // The shorter link nearer the cards.
    expect(rails[2]).toBeLessThan(rails[0]);
  });

  it('spreads the ends that meet a card side down its edge: no two arrowheads on one point', () => {
    const ends = routes.slice(0, 3).map((route) => route.end.y);
    expect(new Set(ends).size).toBe(3);
    const current = column.get('current') as CardBox;
    for (const y of ends) {
      expect(y).toBeGreaterThan(current.y);
      expect(y).toBeLessThan(current.y + current.height);
    }
  });

  it('joins cards that stand apart from facing sides', () => {
    const apart = new Map<string, CardBox>([
      ['x', { x: 0, y: 0, width: 100, height: 40 }],
      ['y', { x: 200, y: 100, width: 100, height: 40 }],
    ]);
    const [route] = routeLinks([{ source: 'x', target: 'y' }], apart).routes;
    expect(route.rail).toBe(false);
    expect(route.start).toEqual({ x: 100, y: 20 });
    expect(route.end).toEqual({ x: 200, y: 120 });
  });
});

describe('the undated slots', () => {
  const opts = { orientation: 'horizontal' as const, margin: { left: 16 } };
  const cards: CardInput[] = [
    card('current', 2011, 'current'),
    card('dated-source', 1984, 'sample'),
    // Feeds this track, with no year: before the first year.
    { ...card('undated-source', null, 'sample'), early: true },
    // Feeds the undated source: before too, never after what it feeds.
    { ...card('undated-grandsource', null, 'second-hop'), early: true },
    // Uses this track, with no year: after the last year.
    card('undated-remix', null, 'remix'),
  ];
  const layout = layoutLineage(cards, opts);
  const x = (id: string) => placed(layout, id).x;

  it('puts an undated source before the first year and an undated later track after the last', () => {
    expect(layout.slots.map((slot) => [slot.label, slot.side])).toEqual([
      ['Undated', 'before'],
      ['1984', null],
      ['2011', null],
      ['Undated', 'after'],
    ]);
    expect(x('undated-source')).toBeLessThan(x('dated-source'));
    expect(x('undated-remix')).toBeGreaterThan(x('current'));
  });

  it('never puts a source to the right of the track it feeds', () => {
    const feeds: Array<[string, string]> = [
      ['dated-source', 'current'],
      ['undated-source', 'current'],
      ['undated-grandsource', 'undated-source'],
    ];
    for (const [source, target] of feeds) {
      expect(x(source), `${source} feeds ${target}`).toBeLessThanOrEqual(x(target));
    }
  });
});
