import { describe, expect, it } from 'vitest';
import { firstView, sameBreaks, viewBreaks } from './firstView';

const room = { width: 1440, height: 420, inset: 40 };

describe('the first view (#240)', () => {
  it('shows a map that fits whole, centred along its axis, at its top across it', () => {
    const map = { width: 1000, height: 300 };
    expect(viewBreaks('horizontal', map, room)).toBeUndefined();
    expect(firstView('horizontal', map, room)).toEqual({ x: 220, y: 40 });
    // Down a column: centred in the room below the heading.
    const column = { width: 360, height: 200 };
    expect(viewBreaks('vertical', column, { width: 390, height: 600, inset: 100 })).toBeUndefined();
    expect(firstView('vertical', column, { width: 390, height: 600, inset: 100 })).toEqual({
      x: 0,
      y: 250,
    });
  });

  it('starts a wider map at its earliest year, and ends the view at the room’s far edges', () => {
    const map = { width: 4000, height: 300 };
    expect(firstView('horizontal', map, room)).toEqual({ x: 0, y: 40 });
    expect(viewBreaks('horizontal', map, room)).toEqual({ main: 1440 });
    // Taller than the room below the heading too: the view ends there across the lanes.
    expect(viewBreaks('horizontal', { width: 4000, height: 381 }, room)).toEqual({
      main: 1440,
      cross: 380,
    });
    expect(viewBreaks('horizontal', { width: 1200, height: 381 }, room)).toEqual({ cross: 380 });
    expect(viewBreaks('horizontal', { width: 1440, height: 380 }, room)).toBeUndefined();
  });

  it('starts a longer column at its earliest year, the view ending at the room’s bottom', () => {
    const phone = { width: 390, height: 600, inset: 100 };
    const map = { width: 360, height: 1800 };
    expect(firstView('vertical', map, phone)).toEqual({ x: 0, y: 100 });
    expect(viewBreaks('vertical', map, phone)).toEqual({ main: 500 });
  });

  it('tells two sets of breaks apart', () => {
    expect(sameBreaks(undefined, undefined)).toBe(true);
    expect(sameBreaks({ main: 10 }, { main: 10 })).toBe(true);
    expect(sameBreaks({ main: 10 }, { main: 11 })).toBe(false);
    expect(sameBreaks({ main: 10 }, { main: 10, cross: 5 })).toBe(false);
    expect(sameBreaks({ main: 10 }, undefined)).toBe(false);
  });
});
