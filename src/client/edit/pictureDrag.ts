import type { PictureBox, PictureHit } from "../../shared/preview";

interface Point {
  x: number;
  y: number;
}

export const contains = (box: PictureBox, { x, y }: Point) =>
  x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height;

/**
 * What a press on the picture acts on: the topmost clip that paints there, unless the selected
 * clip's box lies above it. A title is grabbed anywhere in its box, and something drawn over it
 * is still picked first. `cycle` (Alt) steps to the next clip under the selected one.
 */
export function pickHit(
  hits: readonly PictureHit[],
  selected: string | null,
  cycle: boolean,
): PictureHit | null {
  const targets = hits.filter((hit) => hit.painted || hit.clipId === selected);
  if (!cycle) return targets[0] ?? null;
  const painted = hits.filter((hit) => hit.painted);
  const at = painted.findIndex((hit) => hit.clipId === selected);
  return painted[(at + 1) % painted.length] ?? null;
}

/**
 * Where a drag puts a clip, as a change to its Position in composition pixels. Travel lands on
 * whole pixels, `axis` (Shift) keeps the larger direction only, and within `reach` the box's
 * edges and centre snap to the frame's. A snapped offset is exact, so a centred box is centred.
 */
export function dragOffset(
  travel: Point,
  {
    axis,
    box,
    frame,
    reach,
  }: {
    axis: boolean;
    /** The clip's box when the drag began; null leaves snapping out. */
    box: PictureBox | null;
    frame: { width: number; height: number };
    /** Snap distance in composition pixels; 0 turns snapping off. */
    reach: number;
  },
) {
  const wide = Math.abs(travel.x) >= Math.abs(travel.y);
  const move = (
    distance: number,
    free: boolean,
    start: number,
    length: number,
    extent: number,
  ) => {
    if (!free) return { by: 0, guide: null };
    const by = Math.round(distance);
    if (!box || reach <= 0) return { by, guide: null };
    let snap: { gap: number; line: number } | null = null;
    for (const line of [0, extent / 2, extent])
      for (const edge of [start, start + length / 2, start + length]) {
        const gap = line - (edge + by);
        if (
          Math.abs(gap) <= reach &&
          Math.abs(gap) < Math.abs(snap?.gap ?? Infinity)
        )
          snap = { gap, line };
      }
    return snap
      ? { by: Number((by + snap.gap).toFixed(3)), guide: snap.line }
      : { by, guide: null };
  };
  const x = move(
    travel.x,
    !axis || wide,
    box?.x ?? 0,
    box?.width ?? 0,
    frame.width,
  );
  const y = move(
    travel.y,
    !axis || !wide,
    box?.y ?? 0,
    box?.height ?? 0,
    frame.height,
  );
  return { dx: x.by, dy: y.by, guides: { x: x.guide, y: y.guide } };
}
