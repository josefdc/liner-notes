import { describe, expect, it } from 'vitest';
import reportJson from '../../../../../evals/reports/audio-2026-10-25.json?raw';
import reportText from '../../../../../evals/reports/audio-2026-10-25.md?raw';
import { STYLE_EVAL, styleEvalText } from './styleEval';

// The fingerprint's accuracy note states the style model's hit@1 and hit@5 against Discogs from
// the audio eval report. The page cannot load the report (3.6 MB), so it keeps the counts in a
// constant; these tests fail when the constant and the report disagree.

interface Rate {
  n: number;
  total: number;
}
interface StylesRun {
  suite: string;
  styles: {
    model: string;
    n: number;
    hits: Record<string, { overN: Rate; baselineOverN: Rate }>;
  };
}

const report = JSON.parse(reportJson) as { date: string; runs: StylesRun[] };
const golden = report.runs.find((run) => run.suite === 'golden');

describe('the style accuracy the fingerprint states', () => {
  it("equals the eval report's hit@1 and hit@5 over all n previews", () => {
    expect(STYLE_EVAL.report).toBe(`evals/reports/audio-${report.date}.md`);
    expect(STYLE_EVAL.date).toBe(report.date);
    const styles = golden?.styles;
    expect(styles?.model).toBe(STYLE_EVAL.model);
    expect(styles?.n).toBe(STYLE_EVAL.n);
    expect(styles?.hits['1'].overN).toMatchObject({ n: STYLE_EVAL.n, total: STYLE_EVAL.hitAt1 });
    expect(styles?.hits['5'].overN).toMatchObject({ n: STYLE_EVAL.n, total: STYLE_EVAL.hitAt5 });
    // The label-free constant baseline: the same k styles for every preview.
    expect(styles?.hits['1'].baselineOverN).toMatchObject({
      n: STYLE_EVAL.n,
      total: STYLE_EVAL.baselineAt1,
    });
    expect(styles?.hits['5'].baselineOverN).toMatchObject({
      n: STYLE_EVAL.n,
      total: STYLE_EVAL.baselineAt5,
    });
  });

  it("matches the report's own table", () => {
    const { n, hitAt1, hitAt5, model } = STYLE_EVAL;
    expect(reportText).toContain(
      `### Styles: hit@k against Discogs\n\n\`${model}\`'s styles on ${n} previews`,
    );
    // k | hit@k over n | hit@k over answered | constant baseline over n | ...
    const row = (k: number, hits: number, baseline: number) =>
      new RegExp(`\\n\\| ${k} \\| ${hits}/${n} = [^|]*\\| [^|]*\\| ${baseline}/${n} = `);
    expect(reportText).toMatch(row(1, hitAt1, STYLE_EVAL.baselineAt1));
    expect(reportText).toMatch(row(5, hitAt5, STYLE_EVAL.baselineAt5));
    // The caveat the note repeats: the model may have seen these releases.
    expect(reportText).toContain(
      'The style model was trained on Discogs styles (Discogs-4M, about 3.3 million tracks), ' +
        'possibly of these very releases',
    );
  });

  it('says the counts, the baseline, the sample size, the report and the training caveat', () => {
    const text = styleEvalText(STYLE_EVAL);
    expect(text).toBe(
      "Against each release's Discogs styles, on 31 previews (audio eval report of 2026-10-25): " +
        "the model's strongest style matched for 14 of 31, one of its 5 strongest for 21 of 31 " +
        '(a fixed list of common styles: 3 and 12). ' +
        'The model was trained on Discogs data, which may include these releases.',
    );
    // Counts, never percentages beside the scores.
    expect(text).not.toContain('%');
  });
});
