/** A label's width on screen, from its text and font size (monospace: about 0.6 em a glyph). */
export const labelWidth = (text: string, fontSize: number) => text.length * fontSize * 0.62;

/** A label's height on screen: its line box, ascenders to descenders. */
export const labelHeight = (fontSize: number) => fontSize * 1.3;

/** A box on screen: its centre and size. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A label to place: where it may go, the preferred place first, and how much it matters. */
export interface LabelChoice {
  candidates: readonly Box[];
  priority: number;
  /** What it labels (a relation's chip, a hint), for whoever reads the choice. */
  kind: string;
}

const clearOf = (box: Box, other: Box, gap: number) =>
  Math.abs(box.x - other.x) * 2 >= box.width + other.width + gap * 2 ||
  Math.abs(box.y - other.y) * 2 >= box.height + other.height + gap * 2;

/**
 * Where to put each label: in priority order (then in their own order), each label takes the
 * first of its places that keeps `gap` pixels clear of every label already placed and of the
 * obstacles; failing that, the first clear of the labels only. No label ever sits over another:
 * one with no clear place is left out. Returns the index of the place each label took, or -1.
 */
export function placeLabels(
  labels: readonly LabelChoice[],
  obstacles: readonly Box[] = [],
  gap = 2,
): { at: number[] } {
  const order = labels
    .map((_, i) => i)
    .sort((a, b) => labels[b].priority - labels[a].priority || a - b);
  const placed: Box[] = [];
  const at = labels.map(() => -1);
  for (const i of order) {
    const clearOfLabels = (box: Box) => placed.every((other) => clearOf(box, other, gap));
    const tiers = [
      (box: Box) => clearOfLabels(box) && obstacles.every((other) => clearOf(box, other, 0)),
      clearOfLabels,
    ];
    for (const fits of tiers) {
      const found = labels[i].candidates.findIndex(fits);
      if (found === -1) continue;
      at[i] = found;
      placed.push(labels[i].candidates[found]);
      break;
    }
  }
  return { at };
}
