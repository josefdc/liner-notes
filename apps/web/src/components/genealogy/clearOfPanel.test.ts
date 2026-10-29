import { describe, expect, it } from 'vitest';
import { clearOfPanel } from './clearOfPanel';

// A view 0-600 px down, the panel over 400-600, so a card is clear in 20-388 (padding 12).
const room = [20, 388] as const;
const band = [400, 600] as const;

describe('clearOfPanel', () => {
  it('leaves the view where both cards are clear', () => {
    expect(clearOfPanel([100, 160], room, [200, 260], band)).toBe(0);
  });

  it('brings the selected card up out from under the panel', () => {
    expect(clearOfPanel([450, 510], room, null, band)).toBe(388 - 510);
  });

  it('keeps the analysed card clear too, where a move allows both', () => {
    // The selected card is in the room, the analysed one under the panel: moving up 150 px
    // brings the analysed card above the panel and keeps the selected one in view.
    const move = clearOfPanel([250, 310], room, [420, 480], band);
    expect(move).toBe(400 - 480);
    expect(250 + move).toBeGreaterThanOrEqual(room[0]);
  });

  it('pushes the analysed card past the view when it cannot sit above the panel', () => {
    // No move keeps both cards in the room: the analysed card goes below the view, not under the
    // panel.
    const move = clearOfPanel([100, 160], room, [560, 620], band);
    expect(560 + move).toBeGreaterThanOrEqual(600);
    expect(160 + move).toBeLessThanOrEqual(room[1]);
  });

  it('lets the selected card decide when no move clears both', () => {
    expect(clearOfPanel([30, 380], room, [420, 480], band)).toBe(0);
  });

  it('puts the top of a card taller than the room at its top, and then leaves it there', () => {
    // A card of 400 px in a room of 368: its top in the room, below it, or above it.
    for (const at of [100, 20, -50]) {
      for (const other of [null, [420, 480] as const]) {
        const move = clearOfPanel([at, at + 400], room, other, band);
        expect(at + move).toBe(room[0]);
        // Placed again where it is (the panel moved by a cue): it stays.
        expect(clearOfPanel([at + move, at + move + 400], room, other, band)).toBe(0);
      }
    }
  });
});
