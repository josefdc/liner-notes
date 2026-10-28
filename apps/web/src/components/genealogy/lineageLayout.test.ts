import { describe, expect, it } from 'vitest';
import {
  boxesMeet,
  type CardBox,
  type CardInput,
  charsToWrap,
  isSparse,
  LANES,
  type Lane,
  laneOf,
  layoutLineage,
  orientationFor,
  placeChips,
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
    // The xl column at 1440 px is 360 px wide.
    expect(orientationFor(1440, 360)).toBe('vertical');
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

describe('a card’s lane', () => {
  it('is the analysed track’s, the relation its link is drawn as, or a second hop', () => {
    expect(laneOf(true, 'sample')).toBe('current');
    expect(laneOf(false, 'cover')).toBe('cover');
    expect(laneOf(false, null)).toBe('second-hop');
  });
});

describe('the compact row', () => {
  it('stands in for the canvas with two relations or fewer', () => {
    expect(isSparse(0)).toBe(true);
    expect(isSparse(2)).toBe(true);
    expect(isSparse(3)).toBe(false);
  });
});

describe('wrapText', () => {
  it('wraps at spaces into at most two lines, and says when it had to cut', () => {
    expect(wrapText('One More Time (Daft Punk) / Swoon (Chemical Brothers)', 27)).toEqual({
      lines: ['One More Time (Daft Punk) /', 'Swoon (Chemical Brothers)'],
      truncated: false,
    });
    const cut = wrapText('One More Time (Daft Punk) / Swoon (Chemical Brothers)', 20);
    expect(cut.truncated).toBe(true);
    expect(cut.lines).toHaveLength(2);
    expect(cut.lines[1].endsWith('…')).toBe(true);
    expect(wrapText('Supercalifragilistic', 8, 3).lines).toEqual(['Supercal', 'ifragili', 'stic']);
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
