import type { PictureBox, PictureHit } from "../../shared/preview";
import { SAFE_INSET, captionInset } from "../../shared/safeZones";

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

/** Lines across the picture, in composition pixels: vertical ones at `x`, horizontal at `y`. */
export interface Lines {
  x: readonly number[];
  y: readonly number[];
}

/**
 * What a dragged clip snaps to: the frame's edges and centre, the safe boxes and caption line
 * while the safe zones show, the thirds while the grid shows, and the edges and centres of the
 * other clips drawn on the picture. Nothing hidden pulls a clip.
 */
export function snapLines(
  frame: { width: number; height: number },
  shown: { safeZones: boolean; grid: boolean },
  others: readonly PictureBox[],
): Lines {
  const share = (extent: number, percents: readonly number[]) =>
    percents.map((percent) => (extent * percent) / 100);
  const insets = shown.safeZones ? Object.values(SAFE_INSET) : [];
  const across = (extent: number) => [
    ...share(extent, [0, 50, 100]),
    ...share(
      extent,
      insets.flatMap((inset) => [inset, 100 - inset]),
    ),
    ...(shown.grid ? [extent / 3, (extent * 2) / 3] : []),
  ];
  return {
    x: [
      ...across(frame.width),
      ...others.flatMap((box) => [
        box.x,
        box.x + box.width / 2,
        box.x + box.width,
      ]),
    ],
    y: [
      ...across(frame.height),
      ...(shown.safeZones
        ? share(frame.height, [100 - captionInset(frame).bottom])
        : []),
      ...others.flatMap((box) => [
        box.y,
        box.y + box.height / 2,
        box.y + box.height,
      ]),
    ],
  };
}

/**
 * Where a drag puts a clip, as a change to its Position in composition pixels. Travel lands on
 * whole pixels, `axis` (Shift) keeps the larger direction only, and within `reach` the box's
 * edges and centre snap to the nearest of `lines`. A snapped offset is exact, so a centred box
 * is centred.
 */
export function dragOffset(
  travel: Point,
  {
    axis,
    box,
    lines,
    reach,
  }: {
    axis: boolean;
    /** The clip's box when the drag began; null leaves snapping out. */
    box: PictureBox | null;
    lines: Lines;
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
    targets: readonly number[],
  ) => {
    if (!free) return { by: 0, guide: null };
    const by = Math.round(distance);
    if (!box || reach <= 0) return { by, guide: null };
    let snap: { gap: number; line: number } | null = null;
    for (const line of targets)
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
    lines.x,
  );
  const y = move(
    travel.y,
    !axis || !wide,
    box?.y ?? 0,
    box?.height ?? 0,
    lines.y,
  );
  return { dx: x.by, dy: y.by, guides: { x: x.guide, y: y.guide } };
}

/**
 * How much a corner handle scales a clip: the pointer's travel from the clip's centre against
 * where it was pressed. Together, both axes take the press direction's share of the travel, so
 * the corner follows the pointer along the diagonal; `free` (Shift) scales each axis alone.
 */
export function cornerScale(press: Point, pointer: Point, free: boolean) {
  if (!free) {
    const along =
      (pointer.x * press.x + pointer.y * press.y) /
      (press.x * press.x + press.y * press.y || 1);
    return { x: along, y: along };
  }
  return {
    x: press.x ? pointer.x / press.x : 1,
    y: press.y ? pointer.y / press.y : 1,
  };
}
