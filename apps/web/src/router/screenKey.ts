import { AppPhase } from '../types';

/**
 * Which screen is shown, as a key for the screen's error boundary (App.tsx): a new key starts
 * the boundary afresh. Each result has its own Dashboard and Player key, so Back or Forward to
 * another result does not keep the fallback of one that failed; the search screen keeps one key
 * while a result arrives on it.
 */
export function screenKey(phase: AppPhase, link: boolean, trackId: string | null | undefined) {
  if (link) return 'link';
  if (phase === AppPhase.ONBOARDING) return phase;
  return `${phase}:${trackId ?? ''}`;
}
