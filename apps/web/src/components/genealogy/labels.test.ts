import { describe, expect, it } from 'vitest';
import { labelWidth, visibleLabels } from './labels';

const box = (x: number, y: number, priority = 0, text = 'influence') => ({
  x,
  y,
  width: labelWidth(text, 9),
  height: 9,
  priority,
});

describe('visibleLabels', () => {
  it('shows every label when none overlaps', () => {
    expect(visibleLabels([box(0, 0), box(200, 0), box(0, 40)])).toEqual([true, true, true]);
  });

  it('hides the less important of two overlapping labels, then the later one', () => {
    expect(visibleLabels([box(0, 0, 1), box(10, 2, 5)])).toEqual([false, true]);
    expect(visibleLabels([box(0, 0), box(10, 2)])).toEqual([true, false]);
  });

  it('keeps a label hidden by one shown label from hiding others', () => {
    // b overlaps a (shown first) and c; c does not overlap a, so c shows.
    const a = box(0, 0, 3);
    const b = box(40, 0, 2);
    const c = box(85, 0, 1);
    expect(visibleLabels([a, b, c])).toEqual([true, false, true]);
  });
});
