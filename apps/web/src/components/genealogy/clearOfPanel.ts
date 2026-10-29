/**
 * How far to pan the map, along one axis, to show the selected card in the room left by the
 * detail panel while keeping the analysed track's card out from under the panel.
 *
 * Everything is in screen px along the axis: `selected` and `other` are a card's start and end
 * now, `room` is where a card is in view and clear of the panel (its padding included), and
 * `band` is the stretch the panel covers (from its near edge to the view's end). The analysed
 * card is clear when it ends before the band or starts past its end (out of view there).
 *
 * Returns the least move that brings the selected card into the room (one taller than the room:
 * its top to the room's top) and, where some move in that range also keeps the other card clear,
 * the one of those nearest to it. With no such move (or no other card), the selected card alone
 * decides.
 */
export function clearOfPanel(
  selected: readonly [number, number],
  room: readonly [number, number],
  other: readonly [number, number] | null,
  band: readonly [number, number],
): number {
  const [s0, s1] = selected;
  // A card taller than the room has its top at the room's top, wherever it is: aligning its
  // bottom instead while its top fits would move it back on the next call.
  const near =
    s0 < room[0] || s1 - s0 > room[1] - room[0] ? room[0] - s0 : s1 > room[1] ? room[1] - s1 : 0;
  if (!other) return near;
  // The moves that keep the selected card in the room.
  const [low, high] = [room[0] - s0, room[1] - s1];
  if (low > high) return near;
  const clear = (move: number) => other[1] + move <= band[0] || other[0] + move >= band[1];
  if (clear(near)) return near;
  const moves = [Math.min(high, band[0] - other[1]), Math.max(low, band[1] - other[0])].filter(
    (move) => move >= low && move <= high && clear(move),
  );
  if (moves.length === 0) return near;
  return moves.sort((a, b) => Math.abs(a - near) - Math.abs(b - near))[0];
}
