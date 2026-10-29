import { describe, expect, it } from 'vitest';
import { firstView, generated } from './generatedMaps';

// The first view on generated maps (#240), planned and laid out as the map does it: at rest each
// card is wholly in the room for cards or wholly out of it (none under an edge cue's button, nor
// under the pinned year labels), and the analysed track's card (`c0`) wholly in it, where it fits.

describe('the first view on generated maps (#240)', () => {
  it.each([
    [2458, 'across: a long title widens the analysed card’s year past the view’s edge'],
    [1870, 'down: a tall card shares the analysed card’s row past the view’s bottom'],
    [9207, 'across, a short room: the line under the room never runs across the analysed card'],
    [19431, 'across, a short room: the analysed card clear of the cues’ buttons'],
    [11547, 'across, a short room'],
    [16314, 'down: the view starts on the cards’ row, a tall card beside the analysed one'],
  ])('keeps the analysed card wholly in view (seed %i: %s)', (seed) => {
    const { cards, options, room } = generated(seed);
    const view = firstView(cards, options, room);
    expect(view.anchorIn).toBe(true);
    expect(view.cut).toEqual([]);
  });

  it.each([
    [2892, 'down, a view that starts inside a year: the year after it is not its first'],
    [838, 'down, a card that starts in the strip at the view’s bottom'],
    [3165, 'across, the top line pushes a card onto the bottom one'],
  ])('cuts no card (seed %i: %s)', (seed) => {
    const { cards, options, room } = generated(seed);
    const view = firstView(cards, options, room);
    expect(view.cut).toEqual([]);
    expect(view.anchorIn).toBe(true);
  });

  it('cuts no card and keeps the analysed one in view on 1500 generated maps', () => {
    // Where the analysed card is too large for any view's room, it is shown in part (it is the
    // map's subject) and the cards beside it may be cut; it is out of view only where the band
    // over the view's top takes the whole room.
    const bad: string[] = [];
    let tooBig = 0;
    for (let seed = 1; seed <= 1500; seed += 1) {
      const { cards, options, room } = generated(seed);
      const view = firstView(cards, options, room);
      const band = (options.axisSize ?? 20) + 6;
      if (view.anchorTooBig) tooBig += 1;
      const excused = view.anchorTooBig && (view.anchorIn || room.height - room.inset <= band);
      if ((view.cut.length > 0 || !view.anchorIn) && !excused) {
        bad.push(`${seed} ${options.orientation} in=${view.anchorIn} ${view.cut.join(' ')}`);
      }
    }
    expect(bad).toEqual([]);
    expect(tooBig).toBeLessThan(150);
  });
});
