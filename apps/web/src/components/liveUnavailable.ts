/** The analysis errors that mean "no live analysis here now", not "this analysis failed". */
export type LiveUnavailableCode = 'budget_exhausted' | 'live_disabled';

export function isLiveUnavailable(code: string | null): code is LiveUnavailableCode {
  return code === 'budget_exhausted' || code === 'live_disabled';
}
