import { useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import type { Clip } from "../../shared/timeline/schema";
import type { Slide } from "./bodies";
import { cssEasing, cssMilliseconds } from "./math";
import type { Row } from "./math";

/** How far a clip is drawn from where its layout puts it, in pixels. */
export interface Offset {
  x: number;
  y: number;
}

/**
 * Slides clips from where they were drawn, `offsets` away, to where they are. Their boxes, names
 * and outlines move by transform, added to any slide or zoom still running, and `slideBodies`
 * moves their filmstrips and waveforms on the canvas the same way. Reduced motion sets
 * `--duration-edit` to zero, which skips it.
 */
export function slideClips(
  root: HTMLElement,
  offsets: ReadonlyMap<string, Offset>,
  slideBodies: (slides: Slide[]) => void,
) {
  const style = getComputedStyle(root);
  const duration = cssMilliseconds(style.getPropertyValue("--duration-edit"));
  if (!duration) return;
  const easing = style.getPropertyValue("--ease-in-out").trim();
  const ease = cssEasing(easing);
  // Under half a pixel is arithmetic noise from a drag that already held the clip in place.
  const slides = [...offsets].flatMap(([id, { x, y }]) =>
    Math.abs(x) >= 0.5 || Math.abs(y) >= 0.5
      ? [{ id, x, y, duration, ease }]
      : [],
  );
  for (const { id, x, y } of slides) {
    const transform = `translate(${x}px, ${y}px)`;
    const selector = CSS.escape(id);
    for (const element of root.querySelectorAll(
      `[data-clip="${selector}"], [data-clip-label="${selector}"], [data-clip-outline="${selector}"], [data-agent-change="${selector}"], [data-clip-mix="${selector}"]`,
    ))
      element.animate([{ transform }, { transform: "none" }], {
        duration,
        easing,
        composite: "add",
      });
  }
  if (slides.length) slideBodies(slides);
}

/**
 * After any edit, from a key, a drag, an agent, or undo, the clips it moved slide from where they
 * were drawn, so the change reads as motion. A drag that held clips away from their layout leaves
 * those offsets in `held`; a clip the drag already put where the edit puts it does not slide.
 *
 * Call it before the timeline measures its new length. Its layout effect then reads the zoom the
 * clips were drawn at, and a fitted timeline that refits for the new length has the new zoom by
 * the microtask, which still runs before the frame is painted.
 */
export function useClipMotion(
  lanes: RefObject<HTMLElement | null>,
  clips: readonly Clip[],
  rows: readonly Row[],
  ppf: () => number,
  slideBodies: (slides: Slide[]) => void,
  held: RefObject<ReadonlyMap<string, Offset> | null>,
) {
  const previous = useRef<ReadonlyMap<string, Clip>>(new Map());
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = new Map(clips.map((clip) => [clip.id, clip]));
    const hold = held.current;
    held.current = null;
    const root = lanes.current;
    if (!root) return;
    const moved = clips.flatMap((clip) => {
      const old = before.get(clip.id);
      return old &&
        (old.start !== clip.start ||
          old.track !== clip.track ||
          hold?.has(clip.id))
        ? [{ clip, old }]
        : [];
    });
    if (!moved.length) return;
    const top = new Map(rows.map((row) => [row.track.index, row.top]));
    const drawn = ppf();
    queueMicrotask(() => {
      const zoom = ppf();
      slideClips(
        root,
        new Map(
          moved.map(({ clip, old }) => {
            const at = hold?.get(clip.id);
            return [
              clip.id,
              {
                x: old.start * drawn - clip.start * zoom + (at?.x ?? 0),
                y:
                  (top.get(old.track) ?? 0) -
                  (top.get(clip.track) ?? 0) +
                  (at?.y ?? 0),
              },
            ];
          }),
        ),
        slideBodies,
      );
    });
    // Rows and zoom are read when clips change; neither moves a clip by itself.
  }, [clips]);
}
