import { describe, expect, it } from 'vitest';
import { type Box, type LabelChoice, labelWidth, placeLabels } from './labels';

const box = (x: number, y: number, text = 'influence'): Box => ({
  x,
  y,
  width: labelWidth(text, 12),
  height: 16,
});
const name = (b: Box, priority: number): LabelChoice => ({
  candidates: [b],
  priority,
  kind: 'name',
});
const chip = (candidates: Box[], priority: number): LabelChoice => ({
  candidates,
  priority,
  kind: 'chip',
});

describe('placeLabels', () => {
  it('places every label where none overlaps', () => {
    expect(
      placeLabels([name(box(0, 0), 1), name(box(200, 0), 1), chip([box(0, 40)], 0)]).at,
    ).toEqual([0, 0, 0]);
  });

  it('leaves out the less important of two names that overlap, then the later one', () => {
    expect(placeLabels([name(box(0, 0), 1), name(box(10, 2), 5)]).at).toEqual([-1, 0]);
    expect(placeLabels([name(box(0, 0), 1), name(box(10, 2), 1)]).at).toEqual([0, -1]);
  });

  it('moves a chip to its next place when the first is taken', () => {
    expect(placeLabels([name(box(0, 0), 2), chip([box(5, 0), box(0, 30)], 1)]).at).toEqual([0, 1]);
  });

  it('prefers a place clear of the obstacles, then one over an obstacle', () => {
    const disc = { x: 0, y: 0, width: 30, height: 30 };
    expect(placeLabels([chip([box(0, 0), box(0, 40)], 1)], [disc]).at).toEqual([1]);
    expect(placeLabels([chip([box(0, 0)], 1)], [disc]).at).toEqual([0]);
  });

  it('never puts a label over another, whatever their kinds: one with no clear place is left out', () => {
    expect(placeLabels([name(box(0, 0), 2), chip([box(5, 0)], 1)]).at).toEqual([0, -1]);
    expect(placeLabels([chip([box(0, 0)], 2), chip([box(5, 0)], 1)]).at).toEqual([0, -1]);
    expect(placeLabels([name(box(0, 0), 2), name(box(5, 0), 1)]).at).toEqual([0, -1]);
  });
});
