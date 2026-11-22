import { useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import type { Clip } from "../../shared/timeline/schema";
import type { Slide } from "./bodies";
import { cssEasing, cssMilliseconds } from "./math";
import type { Row } from "./math";
import type { ViewState } from "./view";

/** How far a clip is drawn from where its layout puts it, in pixels. */
export interface Offset {
  x: number;
  y: number;
}

interface SlideTiming {
  at: number;
  duration: number;
  ease: Slide["ease"];
}
interface ClipMotion {
  frame: number;
  elements: Map<
    HTMLElement,
    { slides: (Offset & { timing: SlideTiming })[]; translate: string }
  >;
}
const moving = new WeakMap<HTMLElement, ClipMotion>();
const slideTiming = new WeakMap<
  HTMLElement,
  ReturnType<typeof readSlideTiming>
>();

export function readSlideTiming(style: CSSStyleDeclaration) {
  return {
    duration: cssMilliseconds(style.getPropertyValue("--duration-edit")),
    ease: cssEasing(style.getPropertyValue("--ease-in-out").trim()),
  };
}

/**
 * A shorter move lands at once: it does not read as travel, and in Fit on a long timeline every
 * clip after a ripple moves about that far, each one restyled every frame of the slide. It also
 * covers the arithmetic noise of a drag that already held the clip in place.
 */
const MIN_SLIDE = 4;

/**
 * Slides clips from where they were drawn, `offsets` away, to where they are. Their boxes, names
 * and outlines move by transform, added to any slide or zoom still running, and `slideBodies`
 * moves their filmstrips and waveforms on the canvas the same way. Reduced motion sets
 * `--duration-edit` to zero, which skips it. One callback writes all the translations: starting
 * a Web Animation per clip made Chromium resolve hundreds of keyframe styles on the first edit.
 */
export function slideClips(
  root: HTMLElement,
  offsets: ReadonlyMap<string, Offset>,
  slideBodies: (slides: Slide[]) => void,
) {
  const inlineTiming =
    root.style.getPropertyValue("--duration-edit") ||
    root.style.getPropertyValue("--ease-in-out");
  const { duration, ease } =
    (inlineTiming ? undefined : slideTiming.get(root)) ??
    readSlideTiming(getComputedStyle(root));
  if (!duration) return;
  const slides = [...offsets].flatMap(([id, { x, y }]) =>
    Math.abs(x) >= MIN_SLIDE || Math.abs(y) >= MIN_SLIDE
      ? [{ id, x, y, duration, ease }]
      : [],
  );
  if (!slides.length) return;
  const byId = new Map(slides.map((slide) => [slide.id, slide]));
  const at = Number(document.timeline.currentTime);
  const timing = { at, duration, ease };
  const motion: ClipMotion = moving.get(root) ?? {
    frame: 0,
    elements: new Map(),
  };
  moving.set(root, motion);
  root.toggleAttribute("data-sliding", true);
  for (const element of root.querySelectorAll<HTMLElement>(
    "[data-clip], [data-clip-label], [data-clip-outline], [data-agent-change], [data-clip-mix]",
  )) {
    const { clip, clipLabel, clipOutline, agentChange, clipMix } =
      element.dataset;
    const slide = byId.get(
      clip ?? clipLabel ?? clipOutline ?? agentChange ?? clipMix ?? "",
    );
    if (!slide) continue;
    const held = motion.elements.get(element) ?? {
      slides: [],
      translate: element.style.translate,
    };
    held.slides.push({ x: slide.x, y: slide.y, timing });
    motion.elements.set(element, held);
  }
  cancelAnimationFrame(motion.frame);
  const draw = (now: number) => {
    const remaining = new Map<SlideTiming, number>();
    for (const [element, held] of motion.elements) {
      held.slides = held.slides.filter(
        ({ timing }) => now - timing.at < timing.duration && root.isConnected,
      );
      if (!held.slides.length) {
        element.style.translate = held.translate;
        motion.elements.delete(element);
        continue;
      }
      let x = 0;
      let y = 0;
      for (const slide of held.slides) {
        let left = remaining.get(slide.timing);
        if (left === undefined) {
          const { at, duration, ease } = slide.timing;
          left = 1 - ease(Math.min(1, (now - at) / duration));
          remaining.set(slide.timing, left);
        }
        x += slide.x * left;
        y += slide.y * left;
      }
      // A held trim scales its underlying transform. Match additive transform's order.
      const scale = Number(element.style.getPropertyValue("--k")) || 1;
      element.style.translate = `${x * scale}px ${y}px`;
    }
    if (motion.elements.size) motion.frame = requestAnimationFrame(draw);
    else {
      root.removeAttribute("data-sliding");
      moving.delete(root);
    }
  };
  draw(at);
  slideBodies(slides);
}

/**
 * After any edit, from a key, a drag, an agent, or undo, the clips it moved slide from where they
 * were drawn, so the change reads as motion. A drag that held clips away from their layout leaves
 * those offsets in `held`; a clip the drag already put where the edit puts it does not slide.
 *
 * Only clips whose slide crosses the visible lanes move: each moving clip restyles every frame,
 * and a ripple near the start of a long timeline moves every clip after it.
 *
 * Call it before the timeline measures its new length. A fitted viewport holds this scale until
 * the slide ends. The microtask starts the motion after the edit's layout effects have run.
 */
export function useClipMotion(
  lanes: RefObject<HTMLElement | null>,
  clips: readonly Clip[],
  rows: readonly Row[],
  view: () => ViewState | undefined,
  slideBodies: (slides: Slide[]) => void,
  held: RefObject<ReadonlyMap<string, Offset> | null>,
  initialTiming: ReturnType<typeof readSlideTiming>,
) {
  const previous = useRef<ReadonlyMap<string, Clip>>(new Map());
  useLayoutEffect(() => {
    const root = lanes.current;
    if (!root) return;
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
    // Reading inherited tokens during an edit forces layout between the clip
    // position writes and their animation. The timeline reads them with its sizes.
    const update = () =>
      slideTiming.set(
        root,
        readSlideTiming(getComputedStyle(root.ownerDocument.documentElement)),
      );
    slideTiming.set(root, initialTiming);
    reducedMotion.addEventListener("change", update);
    return () => {
      reducedMotion.removeEventListener("change", update);
      slideTiming.delete(root);
    };
  }, [lanes, initialTiming]);
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
    const drawn = view()?.ppf ?? 0;
    queueMicrotask(() => {
      const shown = view();
      const zoom = shown?.ppf ?? 0;
      const left = shown && zoom ? shown.frames.from * zoom : -Infinity;
      const right = shown && zoom ? shown.frames.to * zoom : Infinity;
      const offsets = new Map<string, Offset>();
      for (const { clip, old } of moved) {
        const at = hold?.get(clip.id);
        const from = old.start * drawn + (at?.x ?? 0);
        const to = clip.start * zoom;
        if (
          Math.min(from, to) > right ||
          Math.max(from, to) + clip.duration * zoom < left
        )
          continue;
        offsets.set(clip.id, {
          x: from - to,
          y:
            (top.get(old.track) ?? 0) -
            (top.get(clip.track) ?? 0) +
            (at?.y ?? 0),
        });
      }
      slideClips(root, offsets, slideBodies);
    });
    // Rows and zoom are read when clips change; neither moves a clip by itself.
  }, [clips]);
}
