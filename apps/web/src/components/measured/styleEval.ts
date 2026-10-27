// How often the style model's top styles agree with the release's Discogs styles, from the audio
// eval report (its "Styles: hit@k against Discogs" table). Counts over all n previews: a preview
// the service returned no fingerprint for counts as no hit. The page cannot load the report, so
// the counts are kept here; styleEval.test.ts fails when they and the report disagree.

export interface StyleEval {
  /** The report the counts come from, from the repository root. */
  report: string;
  /** The date of the eval run. */
  date: string;
  /** The style model the eval ran. */
  model: string;
  /** Previews whose release has Discogs styles. */
  n: number;
  /** Previews whose top style is one of the release's styles. */
  hitAt1: number;
  /** Previews with one of the release's styles among their top 5. */
  hitAt5: number;
}

export const STYLE_EVAL: StyleEval = {
  report: 'evals/reports/audio-2026-10-25.md',
  date: '2026-10-25',
  model: 'discogs-effnet-bs64-1',
  n: 31,
  hitAt1: 14,
  hitAt5: 21,
};

/** The accuracy note, in one sentence: counts of n, never percentages beside the scores. */
export function styleEvalText({ n, date, hitAt1, hitAt5 }: StyleEval): string {
  return (
    `Against the release's Discogs styles, on ${n} previews (audio eval report of ${date}): ` +
    `the top style matched for ${hitAt1} of ${n}, a top-5 style for ${hitAt5} of ${n}.`
  );
}
