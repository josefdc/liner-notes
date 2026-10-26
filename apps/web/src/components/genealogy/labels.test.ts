import { describe, expect, it } from 'vitest';
import { type Box, type LabelChoice, labelWidth, placeLabels } from './labels';

const box = (x: number, y: number, text = 'influence'): Box => ({
  x,
  y,
  width: labelWidth(text, 12),
  height: 16,
});
const name = (b: Box, priority: number, coverable = true): LabelChoice => ({
  candidates: [b],
  priority,
  kind: 'name',
  coverable,
});
const line = (candidates: Box[], priority: number): LabelChoice => ({
  candidates,
  priority,
  kind: 'line',
  mayCover: ['name'],
});

describe('placeLabels', () => {
  it('places every label where none overlaps', () => {
    expect(
      placeLabels([name(box(0, 0), 1), name(box(200, 0), 1), line([box(0, 40)], 0)]).at,
    ).toEqual([0, 0, 0]);
  });

  it('leaves out the less important of two names that overlap, then the later one', () => {
    expect(placeLabels([name(box(0, 0), 1), name(box(10, 2), 5)]).at).toEqual([-1, 0]);
    expect(placeLabels([name(box(0, 0), 1), name(box(10, 2), 1)]).at).toEqual([0, -1]);
  });

  it('moves a line label to its next place when the first is taken', () => {
    const placed = placeLabels([name(box(0, 0), 2), line([box(5, 0), box(0, 30)], 1)]);
    expect(placed.at).toEqual([0, 1]);
    expect(placed.covers[1]).toEqual([]);
  });

  it('prefers a place clear of the obstacles, then one over an obstacle', () => {
    const disc = { x: 0, y: 0, width: 30, height: 30 };
    expect(placeLabels([line([box(0, 0), box(0, 40)], 1)], [disc]).at).toEqual([1]);
    expect(placeLabels([line([box(0, 0)], 1)], [disc]).at).toEqual([0]);
  });

  it('puts a line label over a name only when no place is clear, and never over another line', () => {
    const placed = placeLabels([name(box(0, 0), 2), line([box(5, 0)], 1)]);
    expect(placed.at).toEqual([0, 0]);
    expect(placed.covers[1]).toEqual([0]);
    expect(placeLabels([line([box(0, 0)], 2), line([box(5, 0)], 1)]).at).toEqual([0, -1]);
  });

  it('never puts a label over one that may not be covered, nor a name over a name', () => {
    expect(placeLabels([name(box(0, 0), 2, false), line([box(5, 0)], 1)]).at).toEqual([0, -1]);
    const nameOverName = { ...name(box(5, 0), 1), mayCover: ['name'] };
    expect(placeLabels([name(box(0, 0), 2), nameOverName]).at).toEqual([0, -1]);
  });
});
