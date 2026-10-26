// Analyses the API refuses because no live analysis can run here now, as opposed to an analysis
// that failed. The paused-analysis banner and its plain fallback say why with this copy.

/** The analysis errors that mean "no live analysis here now", not "this analysis failed". */
export type LiveUnavailableCode = 'budget_exhausted' | 'live_disabled';

export function isLiveUnavailable(code: string | null | undefined): code is LiveUnavailableCode {
  return code === 'budget_exhausted' || code === 'live_disabled';
}

export const LIVE_UNAVAILABLE_COPY: Record<LiveUnavailableCode, { title: string; text: string }> = {
  budget_exhausted: {
    title: 'Live analysis paused',
    text:
      'The budget for live analysis is spent for now, so no new song is analyzed. ' +
      'Recorded runs can still be shown. Each one is labelled as a recording, ' +
      'not a live analysis.',
  },
  live_disabled: {
    title: 'Live analysis is off here',
    text:
      'This server does not analyze songs live right now: it only replays recorded runs. ' +
      'A recorded track is shown as a recording, not a live analysis.',
  },
};
