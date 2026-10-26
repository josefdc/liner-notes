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
  /** Its kind (a track's name, a line's label): what other labels may cover it. */
  kind: string;
  /**
   * Kinds of placed labels this one may sit over when no place clear of every label is left
   * (it is drawn above them). It never sits over a label of its own kind.
   */
  mayCover?: readonly string[];
  /** False for a label nothing may sit over, whatever its kind. */
  coverable?: boolean;
}

const clearOf = (box: Box, other: Box, gap: number) =>
  Math.abs(box.x - other.x) * 2 >= box.width + other.width + gap * 2 ||
  Math.abs(box.y - other.y) * 2 >= box.height + other.height + gap * 2;

/**
 * Where to put each label: in priority order (then in their own order), each label takes the
 * first of its places that keeps `gap` pixels clear of every label already placed and of the
 * obstacles (the tracks' discs); failing that, the first clear of the labels only; failing that,
 * the first clear of every label but those of the kinds it may cover. Returns the index of the
 * place each label took, or -1 for a label left out, and which labels it covers.
 */
export function placeLabels(
  labels: readonly LabelChoice[],
  obstacles: readonly Box[] = [],
  gap = 2,
): { at: number[]; covers: number[][] } {
  const order = labels
    .map((_, i) => i)
    .sort((a, b) => labels[b].priority - labels[a].priority || a - b);
  const placed: Array<{ box: Box; kind: string; coverable: boolean; index: number }> = [];
  const at = labels.map(() => -1);
  const covers: number[][] = labels.map(() => []);
  for (const i of order) {
    const { candidates, kind, mayCover = [], coverable = true } = labels[i];
    const clearOfLabels = (box: Box, except: readonly string[] = []) =>
      placed.every(
        (other) =>
          (other.coverable && except.includes(other.kind) && other.kind !== kind) ||
          clearOf(box, other.box, gap),
      );
    const tiers = [
      (box: Box) => clearOfLabels(box) && obstacles.every((other) => clearOf(box, other, 0)),
      (box: Box) => clearOfLabels(box),
      (box: Box) => mayCover.length > 0 && clearOfLabels(box, mayCover),
    ];
    for (const fits of tiers) {
      const found = candidates.findIndex(fits);
      if (found === -1) continue;
      const box = candidates[found];
      at[i] = found;
      covers[i] = placed
        .filter((other) => !clearOf(box, other.box, gap))
        .map((other) => other.index);
      placed.push({ box, kind, coverable, index: i });
      break;
    }
  }
  return { at, covers };
}
