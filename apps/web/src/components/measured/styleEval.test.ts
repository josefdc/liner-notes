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
  styles: { model: string; n: number; hits: Record<string, { overN: Rate }> };
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
  });

  it("matches the report's own table", () => {
    const { n, hitAt1, hitAt5, model } = STYLE_EVAL;
    expect(reportText).toContain(
      `### Styles: hit@k against Discogs\n\n\`${model}\`'s styles on ${n} previews`,
    );
    expect(reportText).toMatch(new RegExp(`\\n\\| 1 \\| ${hitAt1}/${n} = `));
    expect(reportText).toMatch(new RegExp(`\\n\\| 5 \\| ${hitAt5}/${n} = `));
  });

  it('says the counts, the sample size and the report in one sentence', () => {
    expect(styleEvalText(STYLE_EVAL)).toBe(
      "Against the release's Discogs styles, on 31 previews (audio eval report of 2026-10-25): " +
        'the top style matched for 14 of 31, a top-5 style for 21 of 31.',
    );
  });
});
