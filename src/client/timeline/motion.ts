import { useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import type { Clip } from "../../shared/timeline/schema";
import type { Slide } from "./bodies";
import { cssEasing, cssMilliseconds } from "./math";
import type { Row } from "./math";

/**
 * After any edit, from a key, an agent, or undo, the clips it moved slide from where they were
 * drawn, so the change reads as motion. Their boxes, names and outlines move by transform, added
 * to any slide or zoom still running, and `slideBodies` moves their filmstrips and waveforms on
 * the canvas the same way. Reduced motion sets `--duration-edit` to zero, which skips it.
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
) {
  const previous = useRef<ReadonlyMap<string, Clip>>(new Map());
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = new Map(clips.map((clip) => [clip.id, clip]));
    const root = lanes.current;
    if (!root) return;
    const style = getComputedStyle(root);
    const duration = cssMilliseconds(style.getPropertyValue("--duration-edit"));
    if (!duration) return;
    const moved = clips.flatMap((clip) => {
      const old = before.get(clip.id);
      return old && (old.start !== clip.start || old.track !== clip.track)
        ? [{ clip, old }]
        : [];
    });
    if (!moved.length) return;
    const easing = style.getPropertyValue("--ease-in-out").trim();
    const ease = cssEasing(easing);
    const top = new Map(rows.map((row) => [row.track.index, row.top]));
    const drawn = ppf();
    queueMicrotask(() => {
      const zoom = ppf();
      const slides = moved.map(({ clip, old }) => ({
        id: clip.id,
        x: old.start * drawn - clip.start * zoom,
        y: (top.get(old.track) ?? 0) - (top.get(clip.track) ?? 0),
        duration,
        ease,
      }));
      for (const { id, x, y } of slides) {
        const transform = `translate(${x}px, ${y}px)`;
        const selector = CSS.escape(id);
        for (const element of root.querySelectorAll(
          `[data-clip="${selector}"], [data-clip-label="${selector}"], [data-clip-outline="${selector}"]`,
        ))
          element.animate([{ transform }, { transform: "none" }], {
            duration,
            easing,
            composite: "add",
          });
      }
      slideBodies(slides);
    });
    // Rows and zoom are read when clips change; neither moves a clip by itself.
  }, [clips]);
}
