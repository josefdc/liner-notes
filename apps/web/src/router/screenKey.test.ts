import { describe, expect, it } from 'vitest';
import { AppPhase } from '../types';
import { screenKey } from './screenKey';

// The screen error boundary starts afresh when the key changes.
describe('screenKey', () => {
  it('is one key per result on the Dashboard and the Player', () => {
    for (const phase of [AppPhase.DASHBOARD, AppPhase.PLAYER]) {
      expect(screenKey(phase, false, 'track-a')).not.toBe(screenKey(phase, false, 'track-b'));
      expect(screenKey(phase, false, 'track-a')).toBe(screenKey(phase, false, 'track-a'));
    }
    expect(screenKey(AppPhase.DASHBOARD, false, 'track-a')).not.toBe(
      screenKey(AppPhase.PLAYER, false, 'track-a'),
    );
  });

  it('keeps the search screen as it is while a result arrives', () => {
    expect(screenKey(AppPhase.ONBOARDING, false, null)).toBe(
      screenKey(AppPhase.ONBOARDING, false, 'track-a'),
    );
  });

  it('has one key for a link to a track', () => {
    expect(screenKey(AppPhase.PLAYER, true, 'track-a')).toBe(
      screenKey(AppPhase.DASHBOARD, true, null),
    );
  });
});
