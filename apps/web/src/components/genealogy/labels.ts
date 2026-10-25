/** A label's box on screen: its centre, size, and how much it matters (higher shows first). */
export interface LabelBox {
  x: number;
  y: number;
  width: number;
  height: number;
  priority: number;
}

/** A label's width on screen, from its text and font size (monospace: about 0.6 em a glyph). */
export const labelWidth = (text: string, fontSize: number) => text.length * fontSize * 0.62;

/** A label's height on screen: its line box, ascenders to descenders. */
export const labelHeight = (fontSize: number) => fontSize * 1.3;

/**
 * Which labels to show so none overlaps another: in priority order (then in their own order),
 * each label that keeps `gap` pixels clear of every label already shown.
 */
export function visibleLabels(boxes: readonly LabelBox[], gap = 2): boolean[] {
  const order = boxes
    .map((_, i) => i)
    .sort((a, b) => boxes[b].priority - boxes[a].priority || a - b);
  const shown: LabelBox[] = [];
  const visible = boxes.map(() => false);
  for (const i of order) {
    const box = boxes[i];
    const clear = shown.every(
      (other) =>
        Math.abs(box.x - other.x) * 2 >= box.width + other.width + gap * 2 ||
        Math.abs(box.y - other.y) * 2 >= box.height + other.height + gap * 2,
    );
    if (clear) {
      shown.push(box);
      visible[i] = true;
    }
  }
  return visible;
}
