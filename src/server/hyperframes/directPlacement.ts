import type { Placement } from "./directSchema.ts";

type Size = { width: number; height: number };
/** A rectangle in the clip box's CSS pixels, from its left and top edges to its right and bottom. */
type Rect = { left: number; top: number; right: number; bottom: number };
type Point = { x: number; y: number };

/** Where `object-fit` draws a picture of this size inside a box filling the frame. */
export function contentRect(
  fit: "contain" | "cover" | "fill",
  picture: Size,
  frame: Size,
): Rect {
  if (fit === "fill")
    return { left: 0, top: 0, right: frame.width, bottom: frame.height };
  const scale = (fit === "contain" ? Math.min : Math.max)(
    frame.width / picture.width,
    frame.height / picture.height,
  );
  const width = picture.width * scale;
  const height = picture.height * scale;
  const left = (frame.width - width) / 2;
  const top = (frame.height - height) / 2;
  return { left, top, right: left + width, bottom: top + height };
}

/** What the browser shows of the picture: inside its box, then inside the inset crop. */
export function visibleRect(
  content: Rect,
  crop: Placement["crop"],
  frame: Size,
) {
  const rect = {
    left: Math.max(content.left, crop.left),
    top: Math.max(content.top, crop.top),
    right: Math.min(content.right, frame.width - crop.right),
    bottom: Math.min(content.bottom, frame.height - crop.bottom),
  };
  return rect.right > rect.left && rect.bottom > rect.top ? rect : null;
}

/**
 * Maps a point in the clip box to the frame. CSS applies `translate`, then `rotate`, then `scale`,
 * each about the box's centre, which is the frame's centre for a box filling it.
 */
export function placeOnFrame(placement: Placement, frame: Size) {
  const angle = (placement.rotation * Math.PI) / 180;
  const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
  const cx = frame.width / 2;
  const cy = frame.height / 2;
  return ({ x, y }: Point): Point => {
    const sx = (x - cx) * placement.scaleX;
    const sy = (y - cy) * placement.scaleY;
    return {
      x: cx + placement.x + sx * cos - sy * sin,
      y: cy + placement.y + sx * sin + sy * cos,
    };
  };
}

/**
 * Whether the placed rectangle hides everything beneath it in every frame pixel. An edge the
 * browser antialiases blends with what lies beneath, so a rotated edge must clear the frame by a
 * pixel and an unrotated one must lie on or outside it.
 */
export function coversFrame(placement: Placement, rect: Rect, frame: Size) {
  if (placement.opacity < 1) return false;
  const place = placeOnFrame(placement, frame);
  const corners = [
    place({ x: rect.left, y: rect.top }),
    place({ x: rect.right, y: rect.top }),
    place({ x: rect.right, y: rect.bottom }),
    place({ x: rect.left, y: rect.bottom }),
  ];
  if (placement.rotation % 360 === 0) {
    const xs = corners.map((corner) => corner.x);
    const ys = corners.map((corner) => corner.y);
    return (
      Math.min(...xs) <= 0 &&
      Math.min(...ys) <= 0 &&
      Math.max(...xs) >= frame.width &&
      Math.max(...ys) >= frame.height
    );
  }
  // Each frame corner must lie a pixel inside every edge of the convex quad.
  const orientation = Math.sign(
    (corners[1]!.x - corners[0]!.x) * (corners[2]!.y - corners[0]!.y) -
      (corners[1]!.y - corners[0]!.y) * (corners[2]!.x - corners[0]!.x),
  );
  return [
    { x: 0, y: 0 },
    { x: frame.width, y: 0 },
    { x: frame.width, y: frame.height },
    { x: 0, y: frame.height },
  ].every((point) =>
    corners.every((from, index) => {
      const to = corners[(index + 1) % 4]!;
      const length = Math.hypot(to.x - from.x, to.y - from.y);
      const cross =
        (to.x - from.x) * (point.y - from.y) -
        (to.y - from.y) * (point.x - from.x);
      return (orientation * cross) / length >= 1;
    }),
  );
}
