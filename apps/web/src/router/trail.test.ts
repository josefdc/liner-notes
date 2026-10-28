import { describe, expect, it } from 'vitest';
import {
  explore,
  NO_TRAIL,
  shownTrail,
  stepUrl,
  type Trail,
  type TrailStep,
  trailBefore,
  trailFromState,
} from './trail';

const step = (n: number, view: TrailStep['view'] = 'map'): TrailStep => ({
  trackId: `track${n}`.padEnd(22, '0'),
  title: `Track ${n}`,
  artist: n % 2 ? `Artist ${n}` : null,
  view,
});

/** The trail after exploring from tracks 1..n in turn. */
const chain = (n: number, kept?: number) =>
  Array.from({ length: n }, (_, i) => step(i + 1)).reduce<Trail>(
    (trail, from) => explore(trail, from, kept),
    NO_TRAIL,
  );

describe('explore', () => {
  it('adds the track the next one was analysed from, last', () => {
    const one = explore(NO_TRAIL, step(1));
    expect(one).toEqual({ steps: [step(1)], earlier: 0 });
    expect(explore(one, step(2, 'player'))).toEqual({
      steps: [step(1), step(2, 'player')],
      earlier: 0,
    });
    // The trail it was given is left as it was (an entry of the history holds it).
    expect(one.steps).toHaveLength(1);
  });

  it('keeps the last steps up to its cap and counts the ones it drops', () => {
    const trail = chain(7, 3);
    expect(trail.steps).toEqual([step(5), step(6), step(7)]);
    expect(trail.earlier).toBe(4);
  });
});

describe('trailBefore', () => {
  it('gives a step of the breadcrumb the steps before it', () => {
    const trail = chain(3);
    expect(trailBefore(trail, 0)).toEqual(NO_TRAIL);
    expect(trailBefore(trail, 2)).toEqual({ steps: [step(1), step(2)], earlier: 0 });
    expect(trailBefore(chain(5, 3), 1)).toEqual({ steps: [step(3)], earlier: 2 });
  });
});

describe('trailFromState', () => {
  it("restores the trail a history entry's state holds", () => {
    const trail = chain(2);
    // As the browser keeps it: a structured clone.
    expect(trailFromState(structuredClone({ phase: 'MAP', trail }))).toEqual(trail);
  });

  it('reads anything else as no trail', () => {
    const bad = [
      null,
      undefined,
      'trail',
      {},
      { trail: null },
      { trail: { steps: 'x' } },
      { trail: { steps: [{ trackId: '', title: 'x', artist: null, view: 'map' }] } },
      { trail: { steps: [{ trackId: 'a', title: 'x', artist: null, view: 'page' }] } },
      { trail: { steps: [{ trackId: 'a', title: 1, artist: null, view: 'map' }] } },
    ];
    for (const state of bad) expect(trailFromState(state)).toEqual(NO_TRAIL);
    expect(trailFromState({ trail: { steps: [step(1)], earlier: -2 } })).toEqual({
      steps: [step(1)],
      earlier: 0,
    });
  });
});

describe('shownTrail', () => {
  it('names every step of a short trail', () => {
    const shown = shownTrail(chain(2));
    expect(shown.hidden).toBe(0);
    expect(shown.steps.map(({ index }) => index)).toEqual([0, 1]);
  });

  it('names the last ones, the track on screen counted, and says how many it leaves out', () => {
    const shown = shownTrail(chain(9), 5);
    expect(shown.steps.map(({ step }) => step.title)).toEqual([
      'Track 6',
      'Track 7',
      'Track 8',
      'Track 9',
    ]);
    expect(shown.steps[0].index).toBe(5);
    expect(shown.hidden).toBe(5);
    // Dropped ones are counted too.
    expect(shownTrail(chain(9, 6), 5).hidden).toBe(5);
  });
});

describe('stepUrl', () => {
  it('links a step to the view its next track was analysed from', () => {
    expect(stepUrl(step(1))).toBe(`/t/${step(1).trackId}/map?q=Track+1+Artist+1`);
    expect(stepUrl(step(2, 'player'))).toBe(`/t/${step(2).trackId}?q=Track+2`);
  });
});
