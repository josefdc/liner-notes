import type { Orientation, ViewBreaks } from './lineageLayout';

/**
 * The song-relations map's first view, at its size (zoom 1: its text at 12 px, never smaller):
 * - a map that fits the room is shown whole, centred along its axis;
 * - a larger one starts at its earliest year (the left of the row, the top of the column), so
 *   only later years need panning, with the axis's labels in view;
 * - where the map runs past the view, the layout is given the view's far edges (`viewBreaks`),
 *   so no card straddles them: at rest, each card is wholly in view or wholly out of it.
 * No DOM: the same sizes always give the same view.
 */

/** The map's room on screen: the svg's size, and the band its heading covers at the top. */
export interface ViewRoom {
  width: number;
  height: number;
  inset: number;
}

/** A map's size (map px). */
export interface MapSize {
  width: number;
  height: number;
}

/** The room below the heading (px), never less than 0. */
const roomBelow = (room: ViewRoom) => Math.max(0, room.height - room.inset);

/**
 * Where the first view ends on the map (map px), in each direction the map does not fit; none
 * where it fits. The first view starts at the map's own corner (`firstView`), so the far edges
 * are the room's width and the height below the heading.
 */
export function viewBreaks(
  orientation: Orientation,
  map: MapSize,
  room: ViewRoom,
): ViewBreaks | undefined {
  const below = roomBelow(room);
  const breaks: ViewBreaks =
    orientation === 'horizontal'
      ? {
          ...(map.width > room.width ? { main: room.width } : {}),
          ...(map.height > below ? { cross: below } : {}),
        }
      : map.height > below
        ? { main: below }
        : {};
  return breaks.main === undefined && breaks.cross === undefined ? undefined : breaks;
}

/** True when two sets of breaks are the same (both none, or the same lines). */
export const sameBreaks = (a: ViewBreaks | undefined, b: ViewBreaks | undefined) =>
  a?.main === b?.main && a?.cross === b?.cross;

/**
 * The first view's pan (screen px, zoom 1): along the axis, a map that fits is centred in the
 * room (below the heading, down a column), and a larger one starts at its earliest year; across
 * it, the row starts at its top (its year labels under the heading) and the column at its left.
 */
export function firstView(
  orientation: Orientation,
  map: MapSize,
  room: ViewRoom,
): { x: number; y: number } {
  const below = roomBelow(room);
  if (orientation === 'horizontal') {
    return {
      x: map.width <= room.width ? (room.width - map.width) / 2 : 0,
      y: room.inset,
    };
  }
  return {
    x: 0,
    y: map.height <= below ? room.inset + (below - map.height) / 2 : room.inset,
  };
}
